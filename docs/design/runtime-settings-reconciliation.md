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
- Gateway serializes background reconciliation with request admission, checks
  the latest desired selection after awaits, and writes the prompt without an
  await after its final desired-state check. A later selection is pending for
  the next request. `prompt.expectedSettingsRevision` guards native acceptance;
  only `success: true, accepted: false` with `busy` / `settings_changed` proves
  non-acceptance, before any effectful extension hook/command. Pi reserves guarded
  admission before hooks. A subsequent preflight failure or revision conflict
  returns a single `success: false` response (no earlier successful ACK), never
  `accepted: false`. Successful preflight returns `accepted: true`; this is
  admission, not successful execution. Errors, missing/malformed ACKs and
  post-admission failures are terminal/non-replayable in Gateway.
- Definitively unsent/rejected input keeps its existing DB row pending. Sent
  input with an uncertain response is never automatically replayed. User log
  insertion occurs at input consumption, not on every pending admission attempt.
- A changed selection also prevents new steering into the old selected run;
  already accepted steering retains its existing consumption/uncertainty rules.
- No settings failure invokes stop, clears queues, rotates sessions or kills
  processes. Explicit stop/shutdown retains its separate existing behavior.

## Parent versus child work

Parent activity includes prompt preflight, runs, retries, compaction and native
continuations; the Pi capability owns this proof. An independent child can keep
running while the idle parent's model changes in place. This does not change the
child's model/runtime or destroy its process or delayed result delivery. Parent
idle is **not** evidence permitting process retirement.

Executable, working-directory and extra-argument changes remain explicitly
pending: full child/background idleness is not available, so Gateway does not
retire the retained process automatically. Resetting to an unknown implicit Pi
default also remains pending; choose an explicit model/thinking selection to
reconcile it. Omitted native transaction fields mean retain, not reset.

## Compatibility and compaction

An older Pi without `guardedSettings` retains the prior prompt behavior only
while desired launch identity is unchanged. A changed identity stays pending
with an upgrade-needed status, with no unsafe mutation or restart fallback.
Reverting to the original identity permits legacy admission again. This does
not claim effective-model/revision verification on legacy Pi.

There is no Gateway compact command endpoint. Compaction remains native prompt
preflight on the authoritative retained connection. The enclosing timeout stays
at ten minutes for Pi's eight-minute job; duplicate events do not renew it.

Tests cover the native wire contract with synthetic subprocesses and the real
Gateway queue, plus malformed/uncertain transaction responses. A paired native
Pi build implementing the capability and independent review remain integration
gates; mock success is not proof of native atomic admission or live recovery.
