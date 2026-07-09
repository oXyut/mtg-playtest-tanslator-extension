# MTG デッキ日本語化 (mtg-deck-translator)

Moxfield / Archidekt のデッキ画面と Playtest(ソリティア)画面で、カード画像を**公式の日本語版印刷の画像**に差し替える Chrome 拡張機能です。翻訳データは [Scryfall](https://scryfall.com/) の日本語版 printing を使うため、機械翻訳ではなく公式訳が表示されます。

- 日本語版が存在しないカード(再録のない古いカードなど)は英語のまま表示されます
- 対応画面:
  - Moxfield: `moxfield.com/decks/{id}` 配下(デッキビュー、primer、Playtest = goldfish)
  - Archidekt: `archidekt.com/decks/{id}`(デッキビュー)と `archidekt.com/playtester-v2/{id}`(Playtest)
- ArchidektのPlaytestではカードにマウスを乗せると拡大表示します(Moxfieldの標準ホバー拡大に相当。ポップアップでOFFにできます)
- **日本の店舗価格(デッキ合計)**: デッキ合計の円建てバッジを画面左下に表示します(Moxfield / Archidekt)
  - 価格源はポップアップで選択: **晴れる屋**(既定) / [Wisdom Guild](https://wonder.wisdom-guild.net/) 掲載店(カードラッシュ・トレトク等) / **店舗問わず最安**。いずれも在庫あり・非foilの最安値で、取れない場合はWisdom Guildのトリム平均で近似(`¥xxx*`)
  - バッジには集計に使った店舗モードを表示。対象はメインデッキ+統率者(サイドボード・Maybeboardは除外)
  - バッジをクリックすると内訳パネル(日本語カード名・高い順)が開き、各カードから晴れる屋の商品検索/WGのカードページに飛べます
  - 価格は**カード名単位**です(セット・絵柄・言語別ではありません)
  - 24時間キャッシュ+直列取得で店舗サイトに負荷をかけない設計です。店舗設定を変えたらページを再読み込みしてください

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
      Moxfield : img src の card-{ID}- / card-face-{面ID}- を、デッキ公開API
                 (api2.moxfield.com/v3/decks/all/{id}) の JSON で Scryfall ID に変換。
                 サイト由来のScryfall直リンク画像はURLからIDを抽出。
                 どちらも失敗したら alt のカード名で検索
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

価格(デッキ合計)は、CORS回避のため background service worker が晴れる屋の検索API /
Wisdom Guildの価格ページから取得します(200ms間隔の直列キュー+24時間キャッシュ)。

主要ファイル:

| ファイル | 役割 |
|---|---|
| `entrypoints/content.ts` | エントリポイント。ホスト名で adapter を選択 |
| `entrypoints/background.ts` | 価格取得の直列キュー+キャッシュ(メッセージで応答) |
| `src/swapper.ts` | MutationObserver で img を監視して差し替え |
| `src/scryfall.ts` | 日本語版 printing 検索(レート制限キュー付き) |
| `src/prices.ts` | 晴れる屋 / Wisdom Guild の価格取得ロジック |
| `src/price-overlay.ts` | デッキ合計バッジと内訳パネル |
| `src/hover-zoom.ts` / `src/progress-badge.ts` | ホバー拡大 / 進捗バッジ |
| `src/cache.ts` / `src/settings.ts` | storage キャッシュ (TTL 30日) / 設定 |
| `src/sites/moxfield.ts` / `src/sites/archidekt.ts` | サイト別の識別ロジック |
| `entrypoints/popup/` | ON/OFF・店舗選択・キャッシュクリア |

開発者向けの詳細(データソースの仕様、デバッグ手法、設計の経緯)は [DEV.md](DEV.md) を参照してください。

## 既知の制限

- **カード名(alt)ベースのフォールバック時は選択精度が落ちる**: 非公開デッキ(Moxfield、デッキAPIが403)やデッキ対応表に無いカード(Playtest中に追加したトークン等)は、imgのaltのカード名でScryfallを検索します。動作はしますが、元printingが分からないため絵柄・セット一致の優先は効かず、最新の日本語版が選ばれます
- **カード名が取れないimgは対象外**: altがカード名でないimg(例: Moxfieldのライブラリトップの `alt="Card Image"`)は、非公開デッキ等で対応表も使えない場合は英語のまま表示されます
- **サイト側のDOM・画像URL形式に依存**: Moxfield/ArchidektがCDNやURL形式を変更すると識別できなくなる可能性があります(altフォールバックである程度は耐えます)
- **機械翻訳はしない設計**: 日本語版printingが存在しないカード(再録のない古いカード、発売直後の未収録データ等)は常に英語のままです
- アイコン未設定(Chrome標準のパズルアイコンが表示されます)
