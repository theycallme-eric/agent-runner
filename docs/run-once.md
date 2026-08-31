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
claims bounded ready work, creates isolated worktrees, invokes workers, independently verifies and
commits their changes, and creates or reconciles draft pull requests. It never merges.

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

A task revision already present in the run ledger is never claimed twice. If that existing run is at
`verified`, `pr-open`, or `ci`, another `run-once` reconciles the same persisted branch/pull request
and polls CI without relaunching the worker. Completed and failed runs remain visible duplicates.
General stale-lease/workspace recovery and base synchronization are RECON-01, not hidden behavior in
this first command.

The JSON result reports the inspected graph, new claims, reconciled deliveries, duplicate task ids,
capacity/limit stops, non-secret worker identity, workspace, pull-request URL, CI state, and failure
reason. Any task or delivery failure sets `ok: false` and a non-zero process exit status while still
printing the full batch result.
