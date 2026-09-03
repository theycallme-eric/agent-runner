# Agent Runner

Local, project-agnostic control plane for running an approved dependency graph through isolated
coding agents and verified draft pull requests.

These tools live outside product repositories. Product repositories such as CLEAR remain independent;
the boundary requires no Agent Runner package, service, instructions, or checked-in configuration.
Each project's Runner contract lives in its external support workspace.

## Current state

The first local reliability slice is executable. It validates an external project contract,
registers multiple independent product repositories and controller-owned worker profiles durably,
resolves ready work through pluggable task and dependency adapters, and enforces task uniqueness and
per-project concurrency in SQLite. Registration canonicalizes both paths, rejects a contract inside
the product, verifies the Git working-tree root, and checks GitHub-backed project identity against
the repository's origin without changing the repository. A separately confirmed command can create
an empty independent local and GitHub repository, push one empty initialization commit, and register
it without adding support files. The controller also simulates
controller-owned verification, base synchronization, CI, retries, and human gates. The concrete
execution service connects a claim to an exact-base worktree, a selected worker adapter, independent
commands, a locally committed verified head, and durable evidence. Real work can be launched
explicitly with bounded `run-once`. Each mutating pass reconciles durable runs before claiming new
work: it respects live leases, reclaims expired attempts, observes existing drafts by persisted
identity, synchronizes advanced bases, and reruns required verification.
A bounded scheduler and morning report are available behind an explicit `autopilot --enable` gate.
The first version enforces global concurrency one and nothing runs in the background unless that
command is deliberately launched. A short supervised autopilot proof reconciled the existing
dogfood run without launching another worker or creating another claim. A real unattended task run
has not yet been started. GitHub Actions runs the deterministic verification suite for pull requests
and pushes to `main`.

Requirements preparation is an upstream responsibility. Agent Runner does not ingest raw designs,
generate requirements, or invoke Requirements Builder. It begins only with an approved task source.
For Requirements Builder projects, it independently validates the versioned external handoff,
active owner-approval record, exact GitHub issue contents and labels, and native dependencies before
reporting or claiming work.

## Start here

| Document | Purpose |
|---|---|
| [Architecture](docs/architecture.md) | System boundary, project contract, and first executable slice |
| [Project onboarding](docs/project-onboarding.md) | Multi-project registry and task/DAG plug-in boundary |
| [GitHub adapter](docs/github-adapter.md) | Issue selection, native dependencies, and normalization rules |
| [Worker adapters](docs/worker-adapters.md) | Agent-neutral protocol and provider adapter boundary |
| [Draft-PR delivery](docs/delivery.md) | Idempotent publication, persisted evidence, and CI states |
| [One-shot run](docs/run-once.md) | Joined dry-run and bounded execution flow |
| [Reconciliation](docs/reconciliation.md) | Restart, advanced-base, PR, and CI convergence rules |
| [Autopilot](docs/autopilot.md) | Bounded multi-project loop, stop conditions, and morning report |
| [Dogfood runbook](docs/dogfood-runbook.md) | Checklist and stop conditions for live repository-owned runs |
| [Landscape](docs/landscape.md) | Recent systems reviewed and the current adopt/evaluate/build decisions |
| [Implementation log](docs/implementation-log.md) | Chronological decisions, problems, and corrections across sessions |
| [AGENTS.md](AGENTS.md) | Entry point for coding agents working on this repository |

## Run the current slice

Requires Node.js 24 or newer.

```text
npm install
npm run validate:fixture
npm run verify
```

The suite currently proves that duplicate claims are rejected, expired attempts are bounded, live
leases cannot be stolen, controller restarts preserve state, false worker success is rejected,
advanced bases are merged and fully reverified, conflicts are restored and reported, protected paths
wait for a human, changed/closed/merged drafts fail closed, pending CI is polled without republishing,
and workers remain replaceable.

## Current CLI

```text
npm run build
node dist/src/cli.js validate /path/to/project-workspace/runner/project.yml
node dist/src/cli.js register /path/to/product-repo \
  --contract /path/to/project-workspace/runner/project.yml \
  --worker claude-fable
node dist/src/cli.js create-project /path/to/new-product-repo \
  --contract /path/to/project-workspace/runner/project.yml \
  --worker claude-fable --visibility private --confirm-create
node dist/src/cli.js status
node dist/src/cli.js ready <project-id>
node dist/src/cli.js profiles --profiles /path/to/workers.yml
node dist/src/cli.js run-once <project-id> --dry-run --profiles /path/to/workers.yml
node dist/src/cli.js autopilot --enable --minutes 480 --max-new-claims 3
```

