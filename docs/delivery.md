# Pull-request delivery

Delivery begins only from a controller-owned `verified` run. The delivery coordinator re-reads the
workspace and requires a clean committed head, at least one changed path, the same base commit used
for verification, and no unresolved protected-path gate.

`PullRequestPublisher` is the provider-neutral boundary. An adapter must:

- push the verified branch without merging it;
- create or find exactly one open draft pull request for that branch;
- observe a persisted pull request without pushing or editing it;
- update an existing draft only when a newly verified synchronized head must be published;
- return the actual branch, base branch, and head commit for validation; and
- normalize required CI as `none`, `pending`, `passed`, or `failed`.

An adapter that supports `merge: after-required-checks` must additionally preflight its automatic
merge safeguards, merge only the exact verified head, return evidence of the resulting merged pull
request, and complete the source task only after the merge is proved.

The core persists the provider, external id, URL, branch, base/head commits, draft flag, and CI state.
A publication failure is retryable because the remote pull request may have been created before the
controller persisted it. The branch is the creation idempotency key; after persistence, provider and
external id are authoritative. Repeated CI polling does not push or edit. A missing, non-draft,
changed-head, closed, merged, or otherwise mismatched pull request fails visibly under `merge: never`.
The automatic policy accepts only its own exact ready or merged pull request so it can finish or
recover the controlled merge. Failed CI can never complete a run.

## GitHub adapter

`GitHubPullRequestPublisher` verifies the local head, pushes the controller-owned branch, and uses
the authenticated `gh` CLI to create a draft pull request. Persisted pull requests are inspected by
number through the GitHub API. Under `merge: never`, human changes such as marking a draft ready,
closing it, merging it, or moving its head are reported rather than silently undone. Required check
buckets are normalized through `gh pr checks`; no required checks remains a visible `none` state
rather than being treated as success.

Under `merge: after-required-checks`, the adapter requires strict branch protection and at least one
required check before any claim or worker launch. After independent verification and passing CI, it
rechecks protection, marks the exact draft ready, squash-merges with an exact-head guard, and closes
the source issue as completed. It does not delete branches. See [Protected automatic merge](automatic-merge.md).

## Current boundary

`run-once` reconciles existing durable runs before it claims new work. The joined fake-GitHub CLI
fixture proves pending CI advances on a later invocation without another worker, push, edit, or pull
request. Automatic delivery tests prove strict-protection refusal, exact-head merge, post-merge task
completion, and recovery after a merge succeeds before local state is persisted. See
[Reconciliation](reconciliation.md) for restart and advanced-base behavior.
