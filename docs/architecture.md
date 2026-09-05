# Agent Runner architecture

## Boundary

```text
Approved external task graph
             ↓ task-provider boundary
Standalone Agent Runner
  external project contract + registry + durable state + leases + policy + reconciliation
             ↕ isolated Git worktrees
Product repository
  product source and its own native development instructions
             ↕ worker adapter
Claude/Fable | Codex | OpenHands | future ACP-compatible workers
```

The controller never owns raw design inputs, requirements authorship, or product source code. It
does not import or invoke Requirements Builder. The product never vendors the controller. The
versioned project contract lives in `project-workspaces/<slug>/runner/project.yml`, outside the
product repository.

## No project injection

```text
project-workspaces/<slug>/runner/
  project.yml       # task source, setup, verification, gates, concurrency, delivery policy
  state/            # controller database and durable state
  workspaces/       # isolated task worktrees
  reports/          # owner-facing run reports

/independent/product/repository/
  product files only; no Agent Runner requirement or pointer
```

Example external contract:

```yaml
version: 1
project:
  id: owner/example-project
  baseBranch: main
tasks:
  provider: github
  dependencies: github-native
workspace:
  setup:
    - npm ci
verification:
  required:
    - npm run typecheck
    - npm test
    - npm run build
  protectedPaths:
    - pattern: .github/workflows/**
      gate: human
execution:
  concurrency: 2
  attempts: 2
  timeoutMinutes: 120
delivery:
  provider: github
  pullRequest: true
  merge: after-required-checks
```

Worker/model selection belongs to controller or user configuration rather than the project contract.
Secrets never belong in the contract. Registration requires separate explicit repository and
contract paths, rejects a contract inside the repository, verifies the Git root, and checks that a
GitHub-backed contract names the repository configured as `origin`.

The lifecycle core depends only on the normalized `WorkerAdapter` contract. Native adapters may use
provider-specific features; the versioned JSON process adapter provides a universal wrapper path for
other CLIs and SDKs. See [Worker adapters](worker-adapters.md).

Canonical repository and contract locations, enabled state, and worker-profile selection live in the
controller's persistent registry. Task sources and dependency sources are separately named plug-ins.
The planner normalizes their output, validates the DAG, and atomically claims ready revisions within
each project's concurrency limit. See [Project onboarding](project-onboarding.md).

## Durable lifecycle

```text
discovered → claimed → workspace-ready → running → verifying
           → synchronized → verified → PR-open → CI → merged/task-completed
                                                    ↘ waiting-human/failed
```

Every transition is idempotent and recorded with the task revision, base SHA, head SHA, workspace,
worker session, attempt, and evidence. GitHub events trigger reconciliation but are not trusted as an
ordered or complete event log.

## First implementation slice: build-versus-adopt spike

Do not build the production controller first. Use a disposable fixture repository and answer these
questions with executable evidence:

1. Can DoorDash Agentic Orchestrator accept an externally selected issue and expose enough lifecycle
   state to add leases, CI reconciliation, and DAG refresh without maintaining a hard fork?
2. Can Beads supply the normalized ready/claim/close ledger while GitHub remains the visible task
   surface?
3. Can Spec Kit initialize requirements and produce dependency-preserving GitHub issues without
   coupling projects to one coding agent?
4. Can Claude Code's background/structured interfaces run one fixture task, survive interruption,
   and produce enough state for controller reconciliation?
5. Which components pass license, update, observability, and failure-recovery requirements?

### Spike exit criteria

- One fixture task is claimed atomically and cannot be claimed twice.
- One isolated worker produces a branch and draft pull request.
- Controller-owned verification rejects a false worker-success report.
- Restarting the controller resumes or safely classifies the run without duplicating work.
- Advancing the base branch forces synchronization and complete re-verification.
- A protected-path change stops at a visible human gate.
- The evidence supports an explicit adopt, extend, or build decision for each layer.

Only after this spike should any real product be registered with the Runner.

## Executable evidence so far

