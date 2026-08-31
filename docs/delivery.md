# Draft pull-request delivery

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

The core persists the provider, external id, URL, branch, base/head commits, draft flag, and CI state.
A publication failure is retryable because the remote pull request may have been created before the
controller persisted it. The branch is the creation idempotency key; after persistence, provider and
external id are authoritative. Repeated CI polling does not push or edit. A missing, non-draft,
changed-head, closed, merged, or otherwise mismatched pull request fails visibly. Failed CI can never
complete a run.

## GitHub adapter

`GitHubPullRequestPublisher` verifies the local head, pushes the controller-owned branch, and uses
the authenticated `gh` CLI to create a draft pull request. Persisted pull requests are inspected by
number through the GitHub API. Human changes such as marking a draft ready, closing it, merging it, or
moving its head are reported rather than silently undone. Required check buckets are normalized
through `gh pr checks`; no required checks remains a visible `none` state rather than being treated
as success. The adapter never invokes merge, auto-merge, or branch-deletion commands.

## Current boundary

`run-once` reconciles existing durable runs before it claims new work. The joined fake-GitHub CLI
fixture proves pending CI advances on a later invocation without another worker, push, edit, or pull
request. See [Reconciliation](reconciliation.md) for restart and advanced-base behavior. Periodic,
bounded unattended scheduling remains separate work.
