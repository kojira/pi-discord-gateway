# LLM推論区間ごとのsteering集約

## 問題

現在のgatewayは、active run中に届いたDiscordメッセージを750msのquiet windowでまとめてからPiへ`steer`する。しかし、Discordで人が補足を数秒から数十秒おきに送る場合、それぞれが別のsteerになる。

さらにPi RPCを既定の`one-at-a-time` steering modeで起動しているため、同じLLM推論中に受理された複数のsteerも、次のLLM呼び出しへ1件ずつ渡される。その結果、補足ごとにLLM推論と応答が発生し、会話と推論コストが増える。

実ログでは1545 steering batch中1540件が1メッセージだけだった。短時間入力向けのデバウンスは、求める集約単位と一致していない。

## 要件

- 同じLLM推論中にPiが受理したsteerは、到着間隔に関係なく次の1回のLLM呼び出しへまとめて渡す。
- メッセージは受信後すぐPiのdurable steering queueへ送り、固定時間のquiet windowで保留しない。
- 現在のLLM推論が終了した時点を集約境界とする。
- 集約前のメッセージを失わず、既存の受理・消費確認と再キュー処理を維持する。
- メッセージ数、prompt文字数、添付サイズの上限を維持する。
- active runが終了した後に届いたメッセージは、通常どおり次の独立runとして処理する。

## 非要件

- 一定時間内のDiscord投稿を一つの文字列へ連結すること。
- LLM推論終了後に到着したメッセージを、既に開始した次の推論へ遡って追加すること。
- Piのagent lifecycleや`agent_settled`の意味を変更すること。

## 設計

### Piのsteering modeを`all`に固定する

RPC processの起動後、初期`prompt`より先に既存のcommandを送り、成功を確認する。

```json
{ "type": "set_steering_mode", "mode": "all" }
```

このcommandはPiのglobal `settings.json`へ`steeringMode: "all"`を永続化する。これは意図した動作であり、Piscordとinteractive Piの両方で、steerを補足ごとの逐次推論ではなく次の1回の推論へまとめる。必要なら利用者はPi側で`one-at-a-time`へ戻せるが、Piscord invocationは本契約を満たすため再び`all`を設定する。

commandが未対応または設定に失敗した場合は初期promptを送らず、そのinvocationを失敗させる。`one-at-a-time`へ黙ってfallbackすると本設計の契約を破るためである。

Piの`all` modeは、現在のassistant turn終了時にsteering queue内の全メッセージを取り出し、それらをcontextへ追加してから次のprovider requestを1回だけ開始する。メッセージは履歴上の個別user messageとして保持してよい。必要なのは文字列連結ではなく、同じ次回推論へ渡ることである。

### active runのquiet-window待機を廃止する

`dispatchSteeringMessage`はpending messageを検出したら、固定時間待たずに現在取得できる範囲をclaimしてPiへ送る。後から届いたメッセージも同じ推論が続いていればPiのqueueへ追加され、`all` modeによって同じ次回推論へ入る。

これにより、推論終了直前に届いたメッセージが750ms待機中のため集約境界を逃す可能性も減る。

既存のbatch上限は、一度のDB claimとRPC payloadをboundedに保つ目的で維持する。quiet window用の`STEER_DEBOUNCE_MS`と`STEER_DEBOUNCE_MAX_MS`は、本設計では意味を持たず、残すと誤設定を招くため設定・setup出力・利用者向け一覧から削除する。既存環境に残った未知の環境変数は無視される。

## lifecycle

```text
initial prompt
  -> set_steering_mode(all) 成功
  -> prompt開始
  -> LLM推論中
       Discord A -> steer(A)をPiが受理
       Discord B -> steer(B)をPiが受理
       Discord C -> steer(C)をPiが受理
  -> assistant turn終了
  -> PiがA/B/Cを一括drain
  -> A/B/Cを含むprovider requestを1回開始
```

steerの`message_start`を消費確定点としてDB rowを`done`にする現在の契約は変更しない。active runが先にsettleした場合の再キュー・失敗処理も変更しない。

## テスト方針

実装前に、少なくとも次の失敗するテストを追加する。

1. RPC起動時に`set_steering_mode(all)`が初期`prompt`より先に送られる。
2. mode設定が拒否された場合、初期promptを送らずinvocationが失敗する。
3. 同一の長い推論中に間隔を空けて送った複数steerがPiへ個別に受理され、`all` modeの次の1ターンでまとめて消費される。
4. 旧`STEER_DEBOUNCE_MS`が環境に残っていても、active-run steeringが固定時間を待たずにdispatchされる。
5. 既存の消費確認、active run終了時の再キュー、batch上限、shutdown処理が退行しない。

テストはfake PiのRPC会話そのものと、queueの観測可能な状態を確認する。内部実装関数の写しだけをテストしない。

## 配備

PRレビューと検証後、queueに`pending`/`processing`がなく、子Pi processもないことを確認してgatewayを再起動する。本番切替前後で、同じ推論中に数秒以上空けて送った複数メッセージが次の1回の推論へ入ることをDiscord上で確認する。
