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
  the preflight refuses it by name and asks for an application to be configured.

For each node, the controller still requires a clean isolated workspace, a non-empty committed
change, independent task and project verification, no protected-path gate, an unchanged base, and a
passing required CI result. The GitHub adapter then marks the exact persisted draft ready and uses an
exact-head guard while squash-merging. It rechecks branch protection immediately before merging.

## What counts as a passing required check

A required context is satisfied only by a check run that carries all four of: the required context
name, the GitHub App branch protection pins that context to, the exact verified head commit, and a
completed successful result. The evidence comes from the check-runs API for that commit rather than
from `gh pr checks`, because only the former reports the reporting application and the head it ran
against. A commit status is therefore never accepted as proof, and a listing that is too large to
read in one page proves nothing rather than being trusted as far as it goes.

Marking a draft ready can itself trigger a `ready_for_review` workflow, and GitHub does not promise
that such a run exists by the time the ready request returns. The adapter therefore stops after
marking the draft ready and merges no earlier than a later pass, and the controller discards the
first required-check reading taken after that transition. A required check that does not rerun on
the ready event is unaffected: its earlier result is still the latest run for that context on the
same head, so the node merges once the settling reading is taken. The equivalent window for a new
commit is already closed by matching the head, because a commit whose runs have not registered
carries no earlier pass to mistake for a current one.

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
