---
name: design-id-gate
description: Run the design-ID approval and PR evidence workflow for implementation work across Git repositories. Use when an owner requests a feature or a design change requiring an implementation PR.
---

# Design ID gate

This is a work procedure, not a Pi runtime guard. Do not ask the owner to fill out a form or type a special command: treat their normal feature request as the starting point. Do not claim that CI verifies message authorship, pre-dispatch timing, or local work. Only repositories that install the checker in required PR CI are protected.

1. Parent: assign an ID (`D-000001` format), write a Markdown design document with that ID, and commit it before implementation. Show the actual document to the owner, not just a summary. Ask for explicit approval of that design. A contextual “ok” counts; once approved and checks are done, proceed to IMPLEMENT without asking for a second start instruction. Never infer approval from an old message.
2. Before **each** child dispatch (including design/review/follow-ups), parent records ID, phase, and exact request in an instruction log (e.g. issue comment or committed document) and includes its reference and the design in the child request. Only children implement. The skill does not prevent an unauthorized dispatch; review the timing manually.
3. The first implementation commit must modify a non-design file and carry exactly one commit trailer `Design-Phase: IMPLEMENT`. Do not edit the design document in this commit or any later commit in the implementation PR. A design-only PR has no marker and is not an implementation PR.
4. Put the following evidence in the implementation PR body as one line per field (replace values; SHA fields are full hashes):

   ```text
   Design-ID: D-000001
   Design-Path: docs/design/feature.md
   Design-Commit: <full SHA of commit writing this document>
   First-Implementation-Commit: <full SHA of first implementation commit>
   Instruction-Log: https://<direct permalink to log for this ID>
   Owner-Approval: https://<direct permalink to the owner's design approval>
   ```

   References must be real, direct HTTPS permalinks. The reviewer reads both targets and their context; a syntactically valid URL alone proves nothing. Rebase/squash changes SHAs: update the body. If evidence is unavailable, disclose it and keep the PR draft/red, not a fabricated green check.

5. Call the reusable `scripts/check-design-id.mjs` from PR CI, passing the GitHub pull_request event JSON file; the PR body supplies the design path. Fetch complete base/head history and check out the PR head (not a synthetic merge commit). Example invocation: `node scripts/check-design-id.mjs "$GITHUB_EVENT_PATH"`. The checker requires one linear base..head chain, a design commit writing the ID-bearing Markdown and strictly preceding the first implementation marker, exactly one marker, and no design edit at or after it. A PR that _only_ changes Markdown in `docs/design/` and has no marker is reported as design-only, not as an implementation pass. A CI failure blocks merging only when the job is required by branch protection; CI cannot guard a repo without a required workflow.
6. If design must change after implementation begins, stop implementation and ask the owner to return to design. Amend it in a separate design PR, reapprove, then use a new implementation PR. Never move the marker back to bypass a failure. Finishing/merging also needs explicit owner direction; do not deploy or propagate to other repositories automatically.
