/**
 * 日本の店舗価格の取得ロジック(background service workerから呼ばれる)。
 * - 晴れる屋: サイト内検索API(unisearch_api)から在庫あり・非foil・NMの最安値
 * - Wisdom Guild: 価格集約ページから最安とトリム平均(晴れる屋に在庫が無いときのフォールバック)
 */

export interface JpPrice {
  /** 晴れる屋の在庫あり・非foil・NM・完全一致の最安(円)。在庫なしは null */
  hareruya: number | null;
  /** Wisdom Guild 最安(円) */
  wgLow: number | null;
  /** Wisdom Guild トリム平均(円) */
  wgTrim: number | null;
}

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

export async function fetchWisdomGuild(
  cardName: string,
): Promise<{ low: number | null; trim: number | null }> {
  const name = frontFaceName(cardName);
  const url =
    'https://wonder.wisdom-guild.net/price/' + encodeURIComponent(name) + '/';
  const res = await fetch(url);
  if (!res.ok) return { low: null, trim: null };
  const html = await res.text();
  const parse = (re: RegExp): number | null => {
    const m = re.exec(html)?.[1];
    if (m === undefined) return null;
    const n = parseInt(m.replaceAll(',', ''), 10);
    return Number.isFinite(n) ? n : null;
  };
  return {
    low: parse(/最安：<b>([\d,]+)<\/b> 円/),
    trim: parse(/トリム平均：<b>([\d,]+)<\/b> 円/),
  };
}

/**
 * 代表価格の取得: 晴れる屋に在庫があればそれを使い、
 * 無いときだけWisdom Guildに問い合わせる(店舗サイトへのリクエスト削減)。
 */
export async function fetchJpPrice(cardName: string): Promise<JpPrice> {
  let hareruya: number | null = null;
  try {
    hareruya = await fetchHareruyaLowest(cardName);
  } catch {
    hareruya = null;
  }
  if (hareruya !== null) return { hareruya, wgLow: null, wgTrim: null };

  try {
    const wg = await fetchWisdomGuild(cardName);
    return { hareruya: null, wgLow: wg.low, wgTrim: wg.trim };
  } catch {
    return { hareruya: null, wgLow: null, wgTrim: null };
  }
}
