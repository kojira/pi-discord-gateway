# Issue #14: 非同期子処理を残したRPC接続の早期終了を防ぐ

状態: 設計提案。実装・配備は未着手。§10の承認と依存解消までは実装着手可能と扱わない。

対象: https://github.com/kojira/pi-discord-gateway/issues/14

正本: `design/issue-14-rpc-lifetime` ブランチの本Markdown。Issueや運用文書にはリンクだけを置く。

## 1. 問題と確認済みの根拠

2026-09-11 11:22:36 UTC、親がレビュー開始を報告して応答を終えた直後、Gatewayのagent settledと同時刻に子workflow 2件が停止した。約45秒の実行で結果なし、停止runは再開不可だった。

確認対象はGateway `b425230`（PR #13のmerge）、Pi `38960b0b3`（merge `4c6fce24d` と同じtree）、pi-subagents 0.64.0。

- Gateway `src/agent/invoke.ts` は `agent_settled` で `settleInvocation()` を呼び、stdinを閉じる。
- Pi `packages/coding-agent/src/modes/rpc/rpc-mode.ts` はstdin EOFからruntimeをdisposeする。
- pi-subagents `src/extension/index.ts` のsession_shutdown cleanupは実行中workflowのcontrollerをabortする。
- RPCはExtension UI contextを持つため `ctx.hasUI === true`。同拡張のagent_end auto-drainは `!ctx.hasUI` の場合だけで、RPCでは動かない。
- `src/runs/background/auto-drain.ts` はrun状態・provider状態を待つ。`subagent-wait.ts` の戻り値は、通知がまだ見えていない可能性を明記する。
- `src/runs/background/notify.ts` はイベントバスを観測用とし、delivery acknowledgementとは区別している。したがってrun完了イベントやファイルだけを見て接続を閉じるのも不十分。
- 公開 `pi-subagents/background-work` APIのsnapshotはproviderのactive workを返すが、auto-drainはこれに加えて内部のasync run一覧も読む。公開snapshotだけを全子処理の正本として流用しない。

再起動・EOFによる明示終了を禁止するのではなく、**親モデルの一時的idleを、子処理と結果回収を含む接続の終了許可に使っていること**を直す。

## 2. 要件・非対象

### 要件

1. 親が一旦idleになっても、受け付けた子処理を停止しない。
2. 子の成功・失敗・キャンセル結果を、追加user入力なしで元の親へ渡し、親の後続処理まで接続を保つ。
3. 結果待ち中もDiscordからの追加入力とsupervisor対応を受け付ける。
4. abort、Gateway shutdown、制限時間切れは明示的な中断として処理し、正常完了に見せない。
5. `agent_settled` は従来どおり親AgentSessionの物理的idleを表す。LLMの完了判断は引き続き `finish_work` が担う。
6. 別セッションのrunを数えたり停止したりしない。tool・provider job・通知を再実行しない。

### 非対象

- 再起動後の自動再開、永続outbox、新しいジョブDB、常駐RPC pool。
- Issue #14と無関係なchordテスト修正。
- 認証・Bot identity・モデルの変更、mainマージ、配備。
- インストール済みpi-subagentsへの直接patch。
- 管理外の任意プロセスを自動検出して保護すること。新しい寿命APIに参加する処理だけを保証対象にする。

## 3. 採用方式

Piにセッション単位の**作業保留（lease）**と、RPCの**終了確認**を追加する。leaseは、実行中の子処理だけでなく、親への結果投入がまだ済んでいない処理も表す。

```text
子の起動前にlease取得
  → 子を実行
  → 結果を保存
  → 親のメッセージqueueへ投入 ＋ lease解放（Pi内で不可分に実行）
  → 親が結果を処理
  → 接続終了可能イベント
  → Gatewayのclose_if_quiescent
  → Piが再検査して終了を確定
```

Gatewayにpi-subagentsの内部ファイル走査やrun判定を複製しない。Piと拡張が寿命の正本を持ち、Gatewayは公開された接続状態だけを扱う。

`hasUI`を偽にする案は採らない。UI能力と接続寿命は別概念であり、auto-drainだけでは結果投入完了の境界も保証できない。

## 4. Pi/拡張間の契約案（新規API）

以下の名前・APIは設計上の新規追加であり、現行APIとして存在するという意味ではない。

### 登録

`pi.backgroundWork.acquire({ id, kind, timeoutMs, cancel }) → handle`

- extension instanceと現在のセッションに自動的に帰属させる。呼び出し側に別sessionIdを指定させない。
- idは同一extension・同一session内で一意、長さ1–256文字。重複登録は拒否。
- handleはモデルやRPCへ公開しないプロセス内の識別子。別extensionのhandleは使用できない。
- 必ずspawn/provider dispatchより前に登録する。登録失敗なら起動しない。
- 起動失敗も下記delivery経路でfailureを渡す。空の成功releaseで隠さない。
- timeoutMsは正の整数、未指定は30分。既存の明示run timeoutがある場合は短い方を使う。この管理モードでは無期限workflowを許可しない。

