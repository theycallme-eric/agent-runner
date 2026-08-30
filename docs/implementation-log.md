# Implementation log

Concise chronological handoff for humans and coding agents. Record material changes, failed
approaches, corrections, verification evidence, and the next open decision. Do not copy chat
transcripts or secrets here.

## 2026-08-29 — Boundary and landscape

- Kept CLEAR mid-flight and created this standalone repository for reusable orchestration.
- Chose a standalone controller plus a small versioned project contract; CLEAR will become the first
  dogfood adapter only after fixture tests pass.
- Surveyed current specification, worker, ledger, and orchestration projects. The conclusion was to
  compose existing tools and build only the missing project-level delivery control plane.
- Corrected the mental model around Fable: Fable is a Claude model selected by Claude Code, not a
  separate controller or executable.
- Deferred the remote repository and license choice so the architecture spike would not imply a
  distribution decision prematurely.

## 2026-08-30 — First executable reliability slice

- Added a strict `.agent-runner.yml` parser that rejects unknown fields and enforces `merge: never`.
- Added a durable SQLite run ledger with database-enforced task-revision uniqueness, leases,
  heartbeats, stale-lease reclamation, retry budgets, lifecycle validation, and audit events.
- Added a controller simulator that independently verifies worker output, re-verifies after the base
  advances, stops protected-path changes at a human gate, and fails closed on CI errors.
- Added a disposable fixture project and 11 deterministic tests covering the initial failure cases.
- Initial test execution used `tsx`; it failed in the restricted environment because its launcher
  attempted to create an IPC socket. Replaced it with compiled Node test files, removing the socket
  dependency and reducing the development toolchain.
- Evidence: `npm run verify` passes all 11 tests; `npm run validate:fixture` accepts the fixture and
  reports a `never` merge policy.
- Next open decision: connect one fixture issue to an isolated real worker and compare adopting an
  existing controller against extending this thin ledger.
