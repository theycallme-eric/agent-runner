# Agent Runner

Project-agnostic infrastructure for turning approved work into isolated coding-agent runs, verified
pull requests, and dependency-aware follow-on work.

This repository owns the reusable process and controller. Product repositories such as CLEAR remain
independent and receive only a small, editable project adapter.

## Current state

The first local reliability slice is executable. It validates a project's `.agent-runner.yml`,
registers multiple projects and controller-owned worker profiles durably, resolves ready work through
pluggable task and dependency adapters, and enforces task uniqueness and per-project concurrency in
SQLite. It also simulates controller-owned verification, base synchronization, CI, retries, and human
gates. The concrete execution service now connects a claim to an exact-base worktree, a selected
worker adapter, independent commands, a locally committed verified head, and durable evidence. Real
work can now be launched explicitly with bounded `run-once`; unattended execution remains disabled
until restart reconciliation and bounded scheduling exist. GitHub issue/dependency discovery,
controller-owned worker profiles, and idempotent draft-PR publication are connected through that
command, but nothing runs in the background.

## Start here

| Document | Purpose |
|---|---|
| [Architecture](docs/architecture.md) | System boundary, project contract, and first executable slice |
| [Project onboarding](docs/project-onboarding.md) | Multi-project registry and task/DAG plug-in boundary |
| [GitHub adapter](docs/github-adapter.md) | Issue selection, native dependencies, and normalization rules |
| [Worker adapters](docs/worker-adapters.md) | Agent-neutral protocol and provider adapter boundary |
| [Draft-PR delivery](docs/delivery.md) | Idempotent publication, persisted evidence, and CI states |
| [One-shot run](docs/run-once.md) | Joined dry-run and bounded execution flow |
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

The suite currently proves that duplicate claims are rejected, stale work is reclaimed without a
second run, exhausted workers fail visibly, controller restarts preserve state, invalid transitions
fail closed, false worker success is rejected, advanced bases force re-verification, protected paths
wait for a human, failing CI cannot complete a run, workers are replaceable, and a task branch starts
in an isolated worktree at the selected base commit. The full claim-to-verified-workspace fixture
also rejects worker crashes, success without changes, failed independent verification, and a base
that advances before the verified head is recorded.

## Current CLI

```text
npm run build
node dist/src/cli.js validate fixtures/project
node dist/src/cli.js register /path/to/project --worker claude-fable
node dist/src/cli.js status
node dist/src/cli.js ready <project-id>
node dist/src/cli.js profiles --profiles /path/to/workers.yml
node dist/src/cli.js run-once <project-id> --dry-run --profiles /path/to/workers.yml
```

`register` reads the standard contract and stores the project location plus worker-profile selection
in controller state. It does not copy the project, rewrite its requirements, or put agent/model
selection in the product repository. Use `--state <path>` or `AGENT_RUNNER_STATE_PATH` to select a
different controller database.

The built-in GitHub adapter reads issues and GitHub's native `blocked by` relationships. `ready` is
read-only: it refreshes and validates the DAG but does not claim work or launch an agent.

`profiles` validates controller-owned worker configuration and prints only non-secret metadata. The
default path is `~/.config/agent-runner/workers.yml`; `--profiles` or
`AGENT_RUNNER_WORKER_CONFIG` selects another file. See the checked-in
[example](examples/workers.yml).

`run-once` is the explicit mutation boundary. `--dry-run` validates the same project, profile,
remote base, and DAG without claiming, launching, pushing, or publishing. A real run defaults to one
new claim; `--task issue-7` can target one ready task explicitly. It never merges. See
[the one-shot run contract](docs/run-once.md).

## Coding-agent support

The controller depends only on the `WorkerAdapter` interface. Agent- and model-specific settings do
not appear in `.agent-runner.yml` or the lifecycle core.

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
agent-runner init /path/to/project
agent-runner validate /path/to/project
agent-runner run /path/to/project
agent-runner status
```

`init` adds a small project contract. `run` claims ready work, creates isolated workspaces, launches
configured coding agents, verifies their output independently, and publishes reviewable pull
requests. Automatic merging is not part of the first version.

## Relationship to CLEAR

CLEAR is the first dogfood project, not part of this repository. It will keep its requirements,
GitHub issues, dependency graph, source code, and product-specific gates. A later CLEAR pull request
will add only the adapter after the controller passes its simulator and fixture-repository tests.

## Repository status

- Public repository: [theycallme-eric/agent-runner](https://github.com/theycallme-eric/agent-runner)
- License: not selected yet
- Next decision gate: publish the first live repository-owned dogfood draft PR and add restart/base
  reconciliation
