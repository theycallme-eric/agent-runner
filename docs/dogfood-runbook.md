# Live dogfood runbook

Checklist for running a repository-owned task through the public `run-once` command against the real
GitHub repository. Follow it in order; every step is bounded and fail-closed. This document describes
the procedure only — actual run evidence belongs in [the implementation log](implementation-log.md),
appended by the controller operator after each run, not asserted here in advance.

## Preconditions

- The target issue is labeled `agent:task`, has no unresolved `blocked by` relationships, and its
  scope is small enough for one bounded worker session.
- The repository is registered in controller state and its checked-in `.agent-runner.yml` validates.
- A controller-owned, non-secret worker profile exists in the local profile config. The profile — not
  the project contract — selects the agent, model, and permission mode, so the worker remains
  replaceable without touching the repository.
- The authenticated `gh` CLI and Git remote access work for the operator running the command.

## 1. Dry run first

Run `run-once <project-id> --dry-run --profiles <path>` and read the JSON result before any mutation.
The dry run must validate the registration, contract, worker profile, delivery adapter, remote base,
and complete task DAG, and must report the intended target. It may make read-only forge and Git
calls; it must not claim a task, create a worktree, launch a worker, push, or publish. Do not proceed
until the dry run selects the intended task against the expected remote base commit.

## 2. Bounded claim

Run the mutating command with an explicit bound: `--limit 1`, and `--task <normalized-id>` (for
GitHub, `issue-7`) whenever more than one task is ready. The claim is atomic with a lease; a task
revision already in the run ledger is never claimed twice. An unknown, waiting, blocked, or completed
selection must fail before any claim is made.

## 3. Isolated workspace

The controller creates a fresh worktree at the exact fetched remote base commit and runs the
contract's setup commands there. The worker operates only inside that worktree with
controller-selected settings — no inherited user or local configuration, no MCP state, and an
explicit permission mode, turn limit, and wall-clock timeout. The main checkout is never modified.

## 4. Independent verification

The controller — never the worker — decides success. It re-reads the workspace, requires at least one
changed path, runs the contract's verification commands itself, and commits the verified head. A
worker crash, a success report without changes, a failed verification command, an out-of-scope or
protected-path change, or a base branch that advances before the head is recorded all fail the run
closed. Verification evidence (base and head commits, workspace, session, attempt) is persisted.

## 5. Draft-only publication

Delivery starts only from a controller-owned `verified` run. The GitHub adapter pushes the verified
branch and creates or reconciles exactly one open draft pull request, with the branch as the
idempotency key. A pull request that was marked ready is converted back to draft; a non-draft or
mismatched pull request fails closed. Agent Runner never merges, enables auto-merge, or deletes
branches — a human reviews and merges every dogfood pull request.

## 6. Repeat reconciliation

Run the same `run-once` command again after publication. The repeated run must reconcile the
persisted branch and pull request and re-poll CI without a second claim, worker invocation, or new
pull request. Completed and failed runs remain visible duplicates. If the repeat run claims anything
or launches a worker, stop and treat it as a defect.

## 7. Evidence to record

Append a factual entry to [the implementation log](implementation-log.md) after every live run,
successful or not:

- task id and revision, run id, and final state, including failures and their corrections;
- worker profile id, adapter, and model (non-secret metadata only — never resolved credentials);
- for Claude-based workers: Claude Code version, model, execution mode, permission mode, budget or
  usage estimate, and whether the session was local or managed;
- base and verified head commits, workspace path, worker session id, duration, and cost estimate;
- verification commands run and their outcomes;
- pull-request URL, draft state, and CI state;
- remaining gaps or follow-on decisions.

## 8. Stop conditions

Stop the run — and do not retry blindly — when any of the following occurs:

- the dry run fails, targets the wrong task, or reports an unexpected base commit;
- the claim, workspace setup, or worker session fails or exceeds its lease, turn, or time budget;
- verification fails, the diff touches protected or out-of-scope paths, or a human gate is raised;
- publication produces anything other than exactly one draft pull request, or CI fails;
- usage or cost exceeds the budget configured for the profile;
- any step would require a secret, credential, or permission escalation not already in the profile.

After a stop, record the failure and correction in the implementation log, fix the cause, and start
again from the dry run. A failed run's ledger entry is immutable; retries use a new task revision or
run rather than rewriting history.
