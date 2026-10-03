# D-PENDING-001: guarded steering admission

Canonical approved design. Implementation of this complete design is approved. Approval covers implementation, task-branch commits and linked PRs only; no main merge or deployment. Independent design review: OK with notes. Its P2 condition (canonical branch document before production edits) is resolved by this document. Independent implementation review: OK with notes. The evidence-wording P2 is resolved below; mandatory integrated verification and exact-head CI remain separate gates.

### 問題と利用者に見える結果

Piは推論終了時に内部をidleにしてから非同期の終了ハンドラを待ち、その後Gatewayへ`agent_settled`を通知する。この間Gatewayは処理中と判断し、`steer`を送れる。一方、Piの`steer`はidleでも成功応答してキューへ入れるだけで、実行を開始しない。未消費入力が残り、次の通常入力もpending検査で拒否され続ける。

**変更後:** 終了付近の入力は、まだ受け取れる同じ実行へ一度だけ渡すか、Piへ未受理のままGatewayの通常キューに戻し、前の応答配信後に通常入力として処理する。完了応答は順番どおり一度ずつ表示する。成功応答と入力の消費は別物として扱う。

### D-PENDING-001の変更範囲

Piの既存実行内のsteering受付境界とRPC、Gatewayの既存invoker・キュー接続だけを変更する。新しい優先順位、ワークフロー自動再開、永続状態、DB migration、ownership変更は導入しない。元のJSONL・tool結果・失敗行は変更も再実行もしない。

#### 1. RPC契約

- `get_state.data.capabilities.guardedSteer: 1` を追加。
- Piの**セッションレベル実行**ごとにプロセス内だけの一意な文字列`runId`を割り当て、既存`agent_start`と`agent_settled`イベントへ付ける。checkpoint/session IDではなく、保存・再開に使わない。低レベルのretry/compaction継続では同じIDを使い、次の通常/native入力による新実行では変える。
- 新Gatewayは初期ユーザー入力の`message_start`を観測した実行IDを保持し、`{"type":"steer","message":"…","expectedRunId":"…"}`を送る。`images`と通常のcommand `id`は従来どおり。
- Piは**同じrunIdが受付中の場合だけ**受理する。
- 確定受理: `success:true, data:{accepted:true}`。親へのenqueue、または既存recipientが受理したことを表す。親の入力消費は従来のuser `message_start`、recipient受理は従来の`steering_consumed`で別に確認する。
- 確定未受理: `success:true, data:{accepted:false, reason:"run_not_accepting"}`。入力を親にもrecipientにも渡していない、またはrecipientが副作用なしで明示的に`false`を返した場合に限定する。
- 不正な`expectedRunId`型などは`success:false, errorCode:"INVALID_STEER_REQUEST", error:"…"`。非同期recipientのthrowは`success:false, errorCode:"STEER_DELIVERY_UNCERTAIN", error:"…"`。Gatewayはこれらを未受理扱いにせず、既存の失敗・再実行禁止経路へ渡す。
- `expectedRunId`を省略した従来のSDK/RPC steerは変更しない。新SDKメソッド`steerIfActive(text, expectedRunId, images?)`はguarded結果を返し、RPCがこれを呼ぶ。汎用promptの挙動やinput hookの扱いは変えない。

#### 2. Pi内の原子的境界

`_runAgentPrompt`が既に所有する実行に、IDと受付可否を付けるだけとする。`_handlePostAgentRun`の**最後のキュー確認から「継続しない」と決める箇所までを同期処理**にし、falseを返す前にその実行の受付を閉じる。正常終了の最終空キュー確認と受付終了の間に`await`を置かない。例外・dispose・abortでも閉じる。終了イベントには終了対象のIDを捕捉して渡し、遅いハンドラ中に別のnative実行が始まっても新実行のIDで古い終了を通知しない。

guarded入力は、受付中の同じIDか、abort済みではないかを確認してから、**awaitなしで**実際の親キューへ追加する。この追加が線形化点。queue-update通知は追加後とする。受付終了後はキューを変えず未受理を返す。

`isStreaming`だけの検査では不十分。最後のキュー確認後からidle通知までのawait/microtask隙間と、非同期recipient処理中の終了・実行交代がある。`finish_work`成立だけでは受付を閉じない。既存契約どおり、その後も受付中に入った実ユーザー入力は正常なキュー境界で消費する。新入力なしでfinish後に推論を起こすことはない。

#### 3. 非同期recipientの扱い

既存の`pushSteeringRecipient`優先を維持する。呼出し前にID/受付/abortを検査する。recipientが受理を返したら、途中で親が終了していても受理済みであり、`steering_consumed`とaccepted:trueを返す。二重に親へ入れない。recipientが`false`を返した場合だけ、同じIDと受付状態を再検査して親へ原子的にenqueueできる。閉じていればaccepted:false。throwは「渡したか不明」なのでguarded経路では親fallbackも自動再投入もしない。recipientのfalseは既存契約上の確定辞退であり、受理後のfalseを許容する新保証は作らない。

