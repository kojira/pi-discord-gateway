# Retained runtime settings reconciliation

This supersedes the fixed-launch-model/manual-stop behavior in
`issue-14-rpc-lifetime.md`, not its connection ownership or stop contract.

Persisted channel settings are desired state, not proof of the retained Pi's
current model. Gateway re-reads them during prompt admission and polls retained
connections even when no new input is queued. Slash setters report saved desired
settings separately from the last acknowledged runtime state.

## Admission contract

- Pi advertises `get_state.capabilities.guardedSettings === 1` and a nonnegative
  integer `settingsRevision`. Gateway verifies the effective model/thinking and
  uses `set_runtime_settings` with `expectedRevision` when they differ. Revision
  is process-wide and monotonic across session replacements.
- The combined native transaction checks parent activity and revision after any
  asynchronous auth preparation, before mutating either setting. It replies with
  `applied: true`, the effective model/thinking and revision, or a non-mutating
  `applied: false` with `busy` / `revision_changed`. Gateway never substitutes a
  `get_state` idle snapshot followed by unguarded setters.
- Gateway serializes background reconciliation with request admission.
  Reconciliation also runs while a request is active: Pi applies the pair at its
  next model request and never switches a request that is already streaming.
  Settings that cannot be applied never hold input back. The request is sent on
  the applied selection, guarded by the revision Pi currently reports, and the
  channel gets one line per distinct reason naming the desired selection, the
  reason and the applied selection. The status keeps showing applied versus
  pending with that reason. A selection Pi definitely rejected (for example an
  unknown model) is not resent by background polling; the next request or a new
  selection tries again. `prompt.expectedSettingsRevision` guards native acceptance;
  only `success: true, accepted: false` with `busy` / `settings_changed` proves
  non-acceptance, before any effectful extension hook/command. Pi reserves guarded
  admission before hooks. A subsequent preflight failure or revision conflict
  returns a single `success: false` response (no earlier successful ACK), never
  `accepted: false`. Successful preflight returns `accepted: true`; this is
  admission, not successful execution. Errors, missing/malformed ACKs and
  post-admission failures are terminal/non-replayable in Gateway. A well-formed
  prompt error before user consumption fails only that request and detaches its
  callbacks/abort signal; the connection and independent children stay alive.
  Malformed/uncertain protocol responses retain the separate connection-failure
  cleanup path, never a replay path.
- Definitively unsent/rejected input keeps its existing DB row pending. Sent
  input with an uncertain response is never automatically replayed. Persistent
  user-log insertion occurs at input consumption, not on every pending admission
  attempt. Nonpersistent requests retain their original dispatch-time logging,
  including when Pi input hooks transform the prompt.
- A changed selection does not prevent steering into the active run; accepted
  steering retains its existing consumption/uncertainty rules.
- No settings failure invokes stop, clears queues, rotates sessions or kills
  processes. Explicit stop/shutdown retains its separate existing behavior.

## Parent versus child work

For guarded prompt admission, parent activity includes prompt preflight, runs,
retries, compaction and native continuations; the Pi capability owns this proof.
A settings update is refused as busy only during prompt preflight, compaction and
navigation/replacement/reload. An independent child can keep
running while the idle parent's model changes in place. This does not change the
child's model/runtime or destroy its process or delayed result delivery. Parent
idle is **not** evidence permitting process retirement.

Executable, working-directory and extra-argument changes remain explicitly
pending: full child/background idleness is not available, so Gateway does not
retire the retained process automatically. Resetting to an unknown implicit Pi
default also remains pending; choose an explicit model/thinking selection to
reconcile it. Input keeps flowing to the retained process in both cases, with
the one-line notice above. Omitted native transaction fields mean retain, not reset. Explicit
selections become managed even when the runtime already matches and no settings
mutation is needed; a later implicit reset still requires default resolution.

## Compatibility and compaction

An older Pi without `guardedSettings` retains the prior prompt behavior only
while desired launch identity is unchanged. A changed identity stays pending
with an upgrade-needed status and notice, with no unsafe mutation or restart
fallback; input is sent on the launch settings.
Reverting to the original identity permits legacy admission again. This does
not claim effective-model/revision verification on legacy Pi.

There is no Gateway compact command endpoint. Compaction remains native prompt
preflight on the authoritative retained connection. The enclosing timeout stays
at ten minutes for Pi's eight-minute job; duplicate events do not renew it.

Tests cover the native wire contract with synthetic subprocesses and the real
Gateway queue, plus malformed/uncertain transaction responses. A paired native
Pi build implementing the capability and independent review remain integration
gates; mock success is not proof of native atomic admission or live recovery.
