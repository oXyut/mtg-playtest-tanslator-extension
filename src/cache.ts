import { browser } from 'wxt/browser';

/** 日本語版カード画像のURL。両面カードは back を持つ。 */
export interface JpImages {
  front: string;
  back?: string;
  /** 日本語の印刷名(取れた場合のみ) */
  jaName?: string;
}

/** null = 日本語版が存在しない(これもキャッシュして再問い合わせを防ぐ) */
export type JpLookupResult = JpImages | null;

interface CacheEntry {
  v: JpLookupResult;
  t: number;
}

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const KEY_PREFIX = 'jp:';

const memCache = new Map<string, JpLookupResult>();

export async function getCached(
  key: string,
): Promise<JpLookupResult | undefined> {
  if (memCache.has(key)) return memCache.get(key);
  const storageKey = KEY_PREFIX + key;
  const stored = await browser.storage.local.get(storageKey);
  const entry = stored[storageKey] as CacheEntry | undefined;
  if (!entry || Date.now() - entry.t > TTL_MS) return undefined;
  memCache.set(key, entry.v);
  return entry.v;
}

export async function setCached(
  key: string,
  value: JpLookupResult,
): Promise<void> {
  memCache.set(key, value);
  const entry: CacheEntry = { v: value, t: Date.now() };
  await browser.storage.local.set({ [KEY_PREFIX + key]: entry });
}

export async function clearCache(): Promise<void> {
  memCache.clear();
  const all = await browser.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(KEY_PREFIX));
  if (keys.length > 0) await browser.storage.local.remove(keys);
}