#### 4. Gatewayの順序・ACK競合

初期入力が未消費、runId不明、または対象実行のsettled観測後は、steerを送らず既存のfalse経路へ返す。古い終了イベントの後に別実行が始まっても、旧要求のsteerを新しい実行へ混入させない。

**accepted:falseだけ**`steerActiveAgent`のfalseへ変換し、既存`settleInactiveSteeringBatch`でpendingへ戻す。同じチャンネルの現在要求・応答配信が終わるまで通常dispatchしない。初期promptの`pendingMessageCount===0`検査はそのまま残す。

settled受信時には新しいsteer受付を先に閉じる。その要求ですでに送ったguarded commandの結果確定と消費callbackを、要求の完了・steering行の最終処理より先に待つ。ACKが終了通知より後でも、確定未受理の行を失敗扱いにしたり、受理を未送信扱いにしたりしない。待機上限は既存RPC command timeoutを使い、新しい無期限待機を作らない。timeout/disconnect/不正応答/エラーは不確実としてfailed、再投入なし。accepted:trueだけでDB行をdoneにしない。

`work_contract`のresolved summary/awaiting_input questionは、イベント時点で既存の上限付き順序配信chainへ一度だけ積む。物理settledまで一つの変数へ上書きし続けない。同じrun内で「finish→既受理入力→次のfinish」となっても、両方の完成応答を保持する。settledで同じ決定を再配信せず、異なる決定の同文summaryを意味的重複として消さない。tool結果を別の回答として配信しない。

#### 5. 終了・エラー・互換性

abort後は新たにguarded受理しない。abort前に受理された入力は、abortで未消費となり得る。これはaccepted==consumedではなく、従来どおり自動継続・再実行・queue消去しない。provider error、失敗したfinish/wait、通常のcompletedは区別する。本設計の「通常完了競合を解消」は、強制中断後の未消費入力を自動救済する保証ではない。既存stop/recovery境界は維持する。

新Gatewayのpersistent要求は最初の`get_state`でcapability=1を必須とし、旧Piならユーザー入力を送らず「Piの更新が必要」と失敗させる。unsafeなraw steerへのfallbackは禁止。旧Gateway＋新Piは旧挙動のままで、Gateway更新までは修正完了と扱わない。将来の配備順は**Pi→Gateway**、ロールバックは**Gateway→Pi**。既存residentの更新は別承認のidle cutoverで行う。今回は配備もmain mergeもしない。

### 決定的テストと完了条件

| 条項            | production境界・検証                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 遅い終了通知    | real Gateway invoker＋実Pi＋finish_work＋agent_settled barrier。既存版で次入力がpending拒否するRED取得済み。同じ入力・順序assertionをGREENへする         |
| 原子的受付      | Pi harness/faux providerで通常推論中、finish直前、最終queue検査直後をbarrier制御。受理入力は正常完了までに一度消費、閉鎖後は無変更で未受理、次prompt成功 |
| 非同期recipient | accept/false/throwをbarrierで制御し、その間の終了・abort・run交代を検査。受理先一つ、falseだけ再queue、不確実を再送しない                                |
| ACK順序         | 実queue＋invokerと制御RPCでACK前/後のsettled、消費前/後のACK、timeout/disconnect。DB状態、送信回数、次入力受付、配信順序をassert                         |
| 応答と副作用    | 一つの実行内で二つのfinishを通し、各summary一度・順序維持、実際のテストtool副作用一度。JSONL/tool結果を削除・再実行しない                                |
| 中断・互換      | abort/provider error/failed finishを成功扱いしない。旧capabilityは送信前拒否、legacy raw steerは従来どおり                                               |

既存の該当回帰＋各repo必須check/CIを満たしてからtask branch commit/PRを作る。独立レビューとmain merge/配備承認は別ゲート。**承認範囲は二repo実装、必須検証後のtask branch commit/PRまで。main merge・配備は含まない。**

## Implementation acceptance checklist

The rows below describe implemented branch work, **not release acceptance**. Independent implementation review passed with one evidence-wording P2, resolved by distinguishing in-memory entry preservation from paired context/history evidence. Integrated checks and exact-head PR/CI results are recorded separately below. Initial assertion-level RED was retained before production edits; extended tests are additional GREEN coverage, not a claim that every assertion was separately run RED.

