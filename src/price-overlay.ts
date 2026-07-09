import { browser } from 'wxt/browser';
import type { JpPrice } from './prices';
import type { SiteAdapter } from './swapper';

/**
 * ページ上のドル価格表示を日本の店舗価格(円)に置き換え、
 * デッキ合計金額の円建てバッジを表示する。
 * 価格の取得自体はbackground service worker(entrypoints/background.ts)が行う。
 */

/** "$10.99 / $12.99" のようなペア表示のコンテナ */
const PAIR_RE = /^\$[\d,]+(?:\.\d+)?\s*\/\s*\$[\d,]+(?:\.\d+)?$/;
/** "$10.99" 単体の葉要素 */
const SINGLE_RE = /^\$[\d,]+(?:\.\d+)?$/;
/** 価格要素からカード画像を探すときに遡る最大の階層 */
const MAX_ANCESTOR_DEPTH = 6;
/** コンテナ内のimgがこれより多い場合は「どのカードの価格か」を特定できないとみなす */
const MAX_IMGS_IN_CONTAINER = 12;

function fmt(yen: number): string {
  return '¥' + yen.toLocaleString('ja-JP');
}

function requestPrice(name: string): Promise<JpPrice> {
  return browser.runtime.sendMessage({
    type: 'jp-price',
    name,
  }) as Promise<JpPrice>;
}

/** 代表価格: 晴れる屋最安 > WGトリム平均 > WG最安 */
function representative(p: JpPrice): number | null {
  return p.hareruya ?? p.wgTrim ?? p.wgLow;
}

function displayOf(p: JpPrice): { text: string; title: string } | null {
  if (p.hareruya !== null) {
    return {
      text: fmt(p.hareruya),
      title: `晴れる屋 最安 (NM・非foil): ${fmt(p.hareruya)}`,
    };
  }
  const value = p.wgTrim ?? p.wgLow;
  if (value !== null) {
    return {
      text: fmt(value) + '*',
      title:
        `Wisdom Guild トリム平均: ${p.wgTrim !== null ? fmt(p.wgTrim) : '—'}` +
        ` / 最安: ${p.wgLow !== null ? fmt(p.wgLow) : '—'} (晴れる屋在庫なし)`,
    };
  }
  return null;
}

export function startPriceOverlay(
  adapter: SiteAdapter,
  isEnabled: () => boolean,
): void {
  if (!adapter.getCardName) return;
  const getCardName = adapter.getCardName.bind(adapter);

  /** 価格要素の近くのカード画像からカード名を特定する */
  async function findCardName(el: Element): Promise<string | null> {
    let node: Element | null = el.parentElement;
    for (let depth = 0; node && depth < MAX_ANCESTOR_DEPTH; depth++) {
      const imgs = node.querySelectorAll('img');
      if (imgs.length > MAX_IMGS_IN_CONTAINER) return null;
      for (const img of imgs) {
        const name = await getCardName(img);
        if (name) return name;
      }
      node = node.parentElement;
    }
    return null;
  }

  const processing = new WeakSet<Element>();

  async function processEl(el: HTMLElement): Promise<void> {
    if (processing.has(el)) return;
    processing.add(el);
    try {
      const original = el.textContent?.trim() ?? '';
      const name = await findCardName(el);
      if (!name) return;
      const price = await requestPrice(name);
      const display = displayOf(price);
      if (!display) return;
      // 待っている間に表示が変わっていたら触らない(次のスキャンで再処理)
      if ((el.textContent?.trim() ?? '') !== original) return;
      el.textContent = display.text;
      el.title = `${name}: ${display.title} / 元の表示: ${original}`;
      el.dataset.jpPriceDone = display.text;
    } finally {
      processing.delete(el);
    }
  }

  function scan(): void {
    if (!isEnabled()) return;
    const candidates = document.querySelectorAll<HTMLElement>(
      'span, div, td, em, strong, b, p',
    );
    for (const el of candidates) {
      const text = el.textContent?.trim() ?? '';
      if (text.length === 0 || text.length > 28) continue;
      if (el.dataset.jpPriceDone === text) continue;
      // 既に処理済みの要素の内側は触らない
      if (el.closest('[data-jp-price-done]') !== null && !el.dataset.jpPriceDone)
        continue;

      const isPair = PAIR_RE.test(text) && el.childElementCount <= 3;
      const isSingle = el.childElementCount === 0 && SINGLE_RE.test(text);
      if (isPair || isSingle) void processEl(el);
    }
  }

  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 800);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  scan();

  startTotalBadge(adapter, isEnabled);
}

/** デッキ合計金額のバッジ(画面右下、進捗バッジの上) */
function startTotalBadge(adapter: SiteAdapter, isEnabled: () => boolean): void {
  if (!adapter.getDeckList) return;
  const getDeckList = adapter.getDeckList.bind(adapter);

  let badge: HTMLDivElement | null = null;
  let computedForPath: string | null = null;

  function render(text: string, title: string): void {
    if (!badge) {
      badge = document.createElement('div');
      badge.style.cssText = [
        'position: fixed',
        'right: 16px',
        'bottom: 64px',
        'z-index: 2147483647',
        'pointer-events: auto',
        'background: rgba(20, 20, 24, 0.88)',
        'color: #fff',
        'font: 12px/1.4 system-ui, sans-serif',
        'padding: 6px 12px',
        'border-radius: 8px',
        'box-shadow: 0 2px 10px rgba(0,0,0,0.35)',
      ].join(';');
      document.documentElement.appendChild(badge);
    }
    badge.textContent = text;
    badge.title = title;
    badge.style.display = 'block';
  }

  function hide(): void {
    if (badge) badge.style.display = 'none';
  }

  async function compute(): Promise<void> {
    const path = location.pathname;
    if (computedForPath === path) return;
    computedForPath = path;

    const list = await getDeckList();
    if (!list) return;

    const totalCards = list.reduce((s, e) => s + e.quantity, 0);
    let sum = 0;
    let pricedCards = 0;
    let usedFallback = false;
    let settled = 0;

    await Promise.all(
      list.map(async ({ name, quantity }) => {
        try {
          const price = await requestPrice(name);
          const value = representative(price);
          if (value !== null) {
            sum += value * quantity;
            pricedCards += quantity;
            if (price.hareruya === null) usedFallback = true;
          }
        } catch {
          // 取得失敗は合計から除外するだけ
        } finally {
          settled++;
          if (!isEnabled() || location.pathname !== path) return;
          const suffix = settled < list.length ? ' 取得中…' : '';
          render(
            `デッキ合計 ${fmt(sum)}${usedFallback ? '*' : ''} (${pricedCards}/${totalCards}枚)${suffix}`,
            '晴れる屋最安(NM・非foil)の合計。* はWisdom Guild平均で補完したカードを含む。' +
              '価格が取得できなかったカードは合計に含まれません。',
          );
        }
      }),
    );
  }

  // SPAなのでページ遷移でデッキが変わったら再計算(computedForPathで抑制)
  setInterval(() => {
    if (!isEnabled()) {
      hide();
      return;
    }
    if (badge && computedForPath === location.pathname) {
      badge.style.display = 'block'; // OFF→ONの復帰
    }
    void compute();
  }, 1500);
}
