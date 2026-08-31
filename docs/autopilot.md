# Bounded autopilot

`autopilot` turns repeated safe `run-once` passes into an explicitly enabled multi-project loop. It
does not introduce another execution path: every project pass refreshes its remote base and DAG,
reconciles durable work first, then claims through the same controller used interactively.

```text
agent-runner autopilot --enable \
  --minutes 480 \
  --max-new-claims 3 \
  --no-progress-passes 3 \
  --poll-seconds 60
```

Without `--enable`, the command fails before any project pass. The first unattended version fixes
global concurrency at one. Projects run in stable registry order; each receives at most one new
claim per pass, while its own contract still bounds attempts, worker time, and verification.

## Stop conditions

The loop stops on the first applicable boundary:

- wall-clock deadline;
- maximum new claims for the whole invocation;
- configured consecutive passes with no claim or lifecycle/base progress;
- a protected-path or other human gate;
- missing worker profile or worker/quota unavailability;
- any terminal or retryable run failure; or
- no enabled registered projects.

Idle passes wait for the configured poll interval rather than busy-looping. A process crash may omit
the final report, but claims, leases, attempts, workspaces, worker evidence, draft identity, and CI
remain in SQLite; the next launch begins with reconciliation instead of in-memory assumptions.

## Morning report

The final JSON includes the stop reason, every pass and project result, new-claim total, and
consecutive no-progress count. Its report lists every durable run with project/task/run identity,
state, attempt, worker/model/session, duration and cost estimate, pull-request URL, CI, and failure
reason. Totals summarize completed, human-gated, and failed work plus estimated usage. The latest DAG
snapshot lists ready, waiting, and blocked work per project.

The scheduler has no merge capability. Draft review and merge remain human actions.

## First real run gate

Before an overnight launch, run a supervised short invocation with one registered disposable or
dogfood project, `--minutes` kept small, `--max-new-claims 1`, and the local profile/state paths made
explicit. Review its report and drafts before increasing duration or registering a product project.
