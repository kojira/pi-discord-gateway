# D-000001 — pre-dispatch instruction (repository copy)

This is an **after-the-fact repository copy** of the pre-dispatch instruction recorded outside Git in the gateway session artifact `ci-implementation-instruction.md`. The original external artifact was written before this implementation dispatch; this Git copy was not. CI checks the reference format only and cannot verify that timing or the owner's identity. Review the original record and approval in context.

Phase: IMPLEMENT. The owner approved the Japanese design with “ok” and clarified that waiting for a separate implementation-start instruction after approval was nonsensical. That approval also starts implementation; the owner approval permalink belongs in the implementation PR.

Instruction to child: Implement D-000001 against the approved Japanese design `docs/design/design-id-enforcement.md` (design commit `200425a968a9f817c8d1092f1a8d80ce0c6fab39`). Build a reusable Pi skill and PR CI checker without modifying Pi, check ID, prior design commit, instruction/approval references, first `Design-Phase: IMPLEMENT` marker, and reject design edits from that marker onward. Do not edit the design document, change other repositories or global Pi configuration, merge to main, or deploy. Limit work to shared artifacts, minimal repository integration and focused tests. Review the PR before any merge.
