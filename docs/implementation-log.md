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
- The first live dry-run then correctly selected DOGFOOD-01 but reported `limitReached: true` by
  counting the unrelated ready task. Corrected dry-run accounting to apply the target filter before
  the limit metric, matching the mutating planner.

## 2026-08-31 — First live worker attempt and permission correction

- The corrected DOGFOOD-01 dry-run passed against remote base `4eeea76`: the target, Fable profile,
  GitHub adapters, graph, and claim limit all validated without a claim or model call.
- The first mutating `run-once` claimed issue #7 and created its isolated worktree. `npm ci` passed and
  the lease heartbeated throughout an 80-second Fable session. Fable read the required documents and
  drafted the requested runbook, but Claude Code denied Write/Edit under headless `dontAsk` mode.
- Fable returned a normal text result describing the block rather than a process error. The controller
  independently found no repository change, failed the run as `worker-no-changes`, and did not run
  verification, push a branch, or create a pull request. This is the intended false-success defense.
- Persisted non-secret evidence: run `465d21ee-d158-447d-9ddf-77d9ef4e72cb`, profile
  `claude-fable`, model `fable`, worker session `0bdcdeb8-f1a9-48aa-a8ad-aecb80fdcafc`, local usage
  estimate `$0.928559`, duration 80.643 seconds, and failure `worker-no-changes`.
- Corrected the profile boundary by making Claude permission mode explicit. `dontAsk` remains the
  fail-closed default; `acceptEdits` permits worktree Write/Edit for implementation profiles;
  `bypassPermissions` is rejected by schema. The local dogfood profile now selects `acceptEdits`.
- Next open decision: verify the permission-profile correction, create a new issue revision so the
  failed immutable run is preserved, and retry DOGFOOD-01 through the same public command.

## 2026-08-31 — First live draft pull request and no-check reconciliation

- Advanced issue #7 deliberately so the failed, immutable first attempt remained auditable, then
  repeated the targeted dry-run against remote base `8ac806c`. It selected only DOGFOOD-01 without a
  claim or model call.
- The second mutating run succeeded through the public `run-once` path. Persisted evidence: run
  `f6e409ca-67a8-4ed3-b63a-d35295f74219`, Claude Code `2.1.251` in local headless print mode,
  model `fable`, permission mode `acceptEdits`, Max-subscription authentication, `$5` client-side
  budget ceiling, worker session `653d41d9-72da-4008-b0e6-acb45a0bb8e1`, local usage estimate
  `$0.768455`, and duration 63.938 seconds.
