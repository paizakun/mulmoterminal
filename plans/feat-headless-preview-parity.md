# ヘッドレスプレビューを、ペインのプレビューと同じものにする（P6）

**状態**: 実装済み（2026-08-17）。§5 の 1–7 すべて
**日付**: 2026-08-17
**実装先**: MulmoTerminal のみ（`@receptron/sharedapp` も mulmoserver も変更しない）
**前提**: [`plans/feat-shared-app-no-staging.md`](./feat-shared-app-no-staging.md) §5b（P6 の決定）、
[`plans/feat-shared-app-headless-preview.md`](./feat-shared-app-headless-preview.md)（P5、走らせる側）

この計画が答える問い:

> **ヘッドレスプレビューが LLM のためにあるなら、ペインのプレビューと機能が 100% 同じで
> なければ意味がない。いま何が違っていて、それを埋めると何が要るのか。**

---

## 1. 違いは 4 つある（コードを読んで数えた）

親は文字どおり同じモジュールで、`@receptron/sharedapp/view` の `viewBridge` /
`memberBridge` / `portChannel` / `publicViewSrcdoc` を、mulmoserver の `/a/{slug}` も
MulmoTerminal のペインもヘッドレスも実行している。**ホストが持つのは chrome だけ**なので、
違いはホストが親に渡すもの — `BridgePorts` の中身 — に全部出る。

| | ペイン（`SharedAppPreview.vue`） | ヘッドレス（`headlessHarness.ts`） |
|---|---|---|
| `submit` | `POST /api/shared-app/preview/submit` → **本物の書き込み** | `{ ok: false, error: "a headless preview never writes" }` |
| 確認への答え | 人が accept / decline | **常に `decline()`** |
| `notice` | 両方の bridge で `remember({kind:"notice"})` | **どちらにも渡していない** |
| 見た目 | 人が見る | **誰も見ない** |
| member の intent | 全部 refuse（ペインも書かない） | 全部 refuse — **既に同じ** |

5 行目は既にパリティなので、埋めるのは **4 つ**。

## 2. なぜ今なら書けるのか

旧モデルでは `deploy` 前のアプリは `apps/{aid}` が無く、受諾しても rules に弾かれた
ので、「受諾しない」はポリシーである前に**事実**だった。staging 廃止（#1760）で
`init` の時点で `apps/{aid}` が在り、記録の書き込みができる。残っていたのはポリシーだけ
で、そのポリシーの代償は「**publish 前にいちばん知りたい答え（rules の判定）を永久に
持ち帰れない**」だった。

## 3. 設計

### D-1. 受諾は Node 側で決め、判定を「渡す」

`writePreviewSubmission(root, cid, values)` — **ペインの HTTP ルートが呼ぶのと同じ関数** —
を **Node が呼び**、その答えを持った状態でハーネスの `accept(answer)` を呼ぶ。ハーネスの
`submit` はその answer を返すだけで、ページはそれを本物の判定として受け取る。ルートを経由
しないのは、経由できないからではなく、経由すると HTTP と JSON とセッションを 1 往復増やして
得るものが無いから。判定を出す場所は同じ。

> **レビューで直した（2026-08-17、codex P1 ×2）。** 最初は `page.exposeFunction("__previewWrite", …)`
> でブラウザから Node を呼んでいた。2 つ壊れていた:
>
> 1. **`exposeFunction` はページの「全ドキュメント」に束縛を張る** — ここで唯一信用していない
>    サンドボックスの `srcdoc` を含めて。ページが `window.__previewWrite` を直接呼べば、
>    実行の上限も台帳も取り消しも素通りで、実アプリに実レコードを好きなだけ作れた。
> 2. **書き込みが `evaluateMs` の締切の向こう側にあった。** ブラウザへの問いは全部 5 秒で
>    打ち切るので、遅い書き込みは実行から見捨てられ、しかし DB は受理しうる — 誰も報告せず
>    誰も消さないレコードができる。
>
> どちらも「書き込みを Node に置き、答えだけを渡す」で同時に消える。ページが受け取れるのは
> **Node が渡すと決めた値だけ**になり、書き込みはブラウザの締切と無関係に await される。

`writePreviewSubmission` は既に:

- `writableFields` / `missingRequired` / `recordOf` / `recordId` / `plannedWrite` を
  パッケージから使う（＝レコードの形は公開ページと同一）
- mirror がある宣言では `writeBatch` で対にして書く（`getAfter()` を読む rules のため）
- 拒否されたら `explainRefusal` で**どの条件が成り立たなかったか**を言う
- `undoPreviewSubmission(token)` で取り消せる（mirror は `MIRROR_OPEN` に戻す）

**ヘッドレスのために新しく書く書き込み経路は無い。** これが D-1 の全部。

### D-2. 押すたびに、書いて、すぐ消す

`decline()` を `accept()` に替えるだけでは済まない。ヘッドレスは**1 押しごとに新しい
ページを mount する**ので、同じ cid に `idFrom: "auth.uid"` で書くアプリでは 2 つ目の
押下が「もう在る」で拒否される。それを rules の判定として報告すると**嘘になる** —
断ったのは我々自身が 1 つ前に書いたレコードだから。

