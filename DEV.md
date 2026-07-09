# DEV.md — 開発者向け詳細

アーキテクチャの全体像とファイル構成は README.md の「仕組み」を参照。ここには外部データソースの仕様・検証手法・設計判断の経緯をまとめる。

## 外部データソースの仕様と罠

### Scryfall API

- 検索: `GET /cards/search?q=oracleid:{oid} lang:ja game:paper&unique=prints&order=released&dir=desc`
- 一括解決: `POST /cards/collection`(identifiers 75件/リクエスト。IDからoracle_id等を引くのに使用)
- **罠1**: `!"名前"` の完全一致検索は**片面の名前が一致する別カード**(分割・prepare等)にもヒットする。`name` フィールド(常に英語)との完全一致 or 表面一致でフィルタすること
- **罠2**: `lang:ja` でも**カード名が英語のまま印刷された変種**(FF系ボーダーレス等)がある。`printed_name` のCJK判定で「名前まで日本語の通常版」を優先する(src/scryfall.ts)
- **罠3**: HTTPライブラリのデフォルトUser-Agentは400(generic_user_agent)で拒否される。ブラウザからは問題ないが、curl/Nodeでの検証時はUA指定が必要
- レート制限: 50-100ms間隔推奨 → 100ms直列キュー
- 画像URL: `https://cards.scryfall.io/{size}/{front|back}/{id[0]}/{id[1]}/{id}.jpg`(sizeは small/normal/large)

### Moxfield

- Playtest URL: `/decks/{publicId}/goldfish`(「playtest」ではない)
- デッキ公開API: `GET https://api2.moxfield.com/v3/decks/all/{publicId}`(非公開デッキは403)
  - `boards.{mainboard,commanders,companions}.cards[].{quantity, card}` に枚数とカード
  - カードは `id`(画像URLのID)、`scryfall_id`、`name` を持つ
  - **両面カードは `card_faces[].id` が面ごとの固有ID**で、面画像URL `card-face-{面ID}-normal.webp` に使われる。対応表には面IDも登録する
- 画像URL: `assets.moxfield.net/cards/card-{ID}-normal.webp` / `card-face-{面ID}-...`
- DFCプレビュー(フリップウィジェット)は alt="Front"/"Back"/"Transform" の3枚のimg
- サイト自身が `cards.scryfall.io` の画像を直接使う箇所がある(プレビュー等)→「Scryfallホスト=差し替え済み」と判定してはいけない。data属性(jpSwappedSrc)で自分の差し替えを記録して区別する
- **CloudflareがヘッドレスChrome/curlをブロック**(api2も同様)。実DOM検証はユーザーのブラウザのConsoleスニペットで行う(出力は件数・文字数を絞り、data属性など拡張側の状態も出すと切り分けが速い)

### Archidekt

- Playtest URL: `/playtester-v2/{deckId}`、デッキビュー: `/decks/{deckId}`
- デッキAPI: `GET https://archidekt.com/api/decks/{id}/`(同一オリジンなのでcontent scriptから直接fetch可)
  - `cards[].{quantity, categories, card.uid(=Scryfall ID), card.oracleCard.name}`
  - `categories[].includedInDeck === false`(Maybeboard等)のカテゴリに入るカードは合計から除外
- 画像URL: `card-images.archidekt.com/{size}/{front|back}/{a}/{b}/{ScryfallID}.jpg`(Scryfallと同一パス構造のプロキシ。/normal/→/large/ も有効)
- alt形式: `"カード名 (set) 番号"` — 識別のフォールバックに使える
- ヘッドレスChromeでレンダリング検証可能(Cloudflareブロックなし)

### 晴れる屋(価格)

- 検索API: `GET https://www.hareruyamtg.com/ja/products/search/unisearch_api?rows=100&kw={英語名}`(JSON)
- docs[]: `card_name`(英語・**面の名前**)、`price`、`stock`、`foil_flg`、`card_condition`(1=NM)、`product_name`
- **罠**: `card_name` は面名なので分割カードの裏面名でも一致する。`product_name` の先頭の《...》ブロックに検索名が含まれることを確認して除外
- 両面カードは表面名で検索する(`name.split(' // ')[0]`)

### Wisdom Guild(価格)

- 価格ページ: `https://wonder.wisdom-guild.net/price/{英語名}/`(+は空白。%20も可)
- サマリー: `最安：<b>N</b> 円` / `トリム平均：<b>N</b> 円` を正規表現で抽出
- 在庫あり一覧: `?stock_gt=1`(価格昇順、20行/ページ、`?page=N`)。`state_code` は効かない(実測)
- 店舗行: 店名リンク(`shop/{id}/`)・価格・FOILアイコン(`title="FOIL"`)・状態(NM/EX/VG…)・`nostock`クラス(在庫なし)
- 店舗指定モードは最大4ページを早期終了付きで探索。人気の安いカードほど他店で先頭ページが埋まるため、指定店が見つからずトリム平均フォールバックになることがある(シングルスターは特にその傾向)
- **晴れる屋もWG在庫一覧には載っている**が、当拡張は晴れる屋を自前APIで引く(精度と1リクエストで済むため)
- 東京MTGはWG不参加+自サイトがトップページから429を返すため見送り(2026-07)

## キャッシュ構造(chrome.storage.local)

- `jp:sid:{scryfallId}` / `jp:name:{小文字名}` → 日本語版画像URL(+日本語名)。TTL 30日。「日本語版なし」のnullも記録
- `price:{store}:{小文字名}` → JpPrice。TTL 24時間

## 検証ハーネス(実APIに対するスモークテスト)

コアロジック(scryfall.ts / prices.ts)はNodeで直接検証できる。`wxt/browser` はesbuildのaliasでスタブに差し替える:

```bash
# stub: browser.storage.local をMapで代替したファイルを用意して
./node_modules/.bin/esbuild test.ts --bundle --platform=node --format=esm \
  --alias:wxt/browser=./browser-stub.ts --outfile=test.mjs && node test.mjs
```

fetchにUser-Agentを付けるラッパーを忘れずに(Scryfallの罠3)。

## デバッグ

- ページのConsoleで `localStorage.mtgJpDebug = '1'` → 価格集計の判断過程が `[MTGデッキ日本語化]` プレフィックスで出る(解除は removeItem)
- 画像差し替えの状態は `img.dataset.jpOriginalSrc / jpSwappedSrc` を見る

## 設計判断の経緯

- **ドル価格の個別円置き換えは v0.11.0 で撤去**。Moxfieldのプレビュー価格はカード画像と小さな共通コンテナを持たず(共通祖先=ページ全体、img 77〜120個)、近接探索も「プレビュー画像を含まない階層で打ち切る」実装だったため安定しなかった。復活させる場合は「img多数階層で近接探索に失敗しても、さらに上の階層で探索を続ける」修正が有望(コードは v0.10.1 の src/price-overlay.ts)
- 価格は**カード名単位**(セット・絵柄・言語別ではない)。printing別の価格が必要なら晴れる屋APIの `product_name` のセット表記 `[SET]` をパースする拡張が考えられる
- Moxfieldのバッジ位置は下部固定フッターを避けて bottom 76px(Archidektは16px)。`entrypoints/content.ts` の `badgeBottom`
