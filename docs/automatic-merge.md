# Protected automatic merge

Automatic merging is the delivery mechanism that lets Agent Runner drain an approved DAG without a
person merging every node. It is opt-in per external project contract:

```yaml
delivery:
  provider: github
  pullRequest: true
  merge: after-required-checks
```

`merge: never` remains available for projects that require pull-request-by-pull-request review.
Changing this setting does not change or add a file in the product repository; the contract remains
in the project's external support workspace.

## Required safeguards

Before a dry run or mutating run can claim work or launch a coding agent, the selected delivery
adapter must prove that it supports automatic merging. The GitHub adapter also requires the target
base branch to have:

- branch protection enabled;
- strict, up-to-date branch checks;
- at least one named required status check;
- `enforce_admins` enabled ("Do not allow bypassing the above settings"), so protection binds every
  token that can merge, including the owner's administrator token; and
- every required check provided by a specific GitHub App. A context added through the legacy
  `contexts` list, or left without a reporting application, accepts a result from any source, so
  the preflight refuses it by name and asks for an application to be configured;
- zero required approving reviews, because the unattended lane cannot supply an independent human
  approval for every node; and
- an external Runner contract that gates `.github/workflows/**` for human review, preventing a
  normal implementation node from changing its own merge proof; and
- one statically named GitHub Actions job for each required context, on ordinary `pull_request`
  `opened` and `synchronize` events, with no path/branch filters, matrix/dynamic name, reusable job,
  conditional producer, or duplicate producer.

This first automatic lane is deliberately narrow. Unsupported or ambiguous topology fails during
dry run before a claim, branch, worker call, pull request, or model cost. Absence of a check row is
never treated as proof that another producer cannot appear. The same live preflight runs again at
the final merge gate, so base/workflow/protection changes are not trusted from an earlier pass.

For each node, the controller still requires a clean isolated workspace, a non-empty committed
change, independent task and project verification, no protected-path gate, an unchanged base, and a
passing required CI result. The GitHub adapter creates automatic-mode pull requests ready from the
outset and uses an exact-head guard while squash-merging. `merge: never` still creates drafts. An
unexpected draft in automatic mode is a terminal inconsistency; the Runner never changes review
mode in flight. It rechecks branch protection immediately before merging.

## What counts as a passing required check

A required context is satisfied only by check runs that carry all four of: the required context
name, the GitHub App branch protection pins that context to, the exact verified head commit, and a
completed successful result. The evidence comes from the check-runs API for that commit rather than
from `gh pr checks`, because only the former reports the reporting application and the head it ran
against. A commit status is therefore never accepted as proof, and a listing that is too large to
read in one page proves nothing rather than being trusted as far as it goes.

Every row for the exact `(context, app, verified head)` identity is reconciled together. Any failure
or cancellation fails the context. Otherwise, any pending or skipped row keeps it waiting. Only one
or more rows that are all successful pass. No matching row waits. This same decision function is
used during coordination and immediately before merge. Because automatic pull requests are ready
from creation, there is no draft-to-ready event, settling observation, or fixed per-node delay.

Only after GitHub reports that exact pull request head as merged does the adapter close the numeric
source issue as completed. Closing the issue refreshes the native DAG on the next pass, allowing its
dependents to become ready. A crash between the merge and issue closure is recoverable: the next pass
recognizes the same exact merged pull request and retries task completion without rebuilding the
node.

## Reasons the run stops

The Runner does not merge when required checks are absent, pending, failed, reported by an
application other than the configured one, or reported against a commit other than the verified
head; the base or pull
request identity changed; verification failed; a protected path or explicit human gate was reached;
the worker or provider is unavailable; retries are exhausted; or the bounded unattended session has
reached its time, claim, or no-progress limit. Retryable GitHub delivery errors remain in durable
state and are retried until that bounded limit instead of being mistaken for completed work.

A required context that has not reported, is still queued, or was skipped is not a pass; cancelled
and failed contexts fail. Each waiting pull request carries its own persistent wait clock, bounded
by `--max-ci-wait-minutes` (default 60) or the contract's `delivery.maxCiWaitMinutes`. The clock is an
operational bound, never part of the merge proof. On expiry, that task revision is quarantined with
its pull request and outstanding contexts while unrelated ready branches continue. Failed task
revisions are quarantined the same way. The default cumulative budget is three distinct quarantined
task revisions per owner-authorized autopilot execution, including crashes/restarts; the third stops
new work. Approval drift, repository/preflight failure, missing worker, or exhausted quota remains
immediately session-fatal rather than task-local.

## Build branch and final release

`project.baseBranch` is the branch each DAG node targets. It may be the product's main branch or a
dedicated build branch. Using a dedicated build branch allows all safe nodes to merge autonomously
while final promotion, release, or publication remains one owner decision after reviewing the
consolidated result. Agent Runner does not invent a universal release action because products own
their release process.