なので取り消しは**実行の最後にまとめてではなく、その押下の直後**に行う。

1. press → 確認が上がる → `accept()`
2. 判定（受理／拒否＋理由）を、その press の行に記録
3. 受理されていたら即 `undoPreviewSubmission(token)`、消せたかどうかも記録
4. 次の press は、きれいな状態の DB に対して走る

**消せたかどうかを必ず言う**のは、これがペインより「多い」動作だから（ペインは押した人が
何を書いたか知っている。編集のたびに走るループはそうではない）。枠取り型のアプリでは
消し損ねが実枠を占有する。

### D-2b. 「誰が断ったか」を持ち回る

`writePreviewSubmission` の失敗は rules の判定だけではない — セッションが無い、射影が
組めない、必須フィールドが来ていない、id が既に埋まっている。全部を「deployed rules が
拒否した」と報告すると、**rules が見てもいない宣言を著者が直しに行く**。

`PreviewWriteFailure` に `reason: "rules" | "taken" | "host"` を足す。特に `taken` は
`idFrom: "auth.uid"` では**著者自身のレコード**との衝突を意味し、uid の違う訪問者は通る
ので、訪問者について何も言っていない。報告はこの 3 つを言い分ける。

（レビューで出た指摘 = codex P2。ペインは読まない — 読み手が自分の画面を見ている人で、
この文脈を持っているから。ヘッドレスの読み手はそれを持たないエージェント。）

### D-3. 書き込みには上限を置き、落とした分を言う

6 ページ × 6 押下 = 最大 36 回の実書き込みになりうる。`LIMITS.writes` を置き、超えた
確認は**受諾せずに decline する**。その press の行は「受諾しなかった」と言い、実行の
まとめでも件数を言う（沈黙した上限は「全部やった」と読まれる、という家の規則）。

### D-4. スクリーンショットはファイルに書き、パスを報告する

ペインに残る最後の優位は「人が見た目を判定する」こと。画像を返せば判定するのは LLM に
なる。ツールの戻り値は文字列なので、**PNG を書いて絶対パスを返す** — エージェントは
それを Read できる。

- 置き場は OS の一時ディレクトリの下に実行ごとの 1 つ（`mulmoterminal-preview-*`）。
  リポジトリには書かない — プレビューは著者の作業ツリーを汚してはいけない
- 撮るのは**フレーム**であってハーネスのページ全体ではない（ハーネスの chrome は
  誰の関心でもない）
- 撮るのは press の前の状態。押した後の状態はページごとに違い、どれを撮っても
  「代表」にならない
- 撮れなかったら**その旨を言って続ける**。画像は診断であって、実行の成否ではない

### D-5. `notice` を両方の bridge に渡す

ページ自身が報告する診断（uncaught error、reject されたままの promise、サンドボックスが
無視した modal）を、ペインは拾っていてヘッドレスは捨てている。`BridgePorts.notice` を
両方に渡し、press の行と `errors` に混ぜる。

`detail` は**ページが書いた文字列**で信用できない。読み手は著者本人なので出してよいが、
**どこから来たかを明示する**（既に `docs`/`common/sharedAppViewVocabulary.ts` の語彙が
同じ扱いをしている）。

## 4. 壊してはいけないもの

1. **`runPagesHeadless` は今のままテストから駆動できること。** 手で書いたページを、アプリも
   セッションも DB も無しで走らせるのが既存のテストのやり方。→ 書き込み関数は**注入**する。
   注入されなければ今までどおり `decline()` し、報告もそう言う。
2. **報告に「publish してよい」という判定を書かない。** rules の判定が 1 つ増えても、
   他人の端末・同時実行・rules が deploy されているか、は依然として答えていない。
   固定の締めくくりは**弱めずに書き換える**（「何も書いていない」だけが嘘になる）。
3. **実行が途中で死んでも、書いたものを消す努力をする。** press ごとの取り消しに加えて、
   実行の最後に「まだ消えていない token」を掃く。
4. **ブラウザが無ければ今までどおり正直に断る。** 書き込みができるようになっても、
   ブラウザが要る事実は変わらない。

## 5. 実装順

1. `previewWrite.ts` — 変更なし（使うだけ）
2. `headlessHarness.ts` — `submit` を注入された関数に、`accept()` を公開、`notice` を両方に渡す
3. `headlessPreview.ts` — `exposeFunction`、press ごとの accept → 判定 → 取り消し、
   スクリーンショット、上限
4. `headlessReport.ts` — 判定・取り消し・画像パス・落とした受諾を書く。締めくくりを書き換える
5. `shared-app-tool.ts` — `preview` の説明文を書き換える（**「書き込みは無い」は嘘になる**）
6. `server/skills/mulmoterminal-shared-app/SKILL.md` — 同じ
7. テスト — ハーネス無しで報告を確かめるもの（既存のやり方）＋ 注入した書き込み関数が
   呼ばれること・取り消しが呼ばれること
