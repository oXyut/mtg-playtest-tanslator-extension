/**
 * 日本の店舗価格の取得ロジック(background service workerから呼ばれる)。
 * - 晴れる屋: サイト内検索API(unisearch_api)から在庫あり・非foil・NMの最安値
 * - Wisdom Guild: 価格集約ページのサマリー(最安/トリム平均)と店舗別価格表
 *   (参加店: カードラッシュ・トレトク・Cardshop Serra等。晴れる屋は不参加)
 */

/** 価格源の設定値: 晴れる屋 / 店舗問わず最安 / Wisdom Guild参加店("wg:店名") */
export type PriceStore = 'hareruya' | 'lowest' | `wg:${string}`;

export interface JpPrice {
  /** 代表価格(円)。取得できなければ null */
  value: number | null;
  /** 価格源の表示名(例: 晴れる屋 / カードラッシュ / Wisdom Guild平均) */
  sourceLabel: string | null;
  /** トリム平均による近似値か(アスタリスク表示の対象) */
  approximate: boolean;
  /** リンク先: true=晴れる屋の商品検索 / false=Wisdom Guildのカードページ */
  linkHareruya: boolean;
}

const NO_PRICE: JpPrice = {
  value: null,
  sourceLabel: null,
  approximate: false,
  linkHareruya: false,
};

interface HareruyaDoc {
  product_name?: string;
  card_name?: string;
  price?: string;
  stock?: string;
  foil_flg?: string;
  card_condition?: string;
}

/** 両面カード等はWisdom Guild・晴れる屋とも表面名で引く */
export function frontFaceName(name: string): string {
  return name.split(' // ')[0].trim();
}

