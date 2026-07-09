import type { CardRef } from '../scryfall';
import type { SiteAdapter } from '../swapper';

/**
 * 対象画面のURL: /decks/{publicId}(デッキビュー)とその配下
 * (/goldfish = Playtest、/primer 等を含む)
 */
const DECK_PATH = /^\/decks\/([^/]+)/;
/**
 * カード画像URL(実測):
 * - 通常カード:   https://assets.moxfield.net/cards/card-{moxfieldId}-normal.webp
 * - 両面カード等: https://assets.moxfield.net/cards/card-face-{moxfieldId}-normal.webp
 */
const CARD_IMAGE_SRC = /moxfield\.[a-z]+\/cards\/card-(?:(?:face|back)-)*([A-Za-z0-9]+)-/;
/**
 * Moxfield自身がScryfall画像を直接使う箇所(両面カードのプレビュー等)。
 * URLに印刷のScryfall IDが入っているのでそのまま使える。
 */
const SCRYFALL_IMAGE_SRC =
  /cards\.scryfall\.io\/[a-z_]+\/(?:front|back)\/[0-9a-f]\/[0-9a-f]\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
/** カード名ではないaltの値(プレースホルダやフリップウィジェットのボタン) */
const NON_CARD_ALTS = new Set(['Card Image', 'Front', 'Back', 'Transform']);

/** MoxfieldカードID(または面ID)1つ分の情報 */
interface CardEntry {
  scryfallId: string;
  /** 両面カードの裏面のIDか */
  back: boolean;
}

/**
 * MoxfieldのPlaytest画像は alt="Card Image" でカード名を持たないため、
 * デッキの公開APIからMoxfieldカードID→Scryfall IDの対応表を作って識別する。
 */
export function createMoxfieldAdapter(): SiteAdapter {
  /** moxfieldのカードID・面ID → Scryfall ID と表裏 */
  let cardMap = new Map<string, CardEntry>();
  let loadedDeckId: string | null = null;
  let loading: Promise<void> | null = null;

  function currentDeckId(): string | null {
    return DECK_PATH.exec(location.pathname)?.[1] ?? null;
  }

  async function ensureDeckData(): Promise<void> {
    const deckId = currentDeckId();
    if (!deckId || deckId === loadedDeckId) return;
    if (loading) return loading;

    loading = (async () => {
      try {
        // ページ自身も呼んでいる公開API。非公開デッキでは失敗するがその場合は諦める
        const res = await fetch(
          `https://api2.moxfield.com/v3/decks/all/${deckId}`,
        );
        if (!res.ok) throw new Error(`Moxfield API ${res.status}`);
        const json: unknown = await res.json();
        cardMap = collectCards(json);
        loadedDeckId = deckId;
      } catch (e) {
        console.info('[MTG Playtest 日本語化] デッキ情報の取得に失敗:', e);
        loadedDeckId = deckId; // リトライの嵐を避けるため失敗も記録
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  return {
    isTargetPage: () => currentDeckId() !== null,

    async identify(img: HTMLImageElement): Promise<CardRef | null> {
      const src = img.getAttribute('src') ?? '';

      const scryfall = SCRYFALL_IMAGE_SRC.exec(src);
      if (scryfall) return { kind: 'scryfallId', id: scryfall[1] };

      const match = CARD_IMAGE_SRC.exec(src);
      if (!match) return null;
      await ensureDeckData();
      const entry = cardMap.get(match[1]);
      if (entry) return { kind: 'scryfallId', id: entry.scryfallId };
      // 対応表に無い場合(非公開デッキ等)はaltのカード名で引く。
      // フリップウィジェットのボタン等のaltは除外する
      const alt = img.getAttribute('alt')?.trim() ?? '';
      if (alt && !NON_CARD_ALTS.has(alt)) return { kind: 'name', name: alt };
      return null;
    },

    isBackFace: (img) => {
      const src = img.getAttribute('src') ?? '';
      // 面IDが対応表にあればそれが正(card-face-{裏面ID} のURLには
      // "back" が含まれないため、URLだけでは判定できない)
      const id = CARD_IMAGE_SRC.exec(src)?.[1];
      const entry = id !== undefined ? cardMap.get(id) : undefined;
      if (entry) return entry.back;
      return (
        src.includes('-back') || src.includes('back-') || src.includes('/back/')
      );
    },
  };
}

/**
 * デッキJSONを再帰的に走査し、`id` と `scryfall_id` を両方持つ
 * カードオブジェクトを全て拾う。APIレスポンスの構造変化(v2/v3、
 * boards/tokensの配置)に依存しないための総当たり方式。
 * 両面カードは card_faces の各面が固有の `id` を持ち、面画像のURL
 * (card-face-{面ID}-...)に使われるため、面IDも親のScryfall IDに紐づける。
 */
function collectCards(
  node: unknown,
  map = new Map<string, CardEntry>(),
): Map<string, CardEntry> {
  if (Array.isArray(node)) {
    for (const item of node) collectCards(item, map);
  } else if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj.id === 'string' && typeof obj.scryfall_id === 'string') {
      const scryfallId = obj.scryfall_id;
      map.set(obj.id, { scryfallId, back: false });
      if (Array.isArray(obj.card_faces)) {
        obj.card_faces.forEach((face, index) => {
          const faceId = (face as Record<string, unknown> | null)?.id;
          if (typeof faceId === 'string') {
            map.set(faceId, { scryfallId, back: index > 0 });
          }
        });
      }
    }
    for (const value of Object.values(obj)) {
      if (value !== null && typeof value === 'object') collectCards(value, map);
    }
  }
  return map;
}
