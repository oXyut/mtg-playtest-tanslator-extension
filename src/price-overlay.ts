import { browser } from 'wxt/browser';
import { frontFaceName, type JpPrice } from './prices';
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

function isPriceOnly(text: string | null): boolean {
  const t = (text ?? '').trim();
  return SINGLE_RE.test(t) || PAIR_RE.test(t);
}

/** 価格源のページURL(晴れる屋の商品検索 / Wisdom Guildのカードページ) */
function sourceUrl(name: string, fromHareruya: boolean): string {
  const front = encodeURIComponent(frontFaceName(name));
  return fromHareruya
    ? `https://www.hareruyamtg.com/ja/products/search?product=${front}`
    : `https://wonder.wisdom-guild.net/price/${front}/`;
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
      // 価格単体のリンクだった場合は、リンク先を価格源のページに付け替える
      const anchor = el.closest('a');
      if (anchor && isPriceOnly(anchor.textContent)) {
        anchor.setAttribute(
          'href',
          sourceUrl(name, price.hareruya !== null),
        );
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener noreferrer');
      }
    } finally {
      processing.delete(el);
    }
  }

  function scan(): void {
    if (!isEnabled()) return;
    const candidates = document.querySelectorAll<HTMLElement>(
      'span, div, td, em, strong, b, p, a',
    );
    for (const el of candidates) {
      const text = el.textContent?.trim() ?? '';
      if (text.length === 0 || text.length > 28) continue;
      if (el.dataset.jpPriceDone === text) continue;
      // 「Buy @ 〇〇 $x.xx」のようなラベル付きボタンは米国店舗の実売額なので触らない。
      // 価格だけのリンク(プレビュー下の価格等)は対象にする
      const link = el.closest('a, button');
      if (link !== null && !isPriceOnly(link.textContent)) continue;
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

/** 内訳パネル1行分 */
interface PricedRow {
  name: string;
  quantity: number;
  /** 1枚あたりの円。取得できなかったカードは null */
  unit: number | null;
  fromHareruya: boolean;
}

/** デッキ合計金額のバッジ(画面右下、進捗バッジの上)。クリックで内訳パネルを開く */
function startTotalBadge(adapter: SiteAdapter, isEnabled: () => boolean): void {
  if (!adapter.getDeckList) return;
  const getDeckList = adapter.getDeckList.bind(adapter);

  let badge: HTMLDivElement | null = null;
  let panel: HTMLDivElement | null = null;
  let computedForPath: string | null = null;
  let rows: PricedRow[] = [];

  function ensureBadge(): HTMLDivElement {
    if (badge) return badge;
    badge = document.createElement('div');
    badge.style.cssText = [
      'position: fixed',
      'right: 16px',
      'bottom: 64px',
      'z-index: 2147483647',
      'background: rgba(20, 20, 24, 0.88)',
      'color: #fff',
      'font: 12px/1.4 system-ui, sans-serif',
      'padding: 6px 12px',
      'border-radius: 8px',
      'box-shadow: 0 2px 10px rgba(0,0,0,0.35)',
      'cursor: pointer',
      'user-select: none',
    ].join(';');
    badge.addEventListener('click', togglePanel);
    document.documentElement.appendChild(badge);
    return badge;
  }

  function render(text: string, title: string): void {
    const el = ensureBadge();
    el.textContent = text;
    el.title = title + '\nクリックで内訳を表示';
    el.style.display = 'block';
  }

  function hide(): void {
    if (badge) badge.style.display = 'none';
    if (panel) panel.style.display = 'none';
  }

  function togglePanel(): void {
    if (panel && panel.style.display !== 'none') {
      panel.style.display = 'none';
      return;
    }
    renderPanel();
  }

  function renderPanel(): void {
    if (!panel) {
      panel = document.createElement('div');
      panel.style.cssText = [
        'position: fixed',
        'right: 16px',
        'bottom: 100px',
        'z-index: 2147483647',
        'width: 340px',
        'max-height: 60vh',
        'overflow-y: auto',
        'background: rgba(20, 20, 24, 0.95)',
        'color: #fff',
        'font: 12px/1.6 system-ui, sans-serif',
        'padding: 10px 14px',
        'border-radius: 8px',
        'box-shadow: 0 4px 16px rgba(0,0,0,0.45)',
      ].join(';');
      document.documentElement.appendChild(panel);
    }
    panel.replaceChildren();

    const header = document.createElement('div');
    header.textContent = '価格内訳(クリックで店舗ページへ)';
    header.style.cssText =
      'font-weight: 600; margin-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 4px;';
    panel.appendChild(header);

    const sorted = [...rows].sort(
      (a, b) => (b.unit ?? -1) * b.quantity - (a.unit ?? -1) * a.quantity,
    );
    for (const row of sorted) {
      const line = document.createElement('div');
      line.style.cssText =
        'display: flex; justify-content: space-between; gap: 8px;';
      const link = document.createElement('a');
      link.textContent = `${row.name}${row.quantity > 1 ? ` ×${row.quantity}` : ''}`;
      link.href = sourceUrl(row.name, row.fromHareruya);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.cssText =
        'color: #7ec8ff; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
      const value = document.createElement('span');
      value.style.cssText = 'flex-shrink: 0; text-align: right;';
      value.textContent =
        row.unit !== null
          ? fmt(row.unit * row.quantity) + (row.fromHareruya ? '' : '*')
          : '—';
      line.append(link, value);
      panel.appendChild(line);
    }

    const note = document.createElement('div');
    note.textContent =
      '* はWisdom Guild平均(晴れる屋在庫なし)。— は価格を取得できなかったカード。';
    note.style.cssText =
      'margin-top: 6px; color: rgba(255,255,255,0.6); font-size: 11px;';
    panel.appendChild(note);
    panel.style.display = 'block';
  }

  async function compute(): Promise<void> {
    const path = location.pathname;
    if (computedForPath === path) return;
    computedForPath = path;

    const list = await getDeckList();
    if (!list) return;

    rows = [];
    const totalCards = list.reduce((s, e) => s + e.quantity, 0);
    let sum = 0;
    let pricedCards = 0;
    let usedFallback = false;
    let settled = 0;

    await Promise.all(
      list.map(async ({ name, quantity }) => {
        let row: PricedRow = { name, quantity, unit: null, fromHareruya: false };
        try {
          const price = await requestPrice(name);
          const value = representative(price);
          if (value !== null) {
            row = {
              name,
              quantity,
              unit: value,
              fromHareruya: price.hareruya !== null,
            };
            sum += value * quantity;
            pricedCards += quantity;
            if (price.hareruya === null) usedFallback = true;
          }
        } catch {
          // 取得失敗は合計から除外するだけ
        } finally {
          rows.push(row);
          settled++;
          if (!isEnabled() || location.pathname !== path) return;
          const suffix = settled < list.length ? ' 取得中…' : '';
          render(
            `デッキ合計 ${fmt(sum)}${usedFallback ? '*' : ''} (${pricedCards}/${totalCards}枚)${suffix}`,
            '晴れる屋最安(NM・非foil)の合計。* はWisdom Guild平均で補完したカードを含む。' +
              '価格が取得できなかったカードは合計に含まれません。',
          );
          if (panel && panel.style.display !== 'none') renderPanel();
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