The local simulator now covers the controller-owned portions of exit criteria 1, 3, 4, 5, and 6.
The concrete execution service joins an atomic claim, exact-base worktree, controller-selected
`WorkerAdapter`, approved task-scoped runtime prerequisite checks, independent setup and verification
commands, protected-path gate, local commit, and durable workspace/session/head evidence. A missing
runtime prerequisite blocks only its linked tasks. It rejects worker crashes, timeouts, false success
without changes, verification failure, and a base that advances before the verified head is recorded. GitHub
issue and native-dependency discovery works through the same plug-in boundary. A provider-neutral
delivery coordinator now reconciles one policy-owned pull request per verified branch, persists its
identity and CI state, and rejects failed CI. Review-only projects require drafts. Protected automatic
projects require ready pull requests and positively preflight one static GitHub Actions producer per
app-pinned required context, strict administrator-bound protection, and zero required human reviews
before claims. They reconcile all exact-identity check rows fail-closed, merge only the exact verified
head after CI passes, and complete the source issue only after GitHub proves the merge. Restart
reconciliation can recover that sequence without rebuilding a node. The live dogfood path includes
a successful isolated Fable session and persisted draft pull request. A disposable five-node proof
also completed the protected automatic path through parallel branches, base advancement,
reverification, issue completion, dependency unlocking, and a final completed report. The bounded
multi-project scheduler reuses this joined path with explicit limits, persistent owner-execution
identity, cumulative task-revision quarantines, adaptive polling, and a consolidated report.
Task-local failures and CI timeouts do not prevent unrelated branches from progressing; global
approval, repository, worker, quota, and safety-preflight failures still stop immediately.

`run-once` is the first joined public surface. It refreshes `origin/<base>` before claiming and uses
read-only `ls-remote` checks during execution/delivery, avoiding the stale-local-branch assumption.
Dry run resolves the remote base and DAG without claims or external writes. Mutating passes reconcile
existing runs before claiming from the same DAG snapshot. Repeated task revisions at delivery states
poll the persisted pull request and CI without relaunching a worker, push, or edit. Under protected
automatic delivery, completed node issues update the next task snapshot so dependents unlock on a
later pass.

Real workers remain fail-closed. The first Claude/Fable smoke test revealed that inherited MCP state
can break a headless run and that `--max-budget-usd` is a stop condition rather than an enforceable
preflight cap. Under Max/Pro subscription authentication its dollar output is a local token-cost
estimate, not billing. The controller must isolate worker settings and manage parallelism and plan
quota before unattended runs are enabled.

The local Claude adapter therefore opts into setting sources explicitly, uses strict empty MCP
configuration by default, disables browser integration, slash commands, and auto-memory, and
requires both a turn limit and a wall-clock timeout. A production project may opt into its checked-in
`project` source so `CLAUDE.md` is visible; user and local settings are never inherited implicitly.

The first concrete task/dependency pair is GitHub Issues plus native issue dependencies. It is a
plug-in registration, not special behavior in the planner. Agent Runner's own external dogfood
contract selects only issues labeled `agent:task`.

Requirements Builder integrations add an external `approvedHandoff` path to that provider-owned
configuration. Agent Runner parses and hashes the contract independently, verifies its active
immutable approval record, then compares every live issue and native dependency before planning.
This preserves upstream task IDs and makes a label alone insufficient authorization. Approved
repository readiness must exactly match the Runner contract. Named, non-secret execution
prerequisites remain task-scoped, and their approved verification commands run before claims.
Approved task-specific verification commands run outside the implementing worker in addition to the
full project verification suite; both layers rerun after base synchronization. Every approved
`sources/...` reference must resolve to a regular file inside the approved run before planning. For
execution, the controller copies the run's source tree to a run-specific read-only evidence directory
beside—not inside—the product worktree, grants the worker read access for that attempt, and verifies
the copy's content hash afterward. Task-listed references are authoritative; adjacent source files
may be followed only when directly referenced by them, so unselected prototype candidates do not
become requirements by proximity.
