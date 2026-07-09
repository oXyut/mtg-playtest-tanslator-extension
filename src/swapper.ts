import { lookupJapaneseImages, type CardRef } from './scryfall';

export interface SiteAdapter {
  /** 現在のURLが日本語化の対象画面か(SPA遷移があるため毎回チェックする) */
  isTargetPage(): boolean;
  /** 現在のURLがホバー拡大の対象画面か(未定義なら isTargetPage と同じ) */
  isZoomPage?(): boolean;
  /** imgからカード識別子を得る。対象外のimgなら null */
  identify(img: HTMLImageElement): CardRef | Promise<CardRef | null> | null;
  /** 両面カードの裏面画像を表示中か */
  isBackFace(img: HTMLImageElement): boolean;
  /** ホバー拡大用の高解像度画像URL。拡大対象外のimgなら null */
  zoomSrc?(img: HTMLImageElement): string | null;
}

const ORIGINAL_SRC = 'jpOriginalSrc';
const ORIGINAL_SRCSET = 'jpOriginalSrcset';
/** 自分が差し替えたsrc。サイト由来のScryfall画像と区別するための記録 */
const SWAPPED_SRC = 'jpSwappedSrc';

/** 差し替え先の画像サイズを元画像のサイズ(small/normal/large)に合わせる */
const SCRYFALL_SIZE = /cards\.scryfall\.io\/(small|normal|large)\//;
function matchImageSize(originalSrc: string, target: string): string {
  const size = SCRYFALL_SIZE.exec(originalSrc)?.[1];
  if (!size) return target;
  return target.replace(SCRYFALL_SIZE, `cards.scryfall.io/${size}/`);
}

export function startSwapper(
  adapter: SiteAdapter,
  isEnabled: () => boolean,
): { rescan: () => void; restoreAll: () => void } {
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'childList') {
        for (const node of m.addedNodes) {
          if (node instanceof HTMLImageElement) {
            void processImg(node);
          } else if (node instanceof Element) {
            node.querySelectorAll('img').forEach((img) => void processImg(img));
          }
        }
      } else if (
        m.type === 'attributes' &&
        m.target instanceof HTMLImageElement
      ) {
        void processImg(m.target);
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });

  const rescan = () => {
    document.querySelectorAll('img').forEach((img) => void processImg(img));
  };
  rescan();

  async function processImg(img: HTMLImageElement): Promise<void> {
    if (!isEnabled() || !adapter.isTargetPage()) return;

    const src = img.getAttribute('src') ?? '';
    if (!src) return;
    // 自分が差し替えた画像なら何もしない(無限ループ防止)。
    // サイト自身がScryfall画像を使うことがある(Moxfieldの両面カードプレビュー等)
    // ため、ホスト名ではなく「自分が設定したsrcかどうか」で判定する
    if (img.dataset[SWAPPED_SRC] === src) return;

    const ref = await adapter.identify(img);
    if (!ref) return;

    const jp = await lookupJapaneseImages(ref);
    if (!jp) return;

    let target = adapter.isBackFace(img) ? jp.back : jp.front;
    // 裏面の日本語画像が取れないケースは英語のままにする
    if (!target) return;
    target = matchImageSize(src, target);
    if (target === src) return;

    // 待っている間にsrcが変わっていたら、その変更分のmutationで再処理される
    if (img.getAttribute('src') !== src) return;

    img.dataset[ORIGINAL_SRC] = src;
    if (img.srcset) {
      img.dataset[ORIGINAL_SRCSET] = img.srcset;
      img.srcset = '';
    }
    img.dataset[SWAPPED_SRC] = target;
    img.src = target;
  }

  const restoreAll = () => {
    document
      .querySelectorAll<HTMLImageElement>(`img[data-jp-original-src]`)
      .forEach((img) => {
        const original = img.dataset[ORIGINAL_SRC];
        if (original) img.src = original;
        const originalSrcset = img.dataset[ORIGINAL_SRCSET];
        if (originalSrcset) img.srcset = originalSrcset;
        delete img.dataset[ORIGINAL_SRC];
        delete img.dataset[ORIGINAL_SRCSET];
        delete img.dataset[SWAPPED_SRC];
      });
  };

  return { rescan, restoreAll };
}
