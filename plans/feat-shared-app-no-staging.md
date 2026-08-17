# staging を廃止し、「作った時点で在る」「publish で見える」の 2 状態にする

**状態**: 実装済み（2026-08-16〜17）。sharedapp 0.8.0 公開済み・mulmoserver は receptron/mulmoserver#190、
MulmoTerminal は #1760。P6（ヘッドレスのパリティ）だけが未着手
**日付**: 2026-08-16
**実装先**: `@receptron/sharedapp`（npm）・`../mulmoserver`（ルール／ルート／ビュー）・MulmoTerminal（ツール／スキル）
**前提**: [`docs/shared-app-principles.md`](../docs/shared-app-principles.md)（原則 8・9 を書き換える）、
[`plans/feat-shared-app-preview.md`](./feat-shared-app-preview.md)（staging 撤去を最初に提案した計画）

## 1. 要件（確定）

1. **staging は完全に廃止**
2. **アプリを作った時点で**、サーバ側で slug が予約され、データベースへの書き込みが可能になり、
   プレビューも可能になる
3. **publish** すると、そのアプリが Web サイトからアクセス可能になる
4. **view を更新すると**プレビューが可能になる（データは本物）
5. **再び publish** すると、更新した view も Web サイトからアクセス可能になる

言い換えると、アプリの状態は **2 つだけ**になる: 「在る（名簿と著者のもの）」と「公開されている」。
今ある 3 つ目 —「deploy 済み・未公開・名簿が `/staging/{aid}` で試している」— が消える。

## 2. 今どうなっているか（消す対象の棚卸し）

| 何 | どこ |
|---|---|
| `deploy` 動詞 | `server/infra/shared-app-tool.ts`（`SHARED_APP_ACTIONS`）、`server/backends/sharedApp/deploy.ts` |
| ステージされたスキーマ `apps/{aid}/staging/{cid}` | `deploy.ts`、`staged.ts`、`publish.ts`（昇格元）、`exclusivity.ts` |
| ステージされたページ `member/staged:*` `roster/staged:*` | `appViews.ts`、mulmoserver `src/firestore/appViews.ts` の `ViewStage = "live" \| "staged"` |
| `/staging/{aid}` の 3 ルートと 3 ビュー | mulmoserver `src/router/index.ts:137-150`、`views/Staged*.vue`、`composables/useStagedApp.ts` |
| ルールの `match /staging/{cid}` | mulmoserver `firestore.rules:183`（`allow write` のコメントが `// = deploy`） |
| 2 面の射影 `projectDeploy` / `projectPublish` | `@receptron/sharedapp` `src/publishProject.ts:364, 466` |

**記録（`apps/{aid}/collections/{cid}/items`）は staging を通っていない。** staging にあるのは
**スキーマとページだけ**で、記録は最初から本番の場所にある。これが撤去を軽くする一番大きな事実で、
移行でデータが動かない理由でもある。

**もう 1 つ大きい: `appSlugs` のルールは変更不要。** 予約は既に `published: false` で作られ、
`allow read` は「公開済みなら誰でも、未公開なら名簿の人」になっている（`firestore.rules:860-863`）。
つまり要件 2 は**ルールを 1 行も変えずに満たせる** — 予約する場所を deploy から init に移すだけ。

## 3. 新しい形

### 3a. 動詞

| 今 | これから |
|---|---|
| `init` — `app.json` をローカルに書くだけ | `init` — `app.json` を書き、**同じ操作で** `apps/{aid}` を作り、slug を予約し、スキーマとページを書く。ここから記録の書き込みとプレビューができる（要件 2） |
| `check` — 書かずに宣言を検査 | 変更なし |
| `preview` — working tree から射影して実ブラウザで走らせる。書き込み無し | 変更なし（要件 4 は**今のまま満たされている**。preview は元々サーバの版ではなく working tree を見る） |
| `deploy` — staging に書く | **削除** |
| `publish` — staging を昇格し公開する | `publish` — **working tree** を全部書き、`config/public` と `appSlugs/{slug}.published` を立てる（要件 3・5） |
| `unpublish` | 変更なし（`published` を倒す。書いたものは残る） |

### 3b. 何が「見える」を決めるか

- `apps/{aid}` と `collections/{cid}` と `member/*` `roster/*` は **init から在る**。名簿の人は
  `/m/{slug}` `/p/{slug}` で使える（slug 予約は未公開でも名簿には読めるので、**aid の入口は要らない**
  — これが `/staging/{aid}` を消せる理由そのもの）
- `config/public` と `appSlugs/{slug}.published` だけが publish のもの。公開の顔 `/a/{slug}` は
  publish まで「ここには何もありません」を返す（今と同じ文言・同じ理由）

### 3c. 失う保証と、その代わり

原則 8 の「**publish は staging が審査した版を昇格する**（working tree を読まない）」が無くなる。
publish は working tree を読む。代わりに立つのは **preview**（`plans/feat-shared-app-preview.md`）で、
これは「人が名簿の画面で見る」より強い保証を、著者の手元で、publish の直前に与える。
`docs/shared-app-principles.md` の原則 8 はこの形に書き換える。

原則 9（取り消せない 3 つ）は**そのまま**だが、**slug を焼く時点が早くなる**。捨てられたアプリ 1 つに
つき名前が 1 つ死ぬ。要件 2 がそれを承知の上での指定なので、原則 9 に「**予約は init で起きる**」と
明記し、`init` が slug を確認してから取ることをスキルの手順にする。

## 4. 3 リポジトリの作業

