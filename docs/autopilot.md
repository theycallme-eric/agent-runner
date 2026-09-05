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
  --poll-seconds 60 \
  --max-ci-wait-minutes 60 \
  --max-task-failures 3
```

`--max-ci-wait-minutes` bounds how long one pull request may sit on genuinely pending or unreported
required checks. It defaults to 60 minutes, is overridden per project by the contract's
`delivery.maxCiWaitMinutes`, and is measured by a persistent per-pull-request clock. That clock
survives passes and controller restarts, is never reset by another branch making progress, and
starts again only when that pull request's head changes. On expiry, the task revision is quarantined
and unrelated dependency-ready work continues.

`--max-task-failures` defaults to three distinct quarantined task revisions. The count is cumulative
for one owner-authorized autopilot execution, not per hour: repeated observations of the same task
revision count once, and a process crash resumes the same execution and count. A clean stop ends that
execution; another explicit launch starts a new bounded execution.

That quarantine budget is separate from per-task attempts. A retryable pre-publication failure does
not enter quarantine while a configured attempt remains; the next pass reclaims the same durable run
with a clean attempt workspace. If the final attempt fails, that task revision is quarantined once.

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

The loop stops on the first applicable global or bounded boundary:

- every enabled project's DAG is complete and no run remains in flight;
- wall-clock deadline;
- maximum new claims for the whole invocation;
- configured consecutive passes with no claim or lifecycle/base progress;
- no remaining branch can progress because it is dependency-blocked, human-gated, waiting, or
  quarantined;
- missing worker profile or worker/quota unavailability (including a provider message that the
  account is out of usage until a stated reset time); these global stops happen before task
  quarantine and before another automatic retry;
- the distinct quarantined-task budget is reached;
- approval/repository drift or automatic-merge preflight failure; or
- no enabled registered projects.

Any material local or GitHub change causes an immediate next pass; only a purely observational pass
waits for the configured poll interval. A process crash may omit the final report, but claims,
leases, attempts, workspaces, worker evidence, pull-request identity, CI clocks, execution identity,
and quarantines remain in SQLite; the next launch begins with reconciliation instead of in-memory
assumptions. Retryable delivery failures are retried without another worker call until progress
resumes or a bounded stop is reached.

## Morning report

The final JSON includes the stop reason, durable execution identity, whether it resumed after an
interruption, every pass and project result, new-claim total, cumulative quarantines, and consecutive
no-progress count. Its report lists every durable run with project/task/run identity, state, attempt,
worker/model/session, duration and cost estimate, pull-request URL, CI, and failure reason. Totals
summarize completed, human-gated, and failed runs; separate timeout and quarantine lists preserve
their exact task, pull-request, and reason details. The latest DAG snapshot lists ready, waiting, and
blocked work per project, while the stop reason identifies a global boundary. Worker identity and
session describe the latest attempt, while duration and cost are cumulative across every immutable
worker attempt recorded for that durable run; the total cost therefore does not lose failed or
replaced attempts.

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