- The controller accepted only `README.md` and `docs/dogfood-runbook.md`, then independently passed
  `npm run check`, `npm test`, and `npm run build`. It committed verified head `4d64ab7`, pushed one
  runner-owned branch, and created [draft pull request #8](https://github.com/theycallme-eric/agent-runner/pull/8).
- The initial CI observation exposed a forge-adapter edge case: `gh pr checks --required` exits 1
  with `no checks reported` when a repository has no required checks. Publication had succeeded, but
  the controller correctly retained the run at `pr-open` with a retryable delivery failure rather
  than losing the pull-request identity or relaunching Fable.
- Corrected only that exact GitHub response to an empty check set. Authentication errors and other
  code-1 failures still fail closed. The suite now has 60 deterministic tests, including both the
  no-check response and an unrelated command failure.
- Replayed the same task revision. The controller made no worker call, reconciled the same branch and
  pull request, recorded CI as `none`, and advanced the existing run to `ci` with `waiting-ci`.
  `none` is intentionally not treated as passed; the pull request remains draft and unmerged.
- Next open decision: human review of draft PR #8 and implementation of RECON-01 before any unattended
  scheduler is enabled.

## 2026-08-31 — Durable restart and advanced-base reconciliation

- Audited the joined lifecycle against RECON-01. The existing retry path safely prevented duplicates
  but still pushed/edited a persisted draft on every CI poll, and delivery treated an advanced base as
  terminal. Those behaviors were safe one-shot defaults, not restart convergence.
- Added atomic reconciliation leases separate from new-task claims. Live ownership cannot be stolen;
  expired active work reclaims within the configured attempt budget; interrupted synchronization
  preserves its state and consumes a bounded recovery attempt; reconciliation leases are released.
- Split pull-request observation from creation and update. After initial persistence, provider plus
  external id are authoritative. Pending CI is polled without another push/edit. Missing, non-draft,
  changed-head, closed, merged, or identity-drifted pull requests fail visibly instead of being
  replaced or silently changed back.
- Added checkpointed advanced-base synchronization. The controller records the new base and required
  reverification, merges it into the isolated worktree, aborts and restores on conflict, reruns every
  required verification command with lease heartbeats, re-applies protected-path gates, and updates
  the same draft only after the synchronized head passes.
- `run-once` now reads one live DAG snapshot, reconciles every nonterminal project run first, then
  claims from that same snapshot. Structured output includes lease, workspace, worker session,
  branch, pull-request, CI, base, and failure classifications.
- Evidence: `npm run verify` passes with 70 deterministic tests. Coverage includes real Git clean
  synchronization and conflict restoration; live-lease refusal; expired-attempt exhaustion; missing
  workspaces; closed/merged drafts; advanced-base reverification; same-draft update; and later CI-only
  polling with no worker, publish, push, or edit.
- Next open decision: publish RECON-01, exercise it against live draft PR #8, then implement AUTO-01's
  explicitly enabled bounded multi-project loop and morning report.

### Live reconciliation preflight

- A read-only three-way merge preview found that main's new reconciliation link and PR #8's dogfood
  link were independent insertions at the same README table location, which Git would report as a
  content conflict. Running the controller knowingly would have failed the immutable dogfood run.
- Applied the already-approved dogfood link to main as the human conflict resolution before the live
  pass. The synchronized PR can therefore retain the substantive runbook file while the controller
  remains forbidden from guessing through merge conflicts.
- A second preview showed the older PR also lacked main's adjacent reconciliation link. Chose a
  two-stage resolution: temporarily leave that page unlinked, synchronize the dogfood branch, then
  restore the link and exercise a second clean base synchronization. This avoids rewriting persisted
  PR identity or weakening conflict detection.
- Stage one live evidence: the existing run `f6e409ca-67a8-4ed3-b63a-d35295f74219` moved from base
  `8ac806c` to `22a062d` and verified head `f29af72`. The same workspace and Fable session were
  retained; no worker ran. `npm run check`, `npm test`, and `npm run build` passed after the merge.
  The controller updated draft PR #8 by persisted id, reduced its task diff to
  `docs/dogfood-runbook.md`, observed CI `none`, released its lease, and created no claim or PR.
- Stage two restored the reconciliation link on main and advanced the same durable run to base
  `b290982` and verified head `595e430`. The controller again reran all three required commands,
  updated PR #8 in place, retained its draft state, and made no worker call or claim.
- A third pass at the same base performed observation and CI polling only: base classified `current`,
  execution `not-run`, the persisted workspace/session/branch/PR all matched, and CI remained `none`.
  GitHub reported PR #8 open, draft, cleanly mergeable, and containing only
  `docs/dogfood-runbook.md`. No automatic merge or completion was attempted.
- RECON-01 exit: deterministic verification plus live repeated convergence now satisfy the restart,
  identity, base, reverification, conflict, and CI-polling gate. AUTO-01 is the next controller layer.

## 2026-08-31 — Bounded multi-project autopilot

- Added an agent- and project-neutral scheduler over the existing `run-once` controller. Every pass
  visits enabled registered projects in stable order, reconciles before claiming, and requests at
  most one new claim at a time. It does not duplicate lifecycle or delivery logic.
- Added explicit invocation bounds for deadline, total new claims, consecutive no-progress passes,
  poll backoff, and lease duration. Human gates, worker unavailability, quota/rate-limit evidence,
  and run failures stop the loop. The first version rejects global concurrency above one.
- Added the public `autopilot` command with mandatory `--enable`; no background daemon, scheduled
  launch, or real overnight execution was enabled implicitly.
- Added a structured morning report covering durable run/task/project state, attempts, worker/model/
  session, duration and cost estimate, draft/CI, failures, summary counts, and remaining ready,
  waiting, and blocked DAG work.
- Evidence: 74 deterministic tests pass. The scheduler simulator uses two projects with two worker
  profiles, proves sequential claim bounds and duplicate-free repeated passes, exercises no-progress,
  deadline, maximum-claim, explicit-enable, concurrency, and human-gate stops, and verifies report
  contents from durable execution/delivery records.
- Next open decision: review launch settings and run a short supervised `--max-new-claims 1` dogfood
  session before any overnight use; then add repeatable service/container packaging.

### Supervised autopilot proof

- Ran the public command with explicit `--enable`, two-minute deadline, global new-claim ceiling one,
  concurrency one, one-second backoff, and a one-pass no-progress ceiling against the existing
  Agent Runner registration.
- Pass one reconciled DOGFOOD-01 from the prior base to autopilot commit `eeea57f`, reran required
  verification, and updated the same draft. Pass two classified the base current and performed only
  persisted-PR/CI observation. Both passes recorded `execution: not-run`; total new claims was zero.
- The loop stopped itself with `no-progress` after 17.288 seconds. Its morning report included the
  historical failed permission attempt and successful run, both worker/model/session identities,
  durations, combined local usage estimate, draft PR #8 with CI `none`, and issue #7 as remaining.
- No model, duplicate branch/PR, merge, or background schedule was launched. The next gate is
  repeatable service/container packaging followed by a second small-project portability proof.

## 2026-09-02 — Dogfood proof closure and automated verification

- Re-read the live repository state before acting. GitHub reported draft PR #8 open, cleanly
  mergeable, without required checks, and limited to `docs/dogfood-runbook.md`; issue #7 remained
  open.
- A parallel local verification attempt ran the full suite in both checkouts simultaneously. Both
  copies exceeded the fake worker profile's one-second timeout in the same test. Running that test
  and the complete suite normally and serially passed, identifying resource contention in the
  diagnostic rather than a branch-specific failure.
- After owner approval, marked PR #8 ready and squash-merged it as commit `5d2afa7`. Closed issue #7
  explicitly with the verification evidence because the pull-request body did not contain an
  automatic issue-closing keyword.
- Reconciled README, architecture, and landscape status language with the completed supervised
  scheduler proof. Added GitHub Actions verification for pull requests and pushes to `main`, using
  Node.js 24, `npm ci`, and `npm run verify`.
- An initial local workflow-shape assertion treated the valid empty `pull_request:` trigger as a
  missing value after YAML parsing. Corrected the diagnostic to check for the trigger key; the
  workflow parses with the intended push, pull-request, and verification structure.
- Evidence: the serial verification suite passes all 74 tests on merged `main`. The CI workflow must
  still be observed on GitHub after publication. No license was selected implicitly.
- Next gate: choose the public license, observe the first automated check, then build the installable
  local runtime and its `init` and `doctor` commands before the portability proof.

## 2026-09-02 — Requirements Builder first vertical slice

- The owner corrected the product direction: this is a local project-support workflow, not a formal
  standalone product rollout. Requirements Builder and Agent Runner must live outside product
  repositories. Public licensing, service packaging, and in-project initialization are deferred.
- Added the separate `requirements-builder` command while reusing the existing model-neutral worker
  profile boundary. It accepts repeated file, directory, and ZIP inputs and works entirely in a new
  external output workspace.
- Added source copying, generated-folder filtering, ZIP path checks, symbolic-link rejection, bounded
  intake, a hashed source manifest, and a post-worker check that the copied evidence did not change.
- Added a strict requirements schema with sourced acceptance criteria, explicit open questions,
  requirement-to-task coverage, concrete verification, and task dependencies. Independent validation
  rejects unknown references, missing coverage, duplicate edges, and cycles; blocking questions keep
  a plan from being publishable.
- Added readable requirements/DAG previews and self-contained GitHub issue drafts. Each issue draft
  carries its full requirement context and stable task marker rather than depending on a hidden
  requirements file.
- Evidence: 82 deterministic tests pass, including the public Requirements Builder command through a
  generic JSON worker, successful and unsafe ZIP cases, copied-source immutability, blocking product
  questions, missing dependencies, and dependency cycles. No live model call or GitHub publication
  was made.
- Next gate: run the builder once against the owner's real design archive with an explicitly approved
  worker profile, review the artifacts, then implement idempotent issue/dependency publication and
  remove the runner's mandatory in-project contract.
