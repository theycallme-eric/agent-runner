# Bounded autopilot

`autopilot` turns repeated safe `run-once` passes into an explicitly enabled multi-project loop. It
does not introduce another execution path: every project pass refreshes its remote base and DAG,
reconciles durable work first, then claims through the same controller used interactively.

```text
agent-runner autopilot --enable \
  --minutes 480 \
  --max-new-claims 3 \
  --concurrency 2 \
  --no-progress-passes 3 \
  --poll-seconds 60
```

Without `--enable`, the command fails before any project pass. Global concurrency defaults to one
and can be explicitly raised to at most 16. Projects remain in stable registry order; within a
project, only dependency-independent ready tasks can be claimed together. The lower of the global
ceiling, remaining invocation claim budget, available project capacity, and the project's own
`execution.concurrency` wins. The SQLite claim transaction still prevents duplicate tasks and
enforces per-project capacity across controller connections.

Reaching the invocation's new-claim ceiling prevents additional claims but does not abandon work
already claimed by that invocation. Autopilot continues reconciliation-only passes until those runs
complete, stop for another reason, or hit an existing time/no-progress boundary.

Projects are processed one at a time, so the explicit global ceiling bounds simultaneous workers in
this controller without multiplying capacity across projects or worker profiles. A later scheduler
can add cross-project parallelism only with an atomic shared provider-capacity ledger.

## Stop conditions

The loop stops on the first applicable boundary:

- every enabled project's DAG is complete and no run remains in flight;
- wall-clock deadline;
- maximum new claims for the whole invocation;
- configured consecutive passes with no claim or lifecycle/base progress;
- a protected-path or other human gate;
- missing worker profile or worker/quota unavailability;
- any terminal run failure; or
- no enabled registered projects.

Idle passes wait for the configured poll interval rather than busy-looping. A process crash may omit
the final report, but claims, leases, attempts, workspaces, worker evidence, draft identity, and CI
remain in SQLite; the next launch begins with reconciliation instead of in-memory assumptions.
Retryable delivery failures are retried without another worker call until progress resumes or the
bounded no-progress limit stops the session.

## Morning report

The final JSON includes the stop reason, every pass and project result, new-claim total, and
consecutive no-progress count. Its report lists every durable run with project/task/run identity,
state, attempt, worker/model/session, duration and cost estimate, pull-request URL, CI, and failure
reason. Totals summarize completed, human-gated, and failed work plus estimated usage. The latest DAG
snapshot lists ready, waiting, and blocked work per project.

For a project configured with `merge: after-required-checks`, the same loop merges each safely
verified node, completes its source issue, refreshes the DAG, and continues with newly unblocked
nodes. For `merge: never`, drafts remain human actions. The scheduler emits no periodic
notifications: the consolidated final report, a failure, or a required human gate is the actionable
signal. See [Protected automatic merge](automatic-merge.md).

## First real run gate

Before an overnight launch, run a supervised short invocation with one registered disposable or
dogfood project, `--minutes` kept small, `--max-new-claims 1`, and the local profile/state paths made
explicit. Confirm the automatic policy preflight, merged task, issue completion, and newly unblocked
DAG state before increasing duration or registering a product project.
