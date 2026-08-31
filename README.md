# Agent Runner

Project-agnostic infrastructure for turning approved work into isolated coding-agent runs, verified
pull requests, and dependency-aware follow-on work.

This repository owns the reusable process and controller. Product repositories such as CLEAR remain
independent and receive only a small, editable project adapter.

## Current state

The first local reliability slice is executable. It validates a project's `.agent-runner.yml`,
stores claims and lifecycle events durably in SQLite, and simulates controller-owned verification,
base synchronization, CI, retries, and human gates. A local Claude Code adapter and disposable Git
worktree harness exist, but real unattended execution is deliberately disabled while inherited
settings and subscription-quota handling are unresolved. It is not yet connected to GitHub, and
nothing here is currently running in the background.

## Start here

| Document | Purpose |
|---|---|
| [Architecture](docs/architecture.md) | System boundary, project contract, and first executable slice |
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
in an isolated worktree at the selected base commit.

`npm run smoke:fable` is a manual diagnostic, not part of verification or unattended execution. Set
`AGENT_RUNNER_CLAUDE_BIN` when the intended Claude Code binary is not first on `PATH`. Do not treat
Claude Code's `--max-budget-usd` as a hard preflight limit; the first real spike's local cost estimate
exceeded the configured value before stopping. For Max/Pro subscription authentication, Anthropic
states that this dollar estimate is not a bill. It remains useful as a usage guard.

## Intended experience

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

- Working name: `agent-runner`
- Local repository only; no GitHub remote yet
- License: not selected yet
- First decision gate: connect one disposable fixture task to a real worker while evaluating whether
  an existing control plane can supply that layer without a hard fork
