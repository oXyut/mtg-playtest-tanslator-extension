import { browser } from 'wxt/browser';
import { frontFaceName, type JpPrice } from './prices';
import { lookupJapaneseImages } from './scryfall';
import type { DeckEntry, SiteAdapter } from './swapper';

/**
 * ページ上のドル価格表示を日本の店舗価格(円)に置き換え、
 * デッキ合計金額の円建てバッジ(クリックで内訳パネル)を表示する。
 * 価格の取得自体はbackground service worker(entrypoints/background.ts)が行う。
 * バッジ類はサイト側の右下のUIと重ならないよう左下に置く。
 */

/** "$10.99 / $12.99" のようなペア表示のコンテナ */
const PAIR_RE = /^\$[\d,]+(?:\.\d+)?\s*\/\s*\$[\d,]+(?:\.\d+)?$/;
/** "$10.99" 単体の葉要素 */
const SINGLE_RE = /^\$[\d,]+(?:\.\d+)?$/;
/** 価格要素からカード画像を探すときに遡る最大の階層(プレビュー価格は深めの位置にある) */
const MAX_ANCESTOR_DEPTH = 10;
/** コンテナ内のimgがこれより多い場合は「どのカードの価格か」を特定できないとみなす */
const MAX_IMGS_IN_CONTAINER = 12;

type RequestPrice = (name: string) => Promise<JpPrice>;

/** localStorage.mtgJpDebug = '1' で価格処理のデバッグログを出す */
function debug(...args: unknown[]): void {
  try {
    if (localStorage.getItem('mtgJpDebug') === '1') {
      console.log('[MTGデッキ日本語化]', ...args);
    }
  } catch {
    /* localStorage不可の環境では黙る */
  }
}

function fmt(yen: number): string {
  return '¥' + yen.toLocaleString('ja-JP');
}

/** 設定値から店舗モードの表示名 */
function storeLabel(store: string): string {
  if (store === 'hareruya') return '晴れる屋';
  if (store === 'lowest') return '店舗問わず最安';
  if (store.startsWith('wg:')) return store.slice(3);
  return store;
}

function isPriceOnly(text: string | null): boolean {
  const t = (text ?? '').trim();
  return SINGLE_RE.test(t) || PAIR_RE.test(t);
}

/** 価格源のページURL(晴れる屋の商品検索 / Wisdom Guildのカードページ) */
function sourceUrl(name: string, linkHareruya: boolean): string {
  const front = encodeURIComponent(frontFaceName(name));
  return linkHareruya
    ? `https://www.hareruyamtg.com/ja/products/search?product=${front}`
    : `https://wonder.wisdom-guild.net/price/${front}/`;
}

function displayOf(p: JpPrice): { text: string; title: string } | null {
  if (p.value === null) return null;
  return {
    text: fmt(p.value) + (p.approximate ? '*' : ''),
    title: `${p.sourceLabel ?? ''}: ${fmt(p.value)}`,
  };
}

export function startPriceOverlay(
  adapter: SiteAdapter,
  isEnabled: () => boolean,
  getStore: () => string,
): void {
  const requestPrice: RequestPrice = (name) =>
    browser.runtime.sendMessage({
      type: 'jp-price',
      name,
      store: getStore(),
    }) as Promise<JpPrice>;

  if (adapter.getCardName) startDollarSwap(adapter, isEnabled, requestPrice);
  startTotalBadge(adapter, isEnabled, requestPrice, getStore);
}

