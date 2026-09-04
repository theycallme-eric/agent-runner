# Restart reconciliation

Reconciliation is the safety layer between explicit one-shot execution and an unattended scheduler.
Every mutating project pass refreshes the remote base and live DAG, then classifies all nonterminal
runs before it considers a new claim.

## Classification and ownership

The persisted run, execution, and delivery records identify the lease, attempt, workspace, worker
status/session, branch, verified base/head, pull request, and last CI state. A live lease owned by a
different controller is reported and never stolen. An expired active run is reclaimed atomically and
starts a new isolated attempt only while its configured attempt budget remains. Completed and failed
runs are immutable.

Verified and published work receives a short reconciliation lease. The controller requires the
persisted workspace to exist, remain clean, contain a non-empty task diff, and match the verified
head. A persisted pull request is observed by provider and external id. Under `merge: never`, a
missing, ready-for-review, closed, merged, moved-head, or otherwise drifted pull request fails
visibly. Under automatic policy, an unexpected draft fails, an exact ready pull request continues,
and an exact remotely merged pull request enters completion recovery. The controller does not create
a replacement or undo human changes.

## Advanced bases

When the remote base differs from the verified base, the controller first records `synchronized`
with `requiresReverification`. It then merges the new base into the isolated task worktree. A conflict
is captured with its paths, the merge is aborted to restore the verified head, and the run fails.

After a clean merge, every `verification.required` command runs outside the coding agent with lease
heartbeats. Only a clean, non-empty result may return to `verified`. Protected paths return to a
human gate. The existing policy-owned pull request is updated in place only after this new head is
verified.

The synchronization checkpoint makes restart behavior idempotent: a stop before the synchronization
commit repeats it, a stop during verification reruns the full verification set, and a stop after the
remote pull-request update observes the already-updated head before persisting it. Automatic mode
can merge only after the normal final live safeguards pass again.

## CI

Once delivery identity is persisted, ordinary reconciliation observes the pull request and polls required
checks without pushing or editing. `pending` remains pending, `failed` fails the run, and `passed`
completes the controller lifecycle. `none` is an observation—not a passing result—and remains visible
for human review.
