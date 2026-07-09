import type { CardRef } from '../scryfall';
import type { DeckEntry, SiteAdapter } from '../swapper';

/** Playtest画面のURL: /playtester-v2/{deckId} (旧 /playtester/ も許容) */
const PLAYTESTER_PATH = /^\/playtester(-v2)?\/(\d+)/;
/** デッキビュー画面のURL: /decks/{deckId} */
const DECK_PATH = /^\/decks\/(\d+)/;

/**
 * カード画像URL(実測 2026-07):
 * https://card-images.archidekt.com/normal/front/7/9/{scryfallId}.jpg?...
 * Scryfall (cards.scryfall.io) と同じパス構造のプロキシで、UUIDは印刷のScryfall ID。
 */
const CARD_IMAGE_SRC =
  /card-images\.archidekt\.com\/[^/]+\/(?:front|back)\/[0-9a-f]\/[0-9a-f]\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** 旧形式: https://storage.googleapis.com/archidekt-card-images/{set}/{uid}_normal.jpg */
const LEGACY_IMAGE_SRC =
  /archidekt-card-images\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** altの形式: "Mowu, Loyal Companion (j25) 79" */
const ALT_NAME = /^(.+?) \([a-z0-9]+\) \S+$/;

export function createArchidektAdapter(): SiteAdapter {
  let deckList: DeckEntry[] | null = null;
  let loadedDeckId: string | null = null;
  let loading: Promise<void> | null = null;

  function currentDeckId(): string | null {
    return (
      DECK_PATH.exec(location.pathname)?.[1] ??
      PLAYTESTER_PATH.exec(location.pathname)?.[2] ??
      null
    );
  }

  async function ensureDeckData(): Promise<void> {
    const deckId = currentDeckId();
    if (!deckId || deckId === loadedDeckId) return;
    if (loading) return loading;
    loading = (async () => {
      try {
        // 同一オリジンの公開API
        const res = await fetch(`https://archidekt.com/api/decks/${deckId}/`);
        if (!res.ok) throw new Error(`Archidekt API ${res.status}`);
        deckList = collectDeckList(await res.json());
      } catch (e) {
        console.info('[MTG デッキ日本語化] Archidektデッキ情報の取得に失敗:', e);
        deckList = null;
      } finally {
        loadedDeckId = deckId;
        loading = null;
      }
    })();
    return loading;
  }

  return {
    isTargetPage: () =>
      PLAYTESTER_PATH.test(location.pathname) ||
      DECK_PATH.test(location.pathname),

    // ホバー拡大はPlaytest画面のみ(デッキビューにはサイト標準のプレビューがある)
    isZoomPage: () => PLAYTESTER_PATH.test(location.pathname),

    identify(img: HTMLImageElement): CardRef | null {
      const src = img.getAttribute('src') ?? '';
      // アートのみの切り抜きと、裏向きカードのスリーブ画像は対象外。
      // 特にスリーブ画像をalt由来で差し替えると非公開のカードが公開されてしまう
      if (src.includes('art_crop') || src.includes('card_back')) return null;

      const id = CARD_IMAGE_SRC.exec(src)?.[1] ?? LEGACY_IMAGE_SRC.exec(src)?.[1];
      if (id) return { kind: 'scryfallId', id };

      // フォールバック: 画像URL形式が変わってもalt("名前 (set) 番号")から引ける
      if (img.className.includes('basicCard_image')) {
        const alt = ALT_NAME.exec(img.getAttribute('alt') ?? '');
        if (alt) return { kind: 'name', name: alt[1] };
      }
      return null;
    },

    isBackFace: (img) => {
      const src = img.getAttribute('src') ?? '';
      return src.includes('/back/') || src.includes('_back');
    },

    zoomSrc(img: HTMLImageElement): string | null {
      const src = img.getAttribute('src') ?? '';
      // 裏向きカードのスリーブや切り抜きは拡大しない(非公開情報を出さない)
      if (src.includes('art_crop') || src.includes('card_back')) return null;
      // 差し替え済み(cards.scryfall.io)・未差し替え(card-images.archidekt.com)とも
      // Scryfallと同じパス構造なので /normal/ → /large/ で高解像度になる
      if (
        CARD_IMAGE_SRC.test(src) ||
        (src.includes('cards.scryfall.io') && img.className.includes('basicCard_image'))
      ) {
        return src.replace('/normal/', '/large/');
      }
      if (LEGACY_IMAGE_SRC.test(src)) return src;
      return null;
    },

    async getCardName(img: HTMLImageElement): Promise<string | null> {
      const alt = ALT_NAME.exec(img.getAttribute('alt') ?? '');
      return alt ? alt[1] : null;
    },

    async getDeckList(): Promise<DeckEntry[] | null> {
      await ensureDeckData();
      return deckList;
    },
  };
}

/**
 * ArchidektのデッキAPIレスポンスから合計金額の対象カードを集める。
 * includedInDeck=false のカテゴリ(Maybeboard等)に入っているカードは除外。
 */
function collectDeckList(json: unknown): DeckEntry[] {
  const data = json as {
    categories?: Array<{ name?: string; includedInDeck?: boolean }>;
    cards?: Array<{
      quantity?: number;
      categories?: string[];
      card?: { uid?: string; oracleCard?: { name?: string } };
    }>;
  } | null;

  const excluded = new Set(
    (data?.categories ?? [])
      .filter((c) => c.includedInDeck === false && typeof c.name === 'string')
      .map((c) => c.name as string),
  );

  const out: DeckEntry[] = [];
  for (const entry of data?.cards ?? []) {
    const name = entry.card?.oracleCard?.name;
    const quantity = entry.quantity;
    if (typeof name !== 'string' || typeof quantity !== 'number' || quantity <= 0)
      continue;
    if ((entry.categories ?? []).some((c) => excluded.has(c))) continue;
    out.push({
      name,
      quantity,
      scryfallId:
        typeof entry.card?.uid === 'string' ? entry.card.uid : undefined,
    });
  }
  return out;
}