/** ページ上のドル価格をカードに紐づけて円に置き換える */
function startDollarSwap(
  adapter: SiteAdapter,
  isEnabled: () => boolean,
  requestPrice: RequestPrice,
): void {
  const getCardName = adapter.getCardName!.bind(adapter);

  /** 価格要素の近くのカード画像からカード名を特定する */
  /**
   * imgが多すぎる階層に達したときのフォールバック:
   * 価格要素と同じ縦の列(X中心が画像の幅内)にあり、縦方向に近い
   * カード画像を候補にする。プレビュー画像と価格は小さな共通コンテナを
   * 持たないことがある(Moxfieldで実測)ための近接ヒューリスティック
   */
  function columnCandidates(
    el: Element,
    imgs: NodeListOf<HTMLImageElement>,
  ): HTMLImageElement[] {
    const rect = el.getBoundingClientRect();
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    return [...imgs]
      .map((img) => ({ img, r: img.getBoundingClientRect() }))
      .filter(
        ({ r }) =>
          r.width > 50 && // アイコン類を除外
          cx >= r.left &&
          cx <= r.right &&
          Math.abs((r.top + r.bottom) / 2 - cy) < 600,
      )
      .sort(
        (a, b) =>
          Math.abs((a.r.top + a.r.bottom) / 2 - cy) -
          Math.abs((b.r.top + b.r.bottom) / 2 - cy),
      )
      .slice(0, 3)
      .map(({ img }) => img);
  }

  async function findCardName(el: Element): Promise<string | null> {
    let node: Element | null = el.parentElement;
    for (let depth = 0; node && depth < MAX_ANCESTOR_DEPTH; depth++) {
      const imgs = node.querySelectorAll('img');
      if (imgs.length > MAX_IMGS_IN_CONTAINER) {
        debug('カード特定: 深さ', depth, 'でimg', imgs.length, '個 → 近接探索へ');
        for (const img of columnCandidates(el, imgs)) {
          const name = await getCardName(img);
          if (name) {
            debug('近接カード特定:', name);
            return name;
          }
        }
        debug('近接カード特定失敗: 同じ列にカード画像なし');
        return null;
      }
      for (const img of imgs) {
        const name = await getCardName(img);
        if (name) {
          debug('カード特定: 深さ', depth, '→', name);
          return name;
        }
      }
      node = node.parentElement;
    }
    debug('カード特定失敗: 祖先', MAX_ANCESTOR_DEPTH, '階層にカード画像なし');
    return null;
  }

  const processing = new WeakSet<Element>();

  /**
   * "$A / $B" のペア(近くの祖先)があればそれを置き換え対象にする。
   * 1枚のカードに対する円価格は1つなので、ペアごと単一表示にまとめる
   */
  function replaceTarget(el: HTMLElement): HTMLElement {
    let node: HTMLElement | null = el.parentElement;
    for (let i = 0; i < 2 && node; i++, node = node.parentElement) {
      if (PAIR_RE.test(node.textContent?.trim() ?? '')) return node;
    }
    return el;
  }

  async function processEl(el: HTMLElement): Promise<void> {
    const target = replaceTarget(el);
    if (processing.has(target)) return;
    processing.add(target);
    try {
      const original = target.textContent?.trim() ?? '';
      debug('価格候補を処理:', JSON.stringify(original), target.tagName);
      const name = await findCardName(target);
      if (!name) return;
      const price = await requestPrice(name);
      debug('価格取得:', name, '→', JSON.stringify(price));
      const display = displayOf(price);
      if (!display) return;
      // 待っている間に表示が変わっていたら触らない(次のスキャンで再処理)
      if ((target.textContent?.trim() ?? '') !== original) {
        debug('置換中止: 処理中に表示が変わった', JSON.stringify(original));
        return;
      }
      target.textContent = display.text;
      target.title = `${name}: ${display.title} / 元の表示: ${original}`;
      target.dataset.jpPriceDone = display.text;
      // 価格単体のリンクだった場合は、リンク先を価格源のページに付け替える
      const anchor = target.closest('a');
      if (anchor && isPriceOnly(anchor.textContent)) {
        anchor.setAttribute('href', sourceUrl(name, price.linkHareruya));
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener noreferrer');
      }
    } finally {
      processing.delete(target);
    }
  }

  function scan(): void {
    if (!isEnabled()) {
      debug('スキャン停止: 設定OFFまたは対象外ページ');
      return;
    }
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
}

/** 内訳パネル1行分 */
interface PricedRow {
  name: string;
  jaName?: string;
  quantity: number;
  /** 1枚あたりの円。取得できなかったカードは null */
  unit: number | null;
  approximate: boolean;
  linkHareruya: boolean;
}

/** デッキ合計金額のバッジ(画面左下)。クリックで内訳パネルを開く */
function startTotalBadge(
  adapter: SiteAdapter,
  isEnabled: () => boolean,
  requestPrice: RequestPrice,
  getStore: () => string,
): void {
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
      'left: 16px',
      'bottom: 16px',
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
      // 下から: 合計バッジ(16) → 進捗バッジ(52) → 内訳パネル(92) の順に積む
      panel.style.cssText = [
        'position: fixed',
        'left: 16px',
        'bottom: 92px',
        'z-index: 2147483647',
        'width: 360px',
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
      const label = row.jaName ?? row.name;
      link.textContent = `${label}${row.quantity > 1 ? ` ×${row.quantity}` : ''}`;
      link.title = row.name;
      link.href = sourceUrl(row.name, row.linkHareruya);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.cssText =
        'color: #7ec8ff; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
      const value = document.createElement('span');
      value.style.cssText = 'flex-shrink: 0; text-align: right;';
      value.textContent =
        row.unit !== null
          ? fmt(row.unit * row.quantity) + (row.approximate ? '*' : '')
          : '—';
      line.append(link, value);
      panel.appendChild(line);
    }

    const note = document.createElement('div');
    note.textContent =
      '* はWisdom Guild平均による近似。— は価格を取得できなかったカード。';
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
    if (!list || list.length === 0) return;

    // 集計に使った店舗モード(集計中に設定が変わっても表示と中身がずれないよう固定)
    const usedStore = storeLabel(getStore());
    rows = [];
    const totalCards = list.reduce((s, e) => s + e.quantity, 0);
    let sum = 0;
    let pricedCards = 0;
    let usedFallback = false;
    let settled = 0;

    await Promise.all(
      list.map(async (entry: DeckEntry) => {
        const { name, quantity } = entry;
        let row: PricedRow = {
          name,
          quantity,
          unit: null,
          approximate: false,
          linkHareruya: false,
        };
        try {
          // 日本語名(画像差し替えで温まったキャッシュから引けることが多い)
          const jaName = entry.scryfallId
            ? (await lookupJapaneseImages({ kind: 'scryfallId', id: entry.scryfallId }))
                ?.jaName
            : undefined;
          const price = await requestPrice(name);
          if (price.value !== null) {
            row = {
              name,
              jaName,
              quantity,
              unit: price.value,
              approximate: price.approximate,
              linkHareruya: price.linkHareruya,
            };
            sum += price.value * quantity;
            pricedCards += quantity;
            if (price.approximate) usedFallback = true;
          } else {
            row.jaName = jaName;
          }
        } catch {
          // 取得失敗は合計から除外するだけ
        } finally {
          rows.push(row);
          settled++;
          if (!isEnabled() || location.pathname !== path) return;
          const suffix = settled < list.length ? ' 取得中…' : '';
          render(
            `デッキ合計(${usedStore}) ${fmt(sum)}${usedFallback ? '*' : ''} (${pricedCards}/${totalCards}枚)${suffix}`,
            `${usedStore}モードでの合計。* はWisdom Guild平均で近似したカードを含む。` +
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
