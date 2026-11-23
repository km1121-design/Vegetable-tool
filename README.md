# 縁 野菜配送（ルート配送アプリ）

取引先「縁」の野菜をルート配送するためのアプリです。SBS配送ツール（km1121-design/-Tool-）の `starter/` から作っています。
作り方・決まりごとは `.claude/skills/field-app-starter/SKILL.md` に従います。

- 保存先：Googleスプレッドシート（Apps Script）／ホスティング：Cloudflare Pages
- ログイン：利用コード（SBSと同じ人＋追加）
- 出発地点は固定。ルートは固定。割り振りはしない。Googleマップの道案内リンクを出す
- 配送リストを読み込む。日当は記録のみ（取り込みはしない）

---

# 現場アプリのひな形（field-app-starter）

SBS配送ツールで使っている骨組みだけを抜き出したものです。
**スプレッドシートを保存先**にして、**利用コードでログイン**する、スマホ向けの小さなウェブアプリをすぐ作れます。

| 入っているもの | 場所 |
| --- | --- |
| 利用コードのログイン（署名つき通行証・90日。呼び出しのたびにシートで有効か確かめ直す） | `src/auth/` `api/login.js` |
| シート（Apps Script）を呼ぶ部品（タイムアウト・HTMLエラー画面の1回呼び直し・合言葉の伏せ字） | `src/storage/appsScript.js` |
| シート側の受け口（利用者タブ・記録タブ・管理者・版の番号） | `apps-script/endpoint.gs` |
| 業務の例：記録の保存と一覧・合計（決まった計算） | `api/records.js` `src/domain/records.js` |
| 設置の状態（シートの版が古いと分かる） | `api/health.js` |
| Cloudflare Pages の入口 | `functions/api/[[route]].js` |
| 画面（ログイン・入力・一覧・管理者は全員分） | `public/index.html` |
| 本物の .gs を模擬シートで動かす通し試験 | `test/` |

## 新しいアプリにする

1. このフォルダを新しいリポジトリにコピーする（GitHub の「テンプレートリポジトリ」にしておくと、ボタン1つで複製できる）
2. `src/domain/records.js`・`api/records.js`・`apps-script/endpoint.gs` の記録タブを、そのアプリの業務に合わせて書き換える
3. `npm test` が通ることを確かめる

## 設置（はじめの1回）

1. 保存先にするスプレッドシートを作り、「拡張機能 → Apps Script」に `apps-script/endpoint.gs` を貼る
2. `TOKEN` を長い合言葉に書き換え、「デプロイ → 新しいデプロイ → ウェブアプリ」（実行: 自分 / アクセス: 全員）
3. Cloudflare Pages でこのリポジトリをつなぐ（ビルドコマンドなし・出力 `public`）
4. Pages の環境変数に `APPS_SCRIPT_URL`（デプロイの URL）と `APPS_SCRIPT_TOKEN`（合言葉）を入れて出し直す
5. シートに「利用者」タブができたら（初回のアクセスで自動作成。無ければ手で作る）、
   `名前 / 利用コード / 有効 / 区分 / メモ` の行を足す。区分を「管理者」にすると全員分が見られる

合言葉・利用コード・API キーは GitHub やチャットに書かず、環境変数の入力欄にだけ入れてください。

## 手元で動かす

```
cp .dev.vars.example .dev.vars   # 中身を自分の値に（.dev.vars は Git に入らない）
npm run dev                      # http://localhost:8788
npm test
```

## シート側を変えたとき

`endpoint.gs` の `SCRIPT_VERSION` と `src/scriptVersion.js` を同じ数だけ上げ、スクリプトを貼り直して
「デプロイを管理 → 編集 → 新しいバージョン」で出し直します。`/api/health` の `scriptVersion` が古いままなら貼り直し忘れです。