### 結果投入

`pi.backgroundWork.deliver(handles, message) → { deliveryId }`

- messageは既存のsubagent結果通知と同じcustom message。成功・失敗・キャンセルを含む。新しい合成user発話は作らない。
- 同一セッションのhandleに限定し、grouped completionは複数handleを1通知にまとめられる。
- Piがcustom messageをfollow-up queueに受理する処理と、対象leaseの解放を同じ同期処理内で確定する。両者の間にawaitを挟まない。
- 受理失敗ならleaseは残り、拡張側の保存済み結果も削除しない。結果ファイルの削除/既読化は受理成功後。
- 受理済みhandleの再deliveryは同じreceiptを返し、再enqueueしない。receiptはその接続の寿命だけ保持する。
- leaseが0になっても、queueが残る間は終了可能にしない。親は既存のfollow-up経路で処理する。
- session切替・終了後の古いhandleは失敗を返す。新しいセッションへ流用しない。

### 中断

- cancelは当該処理の所有者が実装し、親からのabort/shutdown時にのみ呼ぶ。登録順やプロセス名で無関係な処理を止めない。
- deadline超過も明示的中断。cancel猶予は10秒。成功・確認不能を区別して保存し、Gatewayへ構造化したfailureを返す。
- 中断確認不能を「完了」にしない。外部jobが残り得る場合はjob/run IDを残す。再launchはしない。
- 主たる結果deliveryを待っている時間もleaseのdeadlineに含める。通知故障で無期限に接続を保持しない。

## 5. RPCの契約案

### 利用開始と互換性

- 新規CLI opt-in `--rpc-managed-lifetime` を設ける。RPC以外ではusage errorにする。
- `get_state` に `capabilities.sessionLifetime: 1` を追加する。Gatewayは最初のpromptより前に確認する。
- Gateway側も明示設定 `PI_RPC_MANAGED_LIFETIME=true` で有効化する。既定falseで段階導入する。
- 有効設定なのにPiが未対応ならpromptを送らず明確な構成エラー。従来の早期終了へ黙ってfallbackしない。
- 管理モードを使わない既存RPC clientの挙動は変更しない。raw EOFは従来どおりshutdown。

### 状態イベント

`session_lifetime { version:1, sessionId, revision, phase, pendingWork }`

- phase: `busy | background | quiescent | closing`。
- revisionは接続内の単調増加整数。入力受理、run開始/終了、lease登録/解放、結果enqueue、終了確定で増やす。
- sessionIdは接続先のPi session identity。Gatewayは自分のセッションと一致するものだけ処理する。
- `quiescent` 条件は、親runなし、入力/結果queueなし、処理中イベントhookなし、leaseなし、受理済みRPC prompt処理なしのすべて。
- 状態評価はAgentSessionのpost-run処理とイベント配送が済んだ境界で行う。runのstop直後だけで決めない。
- backgroundは「子処理または結果投入待ち」。これを最終完了としてDiscord/webhookへ出さない。

### 終了確認

Gateway → `close_if_quiescent { id, sessionId, revision }`

Pi → `response { id, command:"close_if_quiescent", success:true, data:{closed:boolean, revision} }`

- session/revisionが現在値と一致し、かつquiescentの場合だけclosed=true。
- Piは検査とclosingへの移行を不可分に行う。ackをflushした後、自身でruntimeをshutdownする。
- 条件不一致ならclosed=falseと最新revision。Gatewayは接続を残し、新しい状態イベントを待つ。busy loopしない。
- closing確定後のprompt/steerは `success:false, code:"SESSION_CLOSING"` で拒否し、queueへ入れない。
- Gatewayは「未受理」が確定した入力だけを新しい接続へ渡せる。受理済み・応答不明の入力は自動再送しない。
- Gatewayは管理モードでは `agent_settled` でstdinを閉じない。closed=trueまたは明示shutdownのときだけ結果を確定する。

## 6. pi-subagentsの参加条件

既存のstart/completeイベントはdelivery acknowledgementではないため、それだけを観測する外付けadapterは採用しない。

正式な拡張対応が必要:

- async/workflowのroot起動前にlease取得。workflow内の子ごとにGatewayのleaseを増やさず、親workflowが結果を引き渡すまでrootを保持する。
- `notify.ts` / `result-watcher.ts` の受理判定をPiのdelivery receiptに接続する。grouped completionを保つ。
- 成功・failed・partial・cancelledを同じ受け渡し経路へ載せる。
- supervisor/needs-attention通知は親を起こせる既存経路を維持し、まだ終わっていないroot leaseは解放しない。
- 外部providerへの単発委譲もroot leaseで覆う。別extensionが単独で起動するjobは、そのextension自身の参加が必要。
- 管理モードでは既存headless auto-drainと二重待機しない。RPCのlease契約を使い、print modeの既存auto-drainは維持する。
- pluginのreload/session切替時は、active leaseがある間は通常操作を拒否。明示abort→取消確認→切替の順序とする。

