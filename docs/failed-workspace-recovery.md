# Failed workspace recovery

This command exists to avoid paying a coding model to recreate an implementation that is already
present in a failed attempt's isolated workspace. It is an explicit owner action, not part of normal
automatic retry behavior.

## When to use it

Use it only after a worker process reports `failed` or `timed-out`, no pull request was published,
and a human has inspected the saved workspace and decided the candidate is worth correcting. The
normal `retry-failed` path remains the default when the candidate is incomplete or untrustworthy; it
starts a clean workspace and invokes the configured worker again.

```text
agent-runner recover-failed-workspace <run-id> --confirm-recovery \
  --state /path/to/state.sqlite
```

The recovery command itself makes no model/API call. Apply any owner-approved corrections in the
recorded failed workspace before invoking it.

## What it proves

Before recording a candidate as verified, the command:

1. reloads the external project registration, contract, approved handoff, and current DAG;
2. requires the exact task ID and revision from the failed run to still be ready;
3. requires a recorded failed/timed-out worker workspace with no delivery identity;
4. verifies the current workspace branch matches the recorded branch and the candidate descends
   from its recorded base;
5. refuses any changed path covered by a human-gated protected-path rule;
6. records the owner's recovery authorization before running checks;
7. creates a clean local candidate commit, refreshes the live base, and safely synchronizes an
   advanced sibling merge; any merge conflict leaves the failed run unpublished;
8. runs every approved task-specific check and every project-level required check independently on
   the final base;
9. rechecks that the live base stayed fixed during verification, validates the final changed paths
   and ancestry, and atomically changes the run from `failed` to `verified`.

Any failed check or synchronization conflict leaves the run failed and records the evidence. The
committed local candidate remains isolated and can be inspected or retried; nothing is pushed. The
worker's original failure, session, duration, and cost remain intact for auditing.

## What it does not do

Recovery does not launch an agent, alter the approved task, create a replacement workspace, push a
branch, publish a pull request, wait for CI, merge, or close the source issue. Those remote actions
remain in the existing controller path. After successful recovery, run `run-once` or `autopilot` as
usual; reconciliation sees the verified run and continues with normal delivery.

This separation keeps the exception small: candidate correction and verification are explicit,
while every remote mutation still uses the same guarded path as an ordinary successful task.
