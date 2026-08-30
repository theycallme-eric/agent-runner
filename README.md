# Agent Runner

Project-agnostic infrastructure for turning approved work into isolated coding-agent runs, verified
pull requests, and dependency-aware follow-on work.

This repository owns the reusable process and controller. Product repositories such as CLEAR remain
independent and receive only a small, editable project adapter.

## Current state

Research and architecture spike. No production controller exists yet, and nothing here is currently
running in the background.

## Start here

| Document | Purpose |
|---|---|
| [Architecture](docs/architecture.md) | System boundary, project contract, and first executable slice |
| [Landscape](docs/landscape.md) | Recent systems reviewed and the current adopt/evaluate/build decisions |
| [AGENTS.md](AGENTS.md) | Entry point for coding agents working on this repository |

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
- First decision gate: evaluate existing control planes before writing a competing implementation
