# Draft pull-request delivery

Delivery begins only from a controller-owned `verified` run. The delivery coordinator re-reads the
workspace and requires a clean committed head, at least one changed path, the same base commit used
for verification, and no unresolved protected-path gate.

`PullRequestPublisher` is the provider-neutral boundary. An adapter must:

- push the verified branch without merging it;
- create or find exactly one open draft pull request for that branch;
- reconcile its title and body after retries or controller restarts;
- return the actual branch, base branch, and head commit for validation; and
- normalize required CI as `none`, `pending`, `passed`, or `failed`.

The core persists the provider, external id, URL, branch, base/head commits, draft flag, and CI state.
A publication failure is retryable because the remote pull request may have been created before the
controller persisted it. The branch is the idempotency key: a retry finds and updates the same pull
request. A non-draft or mismatched pull request fails closed. Failed CI can never complete a run.

## GitHub adapter

`GitHubPullRequestPublisher` verifies the local head, pushes the controller-owned branch, and uses
the authenticated `gh` CLI to create or reconcile a draft pull request. If the branch's existing pull
request was marked ready, it is converted back to draft before continuing. Required check buckets are
normalized through `gh pr checks`; no required checks remains a visible `none` state rather than
being treated as success. The adapter never invokes merge, auto-merge, or branch-deletion commands.

## Current boundary

The delivery service and deterministic fake-forge coverage are executable, but the public CLI does
not launch it yet. Worker-profile loading, the joined run command, remote-base refresh, and periodic
CI reconciliation are the next controller slice. A real GitHub draft pull request is intentionally
deferred until that joined command can produce the verified workspace it publishes.
