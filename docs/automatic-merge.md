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
- at least one named required status check; and
- `enforce_admins` enabled ("Do not allow bypassing the above settings"), so protection binds every
  token that can merge, including the owner's administrator token.

For each node, the controller still requires a clean isolated workspace, a non-empty committed
change, independent task and project verification, no protected-path gate, an unchanged base, and a
passing required CI result. The GitHub adapter then marks the exact persisted draft ready and uses an
exact-head guard while squash-merging. It rechecks branch protection immediately before merging.

Only after GitHub reports that exact pull request head as merged does the adapter close the numeric
source issue as completed. Closing the issue refreshes the native DAG on the next pass, allowing its
dependents to become ready. A crash between the merge and issue closure is recoverable: the next pass
recognizes the same exact merged pull request and retries task completion without rebuilding the
node.

## Reasons the run stops

The Runner does not merge when required checks are absent, pending, or failed; the base or pull
request identity changed; verification failed; a protected path or explicit human gate was reached;
the worker or provider is unavailable; retries are exhausted; or the bounded unattended session has
reached its time, claim, or no-progress limit. Retryable GitHub delivery errors remain in durable
state and are retried until that bounded limit instead of being mistaken for completed work.

A required context that has not reported, is still queued, or was skipped or cancelled is not a
pass: the Runner waits instead of merging. Each waiting pull request carries its own persistent
wait clock, bounded by `--max-ci-wait-minutes` (default 30) or the contract's
`delivery.maxCiWaitMinutes`. When that bound passes, an unattended session stops with the
`ci-wait-timeout` reason and names the pull request and outstanding checks. The clock never fails
or transitions the run, so the session resumes from durable state once the checks report.

## Build branch and final release

`project.baseBranch` is the branch each DAG node targets. It may be the product's main branch or a
dedicated build branch. Using a dedicated build branch allows all safe nodes to merge autonomously
while final promotion, release, or publication remains one owner decision after reviewing the
consolidated result. Agent Runner does not invent a universal release action because products own
their release process.