導入条件はAPI互換性を確認したPiと拡張の組。既存0.64.0を対応済みと扱わない。

## 7. Gateway・利用者の挙動

- 元のDiscord要求の処理slotは背景処理と後続応答まで維持する。新しいpool・queueは作らない。
- 同じチャンネルの追加発話は既存steer経路へ渡す。supervisor requestの取り扱いも維持する。
- 他チャンネルの同時実行数は従来の上限に従う。子待ちがslotを占有する点は意図した仕様で、並列数の自動拡大はしない。
- 親の一時的idleではtraceを「親はidle／子処理待ち」とし、invocation完了の表示・最終flushは行わない。
- 結果投入後の親応答は既存onAssistantMessageで届け、最終summaryの二重配信防止も保つ。
- `finish_work` の完了判断と接続終了は分ける。finishが受理されてもleaseやqueueがあれば接続は閉じない。後続結果の応答が古いsummaryに隠れない既存修正を維持する。
- 親がactive契約のまま文章だけで終了した場合のprotocol errorを、この仕組みで正常完了に書き換えない。結果待ちの接続保護とは別にエラーを記録する。
- 永続スキーマ移行・画面追加・権限昇格はない。追加は設定、RPCメッセージ、プロセス内状態とtraceのみ。

## 8. 失敗・競合・復旧

| ケース                       | 決定                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| 子が一瞬で完了               | spawn前lease取得で取りこぼさない                                                   |
| run完了後に通知が遅れる      | leaseを残し、Gatewayは接続を保つ                                                   |
| queue投入直後にleaseが0      | queueありなのでquiescentにしない                                                   |
| quiescent通知後に入力・新run | revision不一致でcloseを拒否                                                        |
| 終了確定後に新入力           | SESSION_CLOSING、未受理の場合のみ次接続へ                                          |
| 子の失敗・部分成功           | 保存済み状態を親へ渡す。成功文へ変換しない                                         |
| lease timeout/通知故障       | 所有者へ取消、猶予後は確認不能も含めfailureとして表示                              |
| GatewayのSIGTERM             | 新規受付停止→所有処理へabort→既存shutdown期限で終了。残作業を成功扱いしない        |
| Pi crash/通信断              | invocation失敗。受理不明の要求・tool・runは再送しない                              |
| 親session変更/reload         | leaseありなら通常操作拒否。明示取消後に実行                                        |
| Gateway再起動                | 新RPCセッション。古いleaseは復元しない。既存run artifactを残し、人が再開可否を判断 |

キャンセル記録や既存run artifact以外の新DBは不要。ロールバックはidle確認後に対応前のPi/Gateway/拡張へ同時に戻し、管理モードを無効化する。処理中の降格はしない。

## 9. 変更箇所・受入

### 想定変更箇所

- Pi: Extension API/types/runner、AgentSessionのqueue・settlement境界、RPC mode/types、CLI args/main、RPC/SDK docs。
- pi-subagents正式ソース: async/workflow起動、completion通知の受理、取消、モード判定。
- Gateway: config、agent/invoke、RPC結果型・trace、必要なqueue接続部分、設定説明。

### 受入条件

1. 遅い子2件を起動し親が一旦idleになっても、子は完走し、追加user入力なしで親が結果を返す。EOFはその後の終了確認まで発生しない。
2. 子をterminalにした後、通知だけを意図的に遅延させても接続が残る。
3. grouped completion、即時完了、結果の重複deliveryを検証。親への通知とtool実行は一度だけ。
4. 子待ち中のsteer、supervisor対応、新しい子の追加を検証し、古いrevisionで閉じない。
5. 子failed/partial/cancelled、deadline超過、cancel確認不能で、正常完了表示にならない。
6. abort/shutdown時は終了可能。別sessionの子は停止しない。受理不明の要求を再送しない。
7. 管理モードoff、従来RPC UI client、print、compaction継続、finish_workの既存テストを壊さない。
8. 対応拡張を使った実RPC統合試験を行う。mockイベントだけの成功を実機受入の代用にしない。

通常テストはfaux/制御可能な子プロセスで有償APIを使わない。統合試験は隔離session/cwdで行い、既存セッションや運用DBを試験データにしない。配備・本番受入は別承認。

## 10. 実装前の判断・未解消依存

**この提案は設計レビュー・実装承認待ち。現行のままGatewayだけ直せる設計ではない。**

1. PiとGatewayに上記API/終了確認を追加する範囲の承認。
2. pi-subagentsの正式ソース側でlease/delivery receiptへ参加する対応が必要。現行運用指示は「pi-subagentsを直接patchしない」なので、勝手に編集しない。正式な上流対応を待つか、管理されたソースでの変更を別途許可するかを決める必要がある。インストール先の直接patchはどちらでも行わない。
3. 30分既定deadline、子待ち中のslot占有、session切替拒否という利用者に見える仕様を確認する。

上記が決まるまで実装・依存追加・配備は開始しない。設計の独立レビューはまだ実施していない。新しい事実でこの契約が成り立たないと判明した場合、先に本Markdownを改訂してから進める。
