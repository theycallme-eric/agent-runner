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
selected workers, independent verification, and policy-controlled pull-request delivery. With
`merge: never`, passing work stops at its persisted pull request. With
`merge: after-required-checks`, passing work is merged and its source task is completed automatically.

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
worktree, launch a worker, push a branch, publish a pull request, or merge. For automatic delivery,
this includes proving strict branch protection and at least one required check before any model use.

## Repeated runs

A task revision already present in the run ledger is never claimed twice. Every mutating pass first
classifies nonterminal runs by lease, workspace, worker evidence, branch, pull request, CI, and base.
Live leases are not stolen. Expired active attempts are reclaimed within their budget. Published runs
use their persisted pull-request identity and poll CI without relaunching the worker or republishing.
If the base advanced, the controller checkpoints synchronization, merges in the isolated worktree,
reruns every required verification command, and only then updates the same pull request. Conflicts, missing
workspaces, changed or closed pull requests, and exhausted attempts fail with durable evidence. See
[Reconciliation](reconciliation.md).

Before publication, a narrow allowlist of implementation failures—such as worker failure, no
changes, setup/verification failure, or base advancement—may reclaim the same durable run for a
fresh attempt while `execution.attempts` remains. The retry gets a new clean worktree and the prior
verification failure in its prompt; it never edits or salvages the failed workspace. Integrity and
safety failures are not retried, and any run with a delivery identity remains on reconciliation
rather than launching another worker. Only the final failed attempt is quarantined.

After that configured budget is exhausted, an owner may deliberately grant a specific failed run
more attempts without changing its approved task revision or editing SQLite directly:

```text
agent-runner retry-failed <run-id> --additional-attempts 1 --confirm-retry \
  --state /path/to/state.sqlite
```

The command refuses nonretryable failures, published work, active runs, and runs that already retain
an attempt. It records the authorization durably and leaves execution to a later normal controller
pass.

When automatic delivery merges one of several independently prepared nodes, reconciliation refreshes
the base before processing the next one. Sibling work is synchronized and independently reverified
against that new base before it can merge. A transient merge or issue-completion error is retried from
durable pull-request identity rather than relaunching the worker.

GitHub repositories with no required checks report CI as `none`. That is a valid observation, not a
passed check suite. Under the review-only policy, the draft remains available for human review.
Under the automatic policy, the stricter topology/protection preflight refuses before a claim, so
an unprotected project cannot reach publication or spend model usage.

The JSON result reports the inspected graph, detailed reconciliation classifications, new claims,
duplicate task ids, capacity/limit stops, non-secret worker identity, workspace, pull-request URL,
CI state, and failure reason. Any task or reconciliation failure sets `ok: false` and a non-zero
process exit status while still printing the full batch result.
