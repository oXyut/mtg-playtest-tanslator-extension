# MTG デッキ日本語化 (mtg-deck-translator)

Moxfield / Archidekt のデッキ画面と Playtest(ソリティア)画面で、カード画像を**公式の日本語版印刷の画像**に差し替える Chrome 拡張機能です。翻訳データは [Scryfall](https://scryfall.com/) の日本語版 printing を使うため、機械翻訳ではなく公式訳が表示されます。

- 日本語版が存在しないカード(再録のない古いカードなど)は英語のまま表示されます
- 対応画面:
  - Moxfield: `moxfield.com/decks/{id}` 配下(デッキビュー、primer、Playtest = goldfish)
  - Archidekt: `archidekt.com/decks/{id}`(デッキビュー)と `archidekt.com/playtester-v2/{id}`(Playtest)
- ArchidektのPlaytestではカードにマウスを乗せると拡大表示します(Moxfieldの標準ホバー拡大に相当。ポップアップでOFFにできます)

## インストール(ビルド済みを使う)

1. [Releases](https://github.com/oXyut/mtg-deck-translator-extension/releases) から最新の `mtg-deck-translator-x.y.z-chrome.zip` をダウンロードして解凍
2. `chrome://extensions` を開き、右上の「デベロッパーモード」をON
3. 「パッケージ化されていない拡張機能を読み込む」で解凍したフォルダを指定

## 開発・インストール

```bash
npm install
npm run dev      # 開発モード(Chromeが自動起動、HMR付き)
npm run build    # 本番ビルド → .output/chrome-mv3/
npm run zip      # ストア提出用zip
```

手動で読み込む場合は `npm run build` 後、`chrome://extensions` → デベロッパーモード → 「パッケージ化されていない拡張機能を読み込む」で `.output/chrome-mv3/` を指定してください。

## 仕組み

```
content script (MutationObserver)
  → site adapter が img からカードを識別
      Moxfield : img src の card-{MoxfieldID}- を、デッキ公開API
                 (api2.moxfield.com/v3/decks/all/{id}) の JSON で Scryfall ID に変換
      Archidekt: img src (card-images.archidekt.com/normal/front/x/y/{uuid}.jpg) に
                 Scryfall UUID がそのまま入っている(alt "名前 (set) 番号" のフォールバックあり)
  → Scryfall で日本語版 printing を検索
      Scryfall ID → /cards/collection で一括解決(75件/リクエスト)
      → oracleid:xxx lang:ja を検索
      (100ms間隔の直列キューでレート制限を遵守)
  → 候補が複数ある場合の優先順位:
      カード名まで日本語の通常版 > 元の英語版と同じ絵柄(illustration_id)
      > 同じセット > 高解像度スキャン > リリースが新しいもの
  → img.src を日本語版画像 (cards.scryfall.io) に差し替え
  → 結果は chrome.storage.local に30日キャッシュ(「日本語版なし」も記録)
```

主要ファイル:

| ファイル | 役割 |
|---|---|
| `entrypoints/content.ts` | エントリポイント。ホスト名で adapter を選択 |
| `src/swapper.ts` | MutationObserver で img を監視して差し替え |
| `src/scryfall.ts` | 日本語版 printing 検索(レート制限キュー付き) |
| `src/cache.ts` | storage.local キャッシュ (TTL 30日) |
| `src/sites/moxfield.ts` / `src/sites/archidekt.ts` | サイト別の識別ロジック |
| `entrypoints/popup/` | サイト別 ON/OFF とキャッシュクリア |

## 既知の制限

- **非公開デッキ(Moxfield)**: デッキ公開APIが 403 を返すため差し替えできません(対応するにはページの fetch を傍受してデッキJSONを取得する MAIN world スクリプトが必要)
- **トークン**: Playtest 中に追加したトークンはデッキJSONに含まれない場合があり、英語のまま表示されます
- **両面カードの裏面**: 画像URLの `back` を含むかで判定するヒューリスティックのため、サイト側のURL形式変更で効かなくなる可能性があります
- アイコン未設定(Chrome標準のパズルアイコンが表示されます)
