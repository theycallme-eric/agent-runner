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

## 2026-08-31 — Multi-project controller and DAG planning

- Corrected the work sequence after prematurely asking for a consumer project's location. Agent
  Runner must be built and proven against repository-owned fixtures before a real project is needed.
- Added a durable multi-project registry. Project path, enabled state, contract version, and worker
  profile belong to controller state; worker/model choices remain absent from product contracts.
- Removed the hard-coded GitHub restriction from the contract parser. Task-provider and dependency-
  resolver identifiers now select controller-installed plug-ins.
- Added deterministic DAG validation and readiness: duplicate tasks or edges, missing dependencies,
  self-dependencies, and cycles fail closed; pending work is ready only after all prerequisites finish.
- Added atomic per-project concurrency enforcement in the same SQLite transaction as a task claim.
  Separate controller connections cannot over-claim the declared capacity.
- Added `register`, `projects`, and `status` CLI flows. Registration reads a project's standard
  contract and is idempotent without copying or rewriting the project.
- Evidence: 30 deterministic tests pass, including two independent projects using different task
  providers and worker profiles, registry restart persistence, repeated planning, and cross-process
  capacity enforcement.
- Next open decision: implement concrete GitHub task and dependency adapters, then connect a
  repository-owned fixture task to the existing workspace/worker/verification path.

## 2026-08-31 — GitHub issue and native-dependency adapters

- Confirmed against current GitHub documentation that `blocked_by` and `blocking` are first-class
  issue relationships available through REST, GraphQL, and `gh`; dependency markers in issue bodies
  are unnecessary.
- Added a mockable `gh api` client with explicit API version `2026-03-10`, pagination, schema
  validation, pull-request exclusion, and bounded output.
- Added GitHub issue normalization and native `blocked_by` resolution. Closed `not_planned` issues,
  explicit `agent:blocked` labels, missing dependencies, and cross-repository edges fail safely.
- Added provider-owned `tasks.config` and GitHub `includeLabels`, keeping selection policy out of the
  controller core. Agent Runner's own contract selects `agent:task` issues.
- Added the read-only `ready` CLI flow and a fake-`gh` end-to-end CLI test. The deterministic suite now
  has 38 tests and never calls GitHub during verification.
