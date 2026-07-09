import { getCached, setCached, type JpLookupResult } from './cache';
import { lookupQueued, lookupSettled } from './progress';

/**
 * imgが指すカードの識別子。
 * - scryfallId: 印刷(printing)のScryfall UUID。ここからoracle_id経由で日本語版を探す
 * - name: カードの英語名。完全一致で日本語版printingを探す
 */
export type CardRef =
  | { kind: 'scryfallId'; id: string }
  | { kind: 'name'; name: string };

const API = 'https://api.scryfall.com';
/** Scryfallのレート制限(50-100ms間隔の推奨)に合わせたリクエスト間隔 */
const REQUEST_INTERVAL_MS = 100;

interface ScryfallImageUris {
  normal: string;
}

interface ScryfallCardFace {
  name: string;
  printed_name?: string;
  printed_text?: string;
  illustration_id?: string;
  image_uris?: ScryfallImageUris;
}

interface ScryfallCard {
  id: string;
  name: string;
  lang: string;
  set?: string;
  oracle_id?: string;
  image_status: string;
  printed_name?: string;
  printed_text?: string;
  illustration_id?: string;
  image_uris?: ScryfallImageUris;
  card_faces?: ScryfallCardFace[];
}

/** 英語版の元printingに寄せるための選好情報 */
interface PrintingPreference {
  illustrationId?: string;
  set?: string;
}

function illustrationIds(card: ScryfallCard): string[] {
  return [
    card.illustration_id,
    ...(card.card_faces ?? []).map((f) => f.illustration_id),
  ].filter((x): x is string => x !== undefined);
}

const CJK = /[぀-ヿ㐀-䶿一-鿿]/;

/**
 * lang:ja のprintingでも実際の印刷は変種によって差がある:
 * - 通常版: カード名もテキストも日本語
 * - 特殊枠(FF系ボーダーレス等): カード名は英語のままテキストのみ日本語
 * - まれにScryfall上lang:jaでも印刷データが英語のみのものがある
 */
function hasJapaneseText(card: ScryfallCard): boolean {
  const texts = [
    card.printed_name,
    card.printed_text,
    ...(card.card_faces ?? []).flatMap((f) => [f.printed_name, f.printed_text]),
  ];
  return texts.some((t) => t !== undefined && CJK.test(t));
}

/** カード名まで日本語で印刷されているか(通常の日本語版) */
function hasJapaneseName(card: ScryfallCard): boolean {
  const names = [
    card.printed_name,
    ...(card.card_faces ?? []).map((f) => f.printed_name),
  ];
  return names.some((t) => t !== undefined && CJK.test(t));
}

interface ScryfallList {
  data?: ScryfallCard[];
}

let queueTail: Promise<unknown> = Promise.resolve();

/** 全リクエストを1本の直列キューに載せ、REQUEST_INTERVAL_MSの間隔を保証する */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = queueTail.then(fn);
  queueTail = result
    .catch(() => {})
    .then(() => new Promise((r) => setTimeout(r, REQUEST_INTERVAL_MS)));
  return result;
}

/** 進行中の同一カードのリクエストをまとめる */
const inflight = new Map<string, Promise<JpLookupResult>>();

function cacheKey(ref: CardRef): string {
  return ref.kind === 'scryfallId'
    ? `sid:${ref.id}`
    : `name:${ref.name.toLowerCase()}`;
}

/**
 * カードの日本語版printingの画像URLを引く。
 * - 日本語版が存在しない場合は null(キャッシュされる)
 * - ネットワーク/レート制限エラー時は undefined(キャッシュせず次回再試行)
 */
export async function lookupJapaneseImages(
  ref: CardRef,
): Promise<JpLookupResult | undefined> {
  const key = cacheKey(ref);

  const cached = await getCached(key);
  if (cached !== undefined) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  lookupQueued();
  const promise = (async () => {
    const result =
      ref.kind === 'scryfallId'
        ? await lookupByScryfallId(ref.id)
        : await enqueue(() => searchJapanesePrinting(`!"${ref.name}"`, ref.name));
    return result;
  })();

  inflight.set(key, promise);
  try {
    const result = await promise;
    await setCached(key, result);
    return result;
  } catch {
    return undefined;
  } finally {
    inflight.delete(key);
    lookupSettled();
  }
}

async function lookupByScryfallId(id: string): Promise<JpLookupResult> {
  const card = await resolvePrinting(id);
  if (!card) return null;

  // 元々日本語(の文字で印刷された)printingが選ばれているならそのまま使う
  if (card.lang === 'ja' && hasJapaneseText(card)) return extractImages(card);
  if (!card.oracle_id) return null;

  // 元の英語版と同じ絵柄・同じセットの日本語版を優先する
  const prefer: PrintingPreference = {
    illustrationId: illustrationIds(card)[0],
    set: card.set,
  };
  return enqueue(() =>
    searchJapanesePrinting(`oracleid:${card.oracle_id}`, undefined, prefer),
  );
}