export async function fetchHareruyaLowest(
  cardName: string,
): Promise<number | null> {
  const name = frontFaceName(cardName);
  const url =
    'https://www.hareruyamtg.com/ja/products/search/unisearch_api?rows=100&kw=' +
    encodeURIComponent(name);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Hareruya ${res.status}`);
  const json = (await res.json()) as {
    response?: { docs?: HareruyaDoc[] };
  };
  const docs = json.response?.docs ?? [];
  const lower = name.toLowerCase();

  let best: number | null = null;
  for (const doc of docs) {
    if ((doc.card_name ?? '').toLowerCase() !== lower) continue;
    if (doc.foil_flg !== '0') continue;
    if (doc.card_condition !== '1') continue; // 1 = NM
    if (!(parseInt(doc.stock ?? '0', 10) > 0)) continue;
    // 商品名の先頭の《...》ブロックに検索名が含まれること。
    // card_name は面の名前なので、分割カード等の「裏面だけ一致する別カード」を除外する
    const block = /《([^》]*)》/.exec(doc.product_name ?? '')?.[1] ?? '';
    if (!block.toLowerCase().includes(lower)) continue;

    const price = parseInt(doc.price ?? '', 10);
    if (Number.isFinite(price) && (best === null || price < best)) {
      best = price;
    }
  }
  return best;
}

interface WgRow {
  store: string;
  price: number;
  foil: boolean;
  inStock: boolean;
  condition: string;
}

interface WgResult {
  low: number | null;
  trim: number | null;
  rows: WgRow[];
}

export async function fetchWisdomGuild(
  cardName: string,
  opts?: { inStock?: boolean; page?: number },
): Promise<WgResult> {
  const name = frontFaceName(cardName);
  const params = new URLSearchParams();
  if (opts?.inStock) params.set('stock_gt', '1');
  if (opts?.page !== undefined && opts.page > 1)
    params.set('page', String(opts.page));
  const query = params.size > 0 ? `?${params.toString()}` : '';
  const url =
    'https://wonder.wisdom-guild.net/price/' +
    encodeURIComponent(name) +
    '/' +
    query;
  const res = await fetch(url);
  if (!res.ok) return { low: null, trim: null, rows: [] };
  const html = await res.text();

  const parseNum = (re: RegExp): number | null => {
    const m = re.exec(html)?.[1];
    if (m === undefined) return null;
    const n = parseInt(m.replaceAll(',', ''), 10);
    return Number.isFinite(n) ? n : null;
  };

  const rows: WgRow[] = [];
  const rowRe =
    /shop\/\d+\/"[^>]*>([^<]+)<\/a><\/td><td class="right"><strong>([\d,]+)<\/strong> 円<\/td>([\s\S]*?)<\/tr>/g;
  for (const m of html.matchAll(rowRe)) {
    const rest = m[3];
    rows.push({
      store: m[1].trim(),
      price: parseInt(m[2].replaceAll(',', ''), 10),
      foil: rest.includes('title="FOIL"'),
      inStock: !rest.includes('nostock'),
      condition:
        />\s*(NM[+-]?|EX[+-]?|VG|GD|PL|SP|MP|HP|DMG)\s*</.exec(rest)?.[1] ?? '',
    });
  }

  return {
    low: parseNum(/最安：<b>([\d,]+)<\/b> 円/),
    trim: parseNum(/トリム平均：<b>([\d,]+)<\/b> 円/),
    rows,
  };
}

/** WG店舗別価格表から、指定店の在庫あり・非foilの最安を取る */
function wgStoreLowest(
  rows: WgRow[],
  store: string,
): { price: number; condition: string } | null {
  let best: { price: number; condition: string } | null = null;
  for (const row of rows) {
    if (row.store !== store) continue;
    if (row.foil || !row.inStock) continue;
    if (best === null || row.price < best.price) {
      best = { price: row.price, condition: row.condition };
    }
  }
  return best;
}

function wgTrimFallback(wg: WgResult): JpPrice {
  if (wg.trim === null && wg.low === null) return NO_PRICE;
  return {
    value: wg.trim ?? wg.low,
    sourceLabel: 'Wisdom Guild トリム平均',
    approximate: true,
    linkHareruya: false,
  };
}

/**
 * 設定された価格源に応じた代表価格の取得。
 * - hareruya: 晴れる屋の最安。在庫なしはWGトリム平均で近似
 * - lowest:   晴れる屋とWG掲載店(在庫あり最安)の安い方
 * - wg:店名:  その店のNM・非foil・在庫あり最安。無ければWGトリム平均で近似
 */
export async function fetchJpPrice(
  cardName: string,
  store: PriceStore,
): Promise<JpPrice> {
  if (store === 'hareruya') {
    let hareruya: number | null = null;
    try {
      hareruya = await fetchHareruyaLowest(cardName);
    } catch {
      hareruya = null;
    }
    if (hareruya !== null) {
      return {
        value: hareruya,
        sourceLabel: '晴れる屋 最安 (NM・非foil)',
        approximate: false,
        linkHareruya: true,
      };
    }
    try {
      return wgTrimFallback(await fetchWisdomGuild(cardName));
    } catch {
      return NO_PRICE;
    }
  }

  if (store === 'lowest') {
    let hareruya: number | null = null;
    let wg: WgResult = { low: null, trim: null, rows: [] };
    try {
      hareruya = await fetchHareruyaLowest(cardName);
    } catch {
      hareruya = null;
    }
    try {
      wg = await fetchWisdomGuild(cardName);
    } catch {
      /* WGなしでも晴れる屋だけで続行 */
    }
    const candidates: Array<{ value: number; label: string; hr: boolean }> = [];
    if (hareruya !== null)
      candidates.push({ value: hareruya, label: '晴れる屋', hr: true });
    if (wg.low !== null)
      candidates.push({ value: wg.low, label: 'Wisdom Guild掲載店', hr: false });
    if (candidates.length === 0) return wgTrimFallback(wg);
    const best = candidates.reduce((a, b) => (b.value < a.value ? b : a));
    return {
      value: best.value,
      sourceLabel: `店舗最安: ${best.label}`,
      approximate: false,
      linkHareruya: best.hr,
    };
  }

  // wg:店名 — 在庫ありの一覧(価格昇順)を最大4ページ見て、その店の非foil最安を探す。
  // 安い人気カードほど他店の出品で先頭ページが埋まるため深めに見る(見つかり次第打ち切り)
  const MAX_WG_PAGES = 4;
  const storeName = store.slice(3);
  try {
    let first: WgResult | null = null;
    for (let page = 1; page <= MAX_WG_PAGES; page++) {
      const wg = await fetchWisdomGuild(cardName, { inStock: true, page });
      first ??= wg;
      const hit = wgStoreLowest(wg.rows, storeName);
      if (hit !== null) {
        return {
          value: hit.price,
          sourceLabel: `${storeName} 最安 (${hit.condition || '状態不明'}・非foil)`,
          approximate: false,
          linkHareruya: false,
        };
      }
      if (wg.rows.length < 20) break; // 最終ページ
    }
    return first !== null ? wgTrimFallback(first) : NO_PRICE;
  } catch {
    return NO_PRICE;
  }
}