| Clause                           | Production seam                                                | RED / minimal GREEN evidence                                                                                                                                                                                                                                           | Review / later-stage effect                                                                                                 |
| -------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1 RPC and run identity           | AgentSession lifecycle, rpc-mode/types, Gateway admission      | Initial Pi run-ID assertions RED; `guarded-steering.test.ts` and `rpc-guarded-steer.test.ts` GREEN: retry/compaction identity, next-run identity, invalid/uncertain/rejected/accepted RPC, legacy idle queue                                                           | Independent review OK; new clients must check capability                                                                    |
| 2 Atomic admission               | `_handlePostAgentRun`, `steerIfActive`                         | Original real-Pi late-settlement fixture RED (next prompt pending refusal); paired real-Pi GREEN. Synchronous final-check microtask test GREEN, finish-time accepted input consumed once                                                                               | Review OK; no queue clearing or forced continuation                                                                         |
| 3 Recipient                      | `steerIfActive` recipient await                                | Recipient accept/decline/throw across run replacement and abort, same-run decline fallback GREEN                                                                                                                                                                       | Review OK; uncertain delivery never replays                                                                                 |
| 4 ACK and rows                   | invoke `sendSteer`/settlement, queue `processSteeringMessages` | Real DB/invoker tests RED→GREEN; ACK/settled inversion, caller row-commit barrier, acceptance not consumption, timeout/disconnect and no replay GREEN                                                                                                                  | Review OK; no DB migration/new authority                                                                                    |
| 4 Decisions                      | `work_contract` delivery                                       | Queue RED showed premature initial-row completion; GREEN preserves two equal summaries in order. Pi GREEN proves actual test-tool effect once, input once, in-memory SessionManager entry prefix preserved; separate paired delayed-child/context-history checks GREEN | Review OK, evidence wording corrected; intermediate text and explicit decision remain distinct events even if text is equal |
| 5 Cancellation and compatibility | abort/dispose, `get_state` capability                          | Abort/provider-failure and existing text-work-control regressions GREEN; old lockfile Pi rejected before prompt, legacy raw steer retained                                                                                                                             | Review OK; accepted-before-abort input may remain pending by existing contract                                              |

All clauses prohibit pending clearing/bypass, synthetic input, unconditional continuation/restart, tool replay, failed-row replay and new ownership/state authority. Compatibility for every clause: **Pi first, Gateway second; rollback Gateway first, Pi second**. Resident cutover and deployment require separate authorization.

### Explicit paired CLI gate

`pnpm test` runs the lockfile-Pi incompatibility check. It does not substitute for the real candidate-Pi regression. Before accepting any paired heads, build the Pi candidate from its task checkout, then run in Gateway:

```sh
PI_TERMINAL_TEST_CLI="$PI_CHECKOUT/packages/coding-agent/dist/bundle/cli.js" pnpm run test:paired-pi
```

The command fails if the CLI is absent; it executes both the delayed-settlement regression and delayed-child/session-history regression. This gate was executed successfully (2 tests), not counted as a silently skipped ordinary-CI test. Record the exact Pi/Gateway commits and build provenance when commits become permissible. Current WIP is not exact-head CI evidence.

### Integrated validation and remaining gates

- Separately reviewed prerequisite repairs address Chord large-array mutations, the historical Together generator fixture, and bounded Gateway DB contention. Dependencies, lockfiles and production catalogue entries are unchanged. The Pi concurrent-steering fixture also now waits for actual mock stream startup rather than a 10ms assumption; this additional test-only correction requires fresh independent review.
- The prerequisite-only Pi candidate passed `check`, supported `build:offline` with a validated independent catalogue snapshot, and isolated `./test.sh`. The integrated pending candidate passes `check` and `build:offline`, but its full test gate remains **blocked**: the final run with one recursive package and one Vitest worker failed `experimental-remote-runtime.test.ts` on coordinator startup (2282 passed, 1 failed in coding-agent). Earlier parallel runs exposed footer/CLI startup failures; those are retained, not waived. No more broad retries or unrelated production fixes were made.
- Integrated Gateway lint, formatting and build pass. Full isolated `pnpm test`: **247 passed, 1 paired-only skipped**. The skipped terminal test is not counted as a pass: the explicit candidate-CLI command separately executed **both paired tests successfully (2 passed)**.
- Paired CLI SHA256: `b3122f6ef5c9cfe7d23d90b7edf421d3d9b4cca22b4dcc1cb45ef887f0929909`. Its source is Pi baseline head `a2357f1b7c8db4e70e92eb474f38df3c6b67a12a` plus the reviewed, still-uncommitted guarded-admission patch; this is **not an accepted Pi commit or paired-head CI result**. Private evidence retains the full source manifest and build transcript.
- Gateway ordinary CI checks old lockfile-Pi rejection, not the paired candidate heads. PR metadata records exact Gateway head CI separately. Pi pending commit/PR remains blocked by the mandatory full gate; Gateway depends on that Pi capability and is not ready for deployment. No check exemptions, dependency upgrades, main merge, deployment or production acceptance are claimed.
