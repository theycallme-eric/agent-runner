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

## 2026-08-30 — Isolated worker boundary and Fable probe

- Added a model-neutral worker interface, a Claude Code JSON adapter, an isolated Git worktree
  manager, and a fixture runner. Deterministic tests use a fake worker; normal verification never
  calls a paid model.
- Added exact-base worktree tests and fail-closed handling for worker-process failures. The local
  suite now has 17 tests.
- Claude Code `2.1.2` has no `auth status` subcommand. Invoking those words treated them as a prompt;
  the session completed without edits. Future probes must always use explicit `--print`, model,
  tools, output, permission, persistence, timeout, and budget arguments.
- A first no-tools local-headless probe used model `fable`, permission mode `dontAsk`, no session
  persistence, a 120-second timeout, and `--max-budget-usd 0.10`. Version `2.1.2` returned a model 404
  with reported cost `$0`.
- `claude update` installed `2.1.251` in the user npm prefix, but the shell still resolves an older
  `/usr/local` installation first. The adapter now supports an explicit executable through
  `AGENT_RUNNER_CLAUDE_BIN`; the duplicate installation is not silently ignored.
- The same local-headless probe against `2.1.251` reached Fable but failed while loading inherited
  pre-upgrade MCP OAuth state. It reported estimated cost `$0.664715` despite the `$0.10` stop value.
  No files were edited. Real model calls were stopped immediately.
- Initial interpretation treated that estimate as possible spend. Anthropic's current cost guidance
  says Max/Pro usage is included in the subscription and the session dollar figure is not relevant to
  billing. The local environment has no `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or
  `CLAUDE_CODE_OAUTH_TOKEN` override, so Claude Code falls back to the existing subscription OAuth
  login. This corrects the spend interpretation; the estimate still shows that the stop flag can
  overshoot within a request.
- Safety decision: keep unattended real workers disabled only until settings/MCP isolation and plan
  quota/concurrency handling are proven. Max subscription authentication is a supported worker path.
- Official Claude documentation confirms that filesystem setting sources must be explicitly selected
  and that `max_budget_usd` stops on a client-side estimate. Updated the adapter to use an explicit
  setting-source list, strict empty MCP configuration, no browser or slash commands, disabled
  auto-memory, a turn limit, and a wall-clock timeout. The isolation arguments are covered by a fake
  executable test; no second paid probe was made.
- Next open decision: finish the isolated Max-authenticated worker probe, add plan-quota-aware
  concurrency handling, then publish a disposable draft PR through a fixture GitHub repository.

## 2026-08-31 — Public and agent-neutral boundary

- User selected public visibility for the reusable Agent Runner repository and clarified that Fable
  is CLEAR's initial worker, not a controller dependency.
- Audited the worker boundary before publication. The shared request still contained Claude-only
  fields such as model, dollar budget, turn limits, tools, and setting sources.
- Moved those fields into `ClaudeCodeWorker`. The lifecycle core now passes only workspace, prompt,
  and wall-clock timeout through `WorkerAdapter`.
- Added a versioned JSON process adapter so any coding-agent CLI or SDK wrapper can participate
  without modifying project contracts or controller state. Added deterministic protocol coverage;
  the suite now has 18 tests.
- Public repository target: `https://github.com/theycallme-eric/agent-runner`. No license was selected
  implicitly; public visibility and open-source licensing remain separate decisions.