**`@receptron/sharedapp`**
- `projectDeploy` / `projectPublish` を畳んで `projectApp` の 1 面にする。`stagedRuleConfig` /
  `promoteSchema` / `appStagingPath` / `StagedSchemaDoc` を削除
- minor ではなく **major**（0.8.0 でよいが破壊的）。npm 公開が MT と mulmoserver のブロッカーになる

**`../mulmoserver`**
- ルート 3 本とビュー 3 本、`useStagedApp.ts`、`ViewStage` の `"staged"` を削除。`viewDocId` は
  `live:` 固定になるので**ドキュメント id の形を変えるかどうかは別問題**（変えると既存アプリの
  ページが読めなくなる。**変えない**）
- `firestore.rules` の `match /staging/{cid}` を削除。1 リクエストの式数は**減る**
- `test/rules/rules_staging.ts` を削除し、`rules_publish.ts` から昇格の筋を落とす
- **手動 deploy が要る**（CI 無し）。ルール変更なのでアプリの再 publish より先に出す

**MulmoTerminal**
- `deploy.ts` を削除し、その中の「記録がスキーマを満たさないなら拒否」「削除されたコレクションの
  引き上げ」を publish に寄せる（publish 側に同じ関門が既にある）
- `init` に書き込みを足す。**順序は今の deploy と同じ**: app ドキュメントが先、slug の予約は後
  （`appSlugs` の create ルールが所有者を app 経由で解決するため）
- `staged.ts` 削除、`publish.ts` は `stagedFromWorkingTree`（preview が既に持っている関数）を使う
- スキルの手順 3（Deploy）を消し、3b（RUN THE PAGE）を 3 に繰り上げる。ツールの `prompt` から
  `/staging/{aid}` の案内を全部落とす

## 5. 決まったこと（2026-08-16）

**D1 = (a) publish だけが更新する。動詞は 4 つ（init / check / preview / publish）。**
要件 2 は init で書き込み可能になると言い、要件 3 は publish が公開だと言う。その間に
コレクションを 1 つ足したとき、記録の書き込み権限は `apps/{aid}` の `collections` マップが
決めるので、**サーバの app ドキュメントを更新しないと新しいコレクションには書けない**。
要件 2 は init で書き込み可能になると言い、要件 3 は publish が公開だと言う。その間に
コレクションを 1 つ足したとき、記録の書き込み権限は `apps/{aid}` の `collections` マップが
決めるので、**新しいコレクションへの書き込みは publish の後**になる。これは承知の上の代償。
`init` は既存アプリを拒否したまま（冪等にしない）、`sync` のような動詞も作らない。

**D2 = (a) 既存アプリの移行はしない。** `apps/{aid}/staging/*` の残骸は誰も読まなくなるだけで、
記録は元から staging を通っていないので失われるものが無い。消したくなったらいつでも消せる
（`allow delete: if false` は `apps/{aid}` と `appSlugs` の話で、`staging/{cid}` には掛かっていない）。

**D3. プレビューからの書き込み。** ペインのプレビュー（人が承諾を押す）は init の直後から通る —
`apps/{aid}` が在るので rules が所有者を解決でき、著者としての create が受理される。これが要件 2 の
実体である。**ツールの `action: "preview"` は従来どおり書かない**（全確認を `decline()`）。理由は
staging とは無関係で、「ツール呼び出しは人ではない」まま変わらない。

## 5b. P6 — ヘッドレスプレビューをペインと同一にする（2026-08-16 決定）

**ヘッドレスが LLM のためにあるなら、ペインと機能が 100% 同じでなければ意味がない。**
実際、違いは 1 か所しかない: `headlessHarness.ts` の「NOTHING IS EVER ACCEPTED」。親は文字どおり
同じモジュール（`@receptron/sharedapp/view` の `viewBridge` / `portChannel` / `publicViewSrcdoc`）で、
mulmoserver の `/a/{slug}` も MT のペインもそれを実行している。ホストが持つのは chrome だけ。

**受諾しない理由が、staging 廃止で消える。** 旧モデルでは「deploy 前は書けない」が普通の状態で、
受諾しても rules に弾かれた。新モデルでは init の直後から書けるので、書かないのはポリシーだけになり、
その結果ヘッドレスは **rules の判定**（publish 前にいちばん知りたい答え）を永久に持ち帰れない。

要るもの:

1. **受諾する。** ペインの accept と同じ経路を通し、rules の判定を報告に載せる
   （受理か、拒否か、どのフィールドか）
2. **スクリーンショットを返す。** ペインの残る優位は「人が見た目を判定する」こと。画像を返せば
   判定するのは LLM になる
3. **書いたものを報告し、best effort で消す。** ペインは「押した人が何を書いたか知っている」で
   済むが、編集のたびに走るループはそうではない。枠取り型のアプリでは消さないと実枠を占有する。
   消せたかどうかも言う（これだけはペインより「多い」動作で、意図的）

**順序は staging 廃止の後。** 受諾が通るには `apps/{aid}` が init の時点で在る必要がある。

## 6. 実装順

1. `sharedapp` の射影を 1 面に畳む → 0.8.0 公開
2. mulmoserver: ルールの `staging` を削除 → **手動 deploy** → ルート／ビュー／`ViewStage`
3. MulmoTerminal: `init` に書き込みを移し、`deploy` を削除、publish を working tree 読みに
4. スキルとツール文言、`docs/shared-app-principles.md` の原則 8・9、README／ガイド
5. 実アプリ 1 つで通し確認（init → preview → publish → view 更新 → preview → publish）
6. P6（ヘッドレスのパリティ）— 上が全部入ってから