- Created `agent:task` and `agent:blocked` repository labels plus the first real two-task graph:
  [RUN-01](https://github.com/theycallme-eric/agent-runner/issues/1) and
  [DELIVERY-01](https://github.com/theycallme-eric/agent-runner/issues/2), with DELIVERY-01 natively
  blocked by RUN-01.
- Registered Agent Runner itself in an ignored local controller database with the `claude-fable`
  worker profile. A live read-only refresh returned RUN-01 ready, DELIVERY-01 waiting, no blocked or
  completed tasks, and exactly one edge. This proves the public GitHub graph agrees with controller
  normalization; it does not yet prove execution.
- Next open decision: connect claim → isolated workspace → selected worker → independent verification
  for RUN-01. Draft pull-request publication remains the dependent DELIVERY-01 task.

## 2026-08-31 — Claim-to-verified-workspace execution

- Added a controller-owned worker-profile registry and concrete execution service. A claimed task now
  becomes an exact-base isolated worktree, runs trusted setup commands, invokes only `WorkerAdapter`,
  runs required verification outside the worker, and records a locally committed verified head.
- Added durable workspace, branch, worker profile/name/status/model/session/summary/duration/cost, and
  command evidence without putting agent/model configuration in the project contract.
- Added `verified` as the explicit handoff between implementation/verification and pull-request
  delivery. Protected-path changes stop at `waiting-human`; automatic merge remains impossible.
- Initial execution wiring heartbeated the lease during the worker but not during potentially long
  setup or verification commands. Corrected all long-running phases to use the same lease guard.
- The concrete executor fails closed if the registered profile is missing, workspace creation or setup
  fails, a worker crashes/times out/reports success without changes, verification fails, the base
  advances, or the final workspace is dirty or empty.
- Evidence: the deterministic suite has 44 tests, including full planner → claim → real Git worktree
  → fake worker → shell verification → committed head coverage, persisted session evidence, worker
  crash/no-change rejection, verification failure, protected-path gating, and base-advance rejection.
- Next open decision: implement DELIVERY-01 as idempotent draft-pull-request publication, then expose
  the joined path through controller profile configuration and an explicit run command.

## 2026-08-31 — Idempotent draft pull-request delivery

- Published RUN-01 in commit `f80ea25`, closed the corresponding GitHub issue with evidence, and
  re-read the live DAG. GitHub then reported RUN-01 completed and DELIVERY-01 ready with the same one
  dependency edge, proving the repository-owned graph advanced rather than being manually reordered.
- Added a provider-neutral `PullRequestPublisher` and delivery coordinator. Only a clean, non-empty,
  verified workspace at the still-current base may reach publication; protected paths remain gated.
- Added durable pull-request provider/id/URL/branch/base/head/draft/CI evidence. Publication and CI
  observation errors remain retryable because a controller can stop after the remote side succeeds
  but before local persistence.
- Added a GitHub publisher that verifies and pushes the exact head, creates or reconciles one open
  pull request per runner branch, forces that runner-owned pull request back to draft when necessary,
  updates its description, and normalizes required check buckets. It has no merge operation.
- Added restart/idempotency evidence: a simulated post-create controller failure recovers the same
  external pull request, repeated CI polling never creates a duplicate, failed CI cannot complete,
  and a non-draft response fails closed.
- Evidence: 52 deterministic tests pass, including a fake `gh`/`git` integration that creates once,
  reconciles twice, pushes the verified head, and reports required CI without network access.
- Next open decision: load controller-owned worker profiles, join plan → execute → deliver in a
  one-shot command, then publish a real repository-owned dogfood draft pull request through it.

## 2026-08-31 — Controller-owned worker profiles

- Closed DELIVERY-01 after publishing commit `a319edd`, then expanded the real GitHub DAG. PROFILE-01
  is ready; CLI-01 waits on it; RECON-01 waits on CLI-01; AUTO-01 waits on reconciliation; and the
  first live DOGFOOD-01 PR can run in parallel after CLI-01. The live graph reports two completed,
  one ready, four waiting, and five edges.
- Added a versioned local worker-profile loader for `claude-code` and the agent-neutral JSON process
  protocol. Project registration keeps only the selected profile id; product contracts still contain
  no worker, model, authentication, or quota settings.
- Added environment-variable references resolved only in memory. CLI profile listing exposes source
  variable names and adapter/model metadata but never resolved values. Inline values and missing
  variables fail closed.
- Added strict schema, duplicate-key, adapter, executable, profile-id, setting-source, numeric-limit,
  and unknown-field validation. Executables are spawned directly and shell syntax is rejected.
- Extended the Claude adapter with profile-owned environment overrides while retaining strict MCP,
  browser, session, and setting-source isolation.
- Evidence: 55 deterministic tests pass. Both configured adapter types execute against fake binaries;
  a sentinel secret reaches each process but is absent from profile summaries and CLI output.
- Next open decision: publish PROFILE-01, then implement CLI-01 by joining the existing planner,
  executor, delivery coordinator, profile loader, and GitHub adapters behind `run-once`/`--dry-run`.

## 2026-08-31 — Joined one-shot controller command

- Added delivery-provider selection to the project contract and a provider-neutral publisher
  registry. It defaults to the task provider for existing v1 contracts but may be selected explicitly.
- Added `run-once`: it loads one registered project and local profile, refreshes the remote base,
  validates the live DAG, atomically claims up to an explicit limit and project concurrency, runs
  claims through isolated execution/verification, and publishes or reconciles draft pull requests.
- Added `--dry-run`, which inspects the same remote base, DAG, worker profile, and delivery adapter but
  cannot claim, create a worktree, launch a worker, push, or publish.
- The first wiring used the local base-branch ref and inspected the live graph once before asking the
  planner to inspect it again. That could treat a stale local branch as current and introduce drift
  between the reported and claimed snapshots. Corrected it with a remote-base provider (`ls-remote`
  for inspection, explicit fetch for execution) and one graph read per mutating plan.
- Added bounded claim limits below project concurrency. New claims execute independently; any task or
  delivery failure leaves a complete structured batch result, sets `ok: false`, and exits non-zero.
- Repeated task revisions at `verified`, `pr-open`, or `ci` now re-poll/reconcile the persisted draft
  without relaunching a worker. Broader stale-run recovery remains RECON-01.
- Evidence: 59 deterministic tests pass. The full CLI fixture uses a real local Git remote/worktree,
  fake GitHub issue/PR/check APIs, and a fake JSON worker to prove dry-run isolation, remote-base
  fetch, one claim, independent shell verification, one draft PR, pending CI, and a later no-worker
  reconciliation to passing CI without another PR.
- Next open decision: publish CLI-01, configure the local `claude-fable` profile, run a live dry-run,
  and execute DOGFOOD-01 as the first real repository-owned draft pull request.
- Live preparation exposed two simultaneously ready tasks: deterministic `--limit 1` would select
  RECON-01 before the intended documentation-only DOGFOOD-01. Added explicit `--task <id>` selection
  with ready-state validation rather than changing labels, dependencies, or relying on issue order.