/** /cards/collection は1リクエストで75件まで解決できる */
const COLLECTION_BATCH_MAX = 75;
/** 同時に発生した解決要求をまとめる待ち時間 */
const BATCH_WINDOW_MS = 50;

interface PendingResolve {
  id: string;
  resolve: (card: ScryfallCard | null) => void;
  reject: (error: unknown) => void;
}

let batchQueue: PendingResolve[] = [];
let batchTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 印刷のScryfall IDからカード情報を引く。
 * 1件ずつ GET /cards/{id} する代わりに、短い時間窓でまとめて
 * POST /cards/collection に載せることで、デッキ初回読み込みの
 * リクエスト数をほぼ半減させる。
 */
function resolvePrinting(id: string): Promise<ScryfallCard | null> {
  return new Promise((resolve, reject) => {
    batchQueue.push({ id, resolve, reject });
    if (batchQueue.length >= COLLECTION_BATCH_MAX) {
      flushBatch();
    } else if (batchTimer === undefined) {
      batchTimer = setTimeout(flushBatch, BATCH_WINDOW_MS);
    }
  });
}

function flushBatch(): void {
  if (batchTimer !== undefined) {
    clearTimeout(batchTimer);
    batchTimer = undefined;
  }
  while (batchQueue.length > 0) {
    const items = batchQueue.splice(0, COLLECTION_BATCH_MAX);
    void enqueue(() => fetchCollection(items));
  }
}

async function fetchCollection(items: PendingResolve[]): Promise<void> {
  try {
    const res = await fetch(`${API}/cards/collection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers: items.map((i) => ({ id: i.id })) }),
    });
    if (!res.ok) throw new Error(`Scryfall ${res.status}`);
    const json = (await res.json()) as { data?: ScryfallCard[] };
    const byId = new Map((json.data ?? []).map((c) => [c.id, c]));
    // not_found に落ちたIDは null(=日本語版なし扱いで英語のまま)
    for (const item of items) item.resolve(byId.get(item.id) ?? null);
  } catch (error) {
    for (const item of items) item.reject(error);
  }
}

/**
 * 日本語版printingを検索して画像URLを返す。
 * exactName指定時は、片面の名前だけが一致する別カード(分割カード等)を除外する。
 */
async function searchJapanesePrinting(
  baseQuery: string,
  exactName?: string,
  prefer?: PrintingPreference,
): Promise<JpLookupResult> {
  const query = `${baseQuery} lang:ja game:paper`;
  const url =
    `${API}/cards/search?unique=prints&order=released&dir=desc&q=` +
    encodeURIComponent(query);
  const res = await fetch(url);

  // 404 = 日本語版printingなし
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Scryfall ${res.status}`);

  const list = (await res.json()) as ScryfallList;
  let candidates = list.data ?? [];
  if (exactName) {
    const lower = exactName.toLowerCase();
    candidates = candidates.filter((c) => {
      const full = c.name.toLowerCase();
      return full === lower || full.split(' // ')[0] === lower;
    });
  }
  // 実際に日本語で印刷されたものに限定し、
  // その中でもカード名まで日本語の通常版を最優先する
  candidates = candidates.filter(hasJapaneseText);
  if (candidates.length === 0) return null;
  const fullyJapanese = candidates.filter(hasJapaneseName);
  const pool = fullyJapanese.length > 0 ? fullyJapanese : candidates;

  // 同じ絵柄 > 同じセット > 高解像度 の順で元の英語版に寄せる。
  // 同点は検索順(リリース日の新しい順)で先のものを採用
  const score = (c: ScryfallCard): number => {
    let s = 0;
    if (
      prefer?.illustrationId !== undefined &&
      illustrationIds(c).includes(prefer.illustrationId)
    ) {
      s += 4;
    }
    if (prefer?.set !== undefined && c.set === prefer.set) s += 2;
    if (c.image_status === 'highres_scan') s += 1;
    return s;
  };
  const best = pool.reduce((a, b) => (score(b) > score(a) ? b : a));
  return extractImages(best);
}

function extractImages(card: ScryfallCard): JpLookupResult {
  const jaNameRaw = card.printed_name ?? card.card_faces?.[0]?.printed_name;
  const jaName = jaNameRaw !== undefined && CJK.test(jaNameRaw) ? jaNameRaw : undefined;
  if (card.image_uris) return { front: card.image_uris.normal, jaName };
  const faces = card.card_faces ?? [];
  const front = faces[0]?.image_uris?.normal;
  if (!front) return null;
  return { front, back: faces[1]?.image_uris?.normal, jaName };
}
