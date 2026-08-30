# Agent orchestration landscape — August 2026

The ecosystem already provides most worker and specification primitives. Agent Runner should build
only the missing project-level delivery control plane, or extend an existing permissively licensed
controller when that is safer.

## Current decisions

| Layer | Leading option | Decision |
|---|---|---|
| Requirements and planning | [GitHub Spec Kit](https://github.com/github/spec-kit) | Adopt or extend; MIT, v1.0.1, specification-to-task and task-to-issue workflows |
| Human-readable agent entry | [AGENTS.md](https://agents.md/) | Adopt as the canonical repository instruction entry point |
| Worker intelligence | [Claude Fable](https://www.anthropic.com/claude/fable), Codex, others | Keep pluggable; Fable is a model inside an agent harness, not a controller |
| Local Claude execution | [Claude Code agents/worktrees](https://code.claude.com/docs/en/agents) | Adopt; do not rebuild background sessions or worktree supervision initially |
| Cloud Claude execution | [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) | Later adapter for machine-independent overnight runs |
| Cross-agent sessions | [Agent Client Protocol](https://agentclientprotocol.com/) | Prefer when supported, retain native adapters where it is not |
| Agent tools/context | [Model Context Protocol](https://modelcontextprotocol.io/) | Expose controller capabilities later; MCP is not the workflow state machine |
| GitHub task truth | Native issues and dependencies | Prefer over maintaining a second live DAG when the forge supports it |

## Control planes to evaluate before building

1. [DoorDash Agentic Orchestrator](https://github.com/doordash-oss/agentic-orchestrator)
   (Apache-2.0, v0.152.0): durable multi-provider feature lifecycle, worktrees, critics, dashboard,
   multi-repository planning, and PR publication. Main gap: draining an existing issue DAG with
   atomic claims and post-merge dependency traversal.
2. [Orch](https://github.com/kninetimmy/orch) (MIT, v0.10.0): fail-closed issue/worktree/PR lifecycle,
   pinned-head human merge, deterministic routing, restart reconciliation, and extensive audit state.
3. [Commandcenter](https://github.com/cgeene/commandcenter) (MIT): SQLite claims, dependencies,
   worktree workers, scheduler, independent review, PR polling, and recovery. Small and local-first.
4. [Beads](https://github.com/gastownhall/beads) and
   [Gas Town](https://github.com/gastownhall/gastown) (MIT): persistent dependency graph, ready/claim
   semantics, multi-agent workspaces, and handoffs. Evaluate the ledger independently from the more
   opinionated full workspace manager.
5. [OpenHands](https://github.com/OpenHands/OpenHands) (MIT core): sandboxed agent server and issue
   resolver. Strong worker backend; project-level dependency and merge policy still need a controller.
6. [GitHub Agentic Workflows](https://github.com/github/gh-aw) (MIT): promising later cloud executor
   with read-only agents and validated safe outputs.

The public [Fable orchestration playbook](https://github.com/eliasforge/fable-agent-orchestration)
contains useful review and negative-control patterns, but it is an AGPL skill library rather than a
durable controller. Treat it as a reference unless this project deliberately adopts AGPL.

## What remains genuinely missing

- Multi-project registry and a versioned project contract
- Normalized task providers, dependencies, atomic leases, and heartbeats
- One task to one branch/workspace/session/PR ownership
- Base-commit tracking, conflict prediction, and final-tree synchronization
- Deterministic verification outside the implementing model
- Independent review tied to the current pull-request head
- Risk-tiered human gates and merge policy
- Crash reconciliation, retry/no-progress budgets, audit events, and morning reports

## Research sources

- [Claude Code dynamic workflows](https://code.claude.com/docs/en/workflows)
- [Claude Code headless execution](https://code.claude.com/docs/en/headless)
- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
- [GitHub Spec Kit workflows](https://github.com/github/spec-kit/blob/main/docs/reference/workflows.md)
- [OpenHands issue resolver](https://github.com/All-Hands-AI/OpenHands/blob/main/openhands/resolver/README.md)
- [GitHub custom agents](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
- [DBOS durable workflows](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial)
- [Restate workflows](https://docs.restate.dev/tour/workflows)
