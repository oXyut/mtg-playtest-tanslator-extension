import { browser } from 'wxt/browser';
import { fetchJpPrice, type JpPrice, type PriceStore } from '../src/prices';

/**
 * 店舗サイトへの問い合わせはbackgroundに集約する:
 * - content scriptからはCORSで直接fetchできない(拡張のホスト権限で回避)
 * - 直列キュー+キャッシュで店舗サイトへのリクエストを最小化する
 */
const TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_INTERVAL_MS = 200;

let queueTail: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = queueTail.then(fn);
  queueTail = result
    .catch(() => {})
    .then(() => new Promise((r) => setTimeout(r, REQUEST_INTERVAL_MS)));
  return result;
}

const inflight = new Map<string, Promise<JpPrice>>();

interface CacheEntry {
  v: JpPrice;
  t: number;
}

async function getJpPrice(name: string, store: PriceStore): Promise<JpPrice> {
  const key = `price:${store}:${name.toLowerCase()}`;
  const stored = await browser.storage.local.get(key);
  const entry = stored[key] as CacheEntry | undefined;
  if (entry && Date.now() - entry.t < TTL_MS) return entry.v;

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = enqueue(() => fetchJpPrice(name, store));
  inflight.set(key, promise);
  try {
    const value = await promise;
    await browser.storage.local.set({ [key]: { v: value, t: Date.now() } });
    return value;
  } finally {
    inflight.delete(key);
  }
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown) => {
    const msg = message as { type?: string; name?: string; store?: string };
    if (msg?.type === 'jp-price' && typeof msg.name === 'string') {
      const store =
        msg.store === 'lowest' || msg.store?.startsWith('wg:')
          ? (msg.store as PriceStore)
          : 'hareruya';
      return getJpPrice(msg.name, store);
    }
    return undefined;
  });
});
