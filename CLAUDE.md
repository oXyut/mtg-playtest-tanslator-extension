# CLAUDE.md

Moxfield / Archidekt のカード画像を日本語版に差し替え、日本の店舗価格を表示するChrome拡張(WXT + TypeScript, MV3)。

## コマンド

- `npx tsc --noEmit` — 型チェック(変更後は必ず実行)
- `npm run build` — 本番ビルド → `.output/chrome-mv3/`(ユーザーはここを読み込んでいる)
- リリース: package.jsonのversionを上げて commit → `git tag vX.Y.Z && git push origin vX.Y.Z` → GitHub ActionsがzipをReleaseに添付

## 重要な制約

- **MoxfieldはCloudflareがヘッドレスブラウザ/curlをブロック**。実DOMの検証は「小さなConsoleスニペットをユーザーに渡して出力を貼ってもらう」方式で行う(Archidektはヘッドレスで直接検証可)
- Scryfall/晴れる屋/Wisdom Guildへのリクエストは直列キュー+キャッシュ必須(仕様・罠は DEV.md)
- 価格処理のデバッグ: ページのConsoleで `localStorage.mtgJpDebug = '1'`

詳細(データソース仕様・検証ハーネス・設計の経緯)は **DEV.md** を参照。
