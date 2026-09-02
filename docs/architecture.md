# Architecture spike

## Boundary

```text
Standalone Agent Runner
  registry + durable state + leases + policy + reconciliation + reporting
             ↕ versioned project contract
Product repository
  requirements/tasks + dependency source + verification + gates + agent instructions
             ↕ worker adapter
Claude/Fable | Codex | OpenHands | future ACP-compatible workers
```

The controller never owns product requirements or source code. The project never vendors the
controller. Installation adds one editable contract and a short pointer from the project's agent
instructions.

## Minimal project injection

```text
.agent-runner.yml   # task source, setup, verification, protected paths, concurrency, delivery policy
AGENTS.md           # existing instructions plus a short Agent Runner pointer
CLAUDE.md           # optional thin import for Claude Code
```

Example contract:

```yaml
version: 1
project:
  id: theycallme-eric/clear
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
  merge: never
```

Worker/model selection belongs to controller or user configuration rather than the project contract.
Secrets never belong in the contract.

The lifecycle core depends only on the normalized `WorkerAdapter` contract. Native adapters may use
provider-specific features; the versioned JSON process adapter provides a universal wrapper path for
other CLIs and SDKs. See [Worker adapters](worker-adapters.md).

Project locations, enabled state, and worker-profile selection live in the controller's persistent
registry. Task sources and dependency sources are separately named plug-ins. The planner normalizes
their output, validates the DAG, and atomically claims ready revisions within each project's
concurrency limit. See [Project onboarding](project-onboarding.md).

## Durable lifecycle

```text
discovered → claimed → workspace-ready → running → verifying
           → synchronized → verified → PR-open → CI → waiting-human/completed/failed
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

Only after this spike should CLEAR receive its adapter.

## Executable evidence so far

The local simulator now covers the controller-owned portions of exit criteria 1, 3, 4, 5, and 6.
The concrete execution service joins an atomic claim, exact-base worktree, controller-selected
`WorkerAdapter`, independent setup and verification commands, protected-path gate, local commit, and
durable workspace/session/head evidence. It rejects worker crashes, timeouts, false success without
changes, verification failure, and a base that advances before the verified head is recorded. GitHub
issue and native-dependency discovery works through the same plug-in boundary. A provider-neutral
delivery coordinator now reconciles one draft pull request per verified branch, persists its identity
and CI state, and rejects failed CI or non-draft publication. The live dogfood path includes a
successful isolated Fable session and persisted draft pull request. Restart reconciliation now
classifies durable identities before new claims, synchronizes advanced bases inside the isolated
worktree, reruns required verification, and observes existing drafts without routine republishing.
The bounded multi-project scheduler now reuses this joined path with explicit limits and a morning
report. A supervised live scheduler pass reconciled the existing dogfood run without a new claim,
worker invocation, branch, or pull request. The remaining gates before CLEAR are repeatable local
service packaging and a second-project portability proof.

`run-once` is the first joined public surface. It refreshes `origin/<base>` before claiming and uses
read-only `ls-remote` checks during execution/delivery, avoiding the stale-local-branch assumption.
Dry run resolves the remote base and DAG without claims or external writes. Mutating passes reconcile
existing runs before claiming from the same DAG snapshot. Repeated task revisions at delivery states
poll the persisted draft and CI without relaunching a worker, push, or edit.

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
plug-in registration, not special behavior in the planner. Agent Runner's own checked-in contract is
the repository-owned dogfood fixture and selects only issues labeled `agent:task`.