`register` requires the product repository and external contract as separate explicit paths. It
stores their canonical locations plus worker-profile selection in controller state. It fails when
the contract is inside the product, the path is not the Git root, or a GitHub-backed contract does
not match the GitHub origin. It does not copy the project, rewrite its requirements, or put
agent/model selection in the product repository. Use `--state <path>` or
`AGENT_RUNNER_STATE_PATH` to select a different controller database.

`create-project` is the explicit alternative when no product repository exists. It requires a
public/private visibility choice and `--confirm-create`, refuses non-empty non-repository folders and
wrong remotes, creates no product files, and is idempotent after a successful run. It uses an empty
initial commit only so the configured base branch exists for later isolated work. Actual GitHub
creation is an owner-authorized operation; deterministic tests use a local fake remote.

The built-in GitHub adapter reads issues and GitHub's native `blocked by` relationships. `ready` is
read-only: it refreshes and validates the DAG but does not claim work or launch an agent.

When `tasks.config.approvedHandoff` is set, the path resolves from the external contract folder and
must remain outside the product repository. The Runner verifies the handoff hash, immutable approval
record, active approval pointer, repository/base-branch identity, exact issue text and labels, and
native dependency set. It preserves Requirements Builder task IDs rather than replacing them with
issue numbers. An inactive approval, unknown version, edited issue, changed label/dependency, or
altered handoff fails the entire read before a claim can be created. Task-specific approved
verification commands run independently after the worker, followed by every project-level required
verification command.

`profiles` validates controller-owned worker configuration and prints only non-secret metadata. The
default path is `~/.config/agent-runner/workers.yml`; `--profiles` or
`AGENT_RUNNER_WORKER_CONFIG` selects another file. See the checked-in
[example](examples/workers.yml).

`run-once` is the explicit mutation boundary. `--dry-run` validates the same project, profile,
remote base, and DAG without claiming, launching, pushing, or publishing. A real run defaults to one
new claim; `--task issue-7` can target one ready task explicitly. It never merges. See
[the one-shot run contract](docs/run-once.md).

`autopilot` repeats that same reconciler-first path across enabled registered projects. It requires
`--enable`, starts at global concurrency one, and stops at explicit time, claim, no-progress, human,
worker/quota, or failure boundaries. See [the autopilot contract](docs/autopilot.md).

## Coding-agent support

The controller depends only on the `WorkerAdapter` interface. Agent- and model-specific settings do
not appear in the external project contract or the lifecycle core.

- `ClaudeCodeWorker` is the first native adapter; CLEAR will initially select Fable through it.
- `JsonProcessWorker` runs any local CLI or SDK wrapper that implements the versioned JSON protocol.
- Codex, OpenHands, and future workers can add native adapters without changing task claims,
  workspaces, verification, delivery policy, or product repositories.

Fable is a dogfood choice for CLEAR, not an Agent Runner dependency.

`npm run smoke:fable` is a manual diagnostic, not part of verification or unattended execution. Set
`AGENT_RUNNER_CLAUDE_BIN` when the intended Claude Code binary is not first on `PATH`. Do not treat
Claude Code's `--max-budget-usd` as a hard preflight limit; the first real spike's local cost estimate
exceeded the configured value before stopping. For Max/Pro subscription authentication, Anthropic
states that this dollar estimate is not a bill. It remains useful as a usage guard.

## Target experience

```text
approved task graph
  → agent-runner ready <project-id>
  → agent-runner run-once <project-id> --dry-run
  → explicit run-once or autopilot --enable
  → isolated workers, independent verification, and draft pull requests
```

The runner claims ready work, creates isolated workspaces, launches configured coding agents,
verifies their output independently, and publishes reviewable pull requests. Automatic merging is
not part of the first version.

## Relationship to CLEAR

CLEAR is an intended consumer, not part of this repository. Its requirements are prepared and
approved upstream. The runner can build it through external profiles and isolated worktrees. CLEAR
should not receive Agent Runner code or required configuration files.

## Repository status

- Public repository: [theycallme-eric/agent-runner](https://github.com/theycallme-eric/agent-runner)
- License and public packaging are deferred; neither is required for the local workflow.
- Next implementation gate: expand bounded concurrency and restart/status behavior through the
  roadmap's safe parallel and unattended work package, then run one disposable end-to-end proof.
