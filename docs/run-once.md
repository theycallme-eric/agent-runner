# One-shot controller run

`run-once` is the first public command that joins the implemented controller layers for one
registered project:

```text
agent-runner run-once owner/repository \
  --profiles ~/.config/agent-runner/workers.yml \
  --limit 1
```

The command loads the project registration and contract, validates the selected controller-owned
worker profile and delivery adapter, refreshes the remote base, reads and validates the task DAG,
reconciles existing durable runs, then claims bounded ready work. New claims use isolated worktrees,
selected workers, independent verification, and draft-only delivery. It never merges.

Safe defaults are one new claim, a five-minute claim lease, the controller database beside a
`workspaces/` directory, and the local worker-profile config. `--limit` may be raised up to the
project's concurrency policy; claims and executions at that point may run in parallel.

When several tasks are ready, `--task <normalized-task-id>` selects one explicitly (for GitHub,
`issue-7`). An unknown, waiting, blocked, or completed selection fails before a claim. This avoids
changing labels or relying on provider ordering when running a deliberate dogfood task.

## Dry run

```text
agent-runner run-once owner/repository --dry-run --profiles /path/to/workers.yml
```

Dry run validates the same registration, contract, adapters, profile, remote base, and complete DAG.
It may make read-only network calls to the forge and Git remote. It cannot claim a task, create a
worktree, launch a worker, push a branch, or publish a pull request.

## Repeated runs

A task revision already present in the run ledger is never claimed twice. Every mutating pass first
classifies nonterminal runs by lease, workspace, worker evidence, branch, pull request, CI, and base.
Live leases are not stolen. Expired active attempts are reclaimed within their budget. Published runs
use their persisted pull-request identity and poll CI without relaunching the worker or republishing.
If the base advanced, the controller checkpoints synchronization, merges in the isolated worktree,
reruns every required verification command, and only then updates the same draft. Conflicts, missing
workspaces, changed or closed pull requests, and exhausted attempts fail with durable evidence. See
[Reconciliation](reconciliation.md).

GitHub repositories with no required checks report CI as `none`. That is a valid observation, not a
passed check suite: the run remains at `ci` with `waiting-ci`, the pull request remains a draft, and
human review is still required.

The JSON result reports the inspected graph, detailed reconciliation classifications, new claims,
duplicate task ids, capacity/limit stops, non-secret worker identity, workspace, pull-request URL,
CI state, and failure reason. Any task or reconciliation failure sets `ok: false` and a non-zero
process exit status while still printing the full batch result.
