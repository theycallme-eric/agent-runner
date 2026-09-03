# Project onboarding and planning

Agent Runner is built without access to any consumer project. Synthetic tool fixtures prove the
contract first; real project locations are supplied only when an owner chooses to register them.

## Ownership boundary

The product repository owns:

- product source and product-native development instructions
- its Git history, branches, and remotes
- no Agent Runner installation, contract, pointer, or required support file

The external project workspace owns:

- `runner/project.yml`, including task/dependency providers, setup and verification commands,
  protected paths, concurrency, attempts, timeouts, and delivery policy
- controller database, isolated worktrees, and reports

Controller registration owns:

- the canonical product-repository and external-contract locations
- whether the project is enabled
- the selected worker profile, such as `claude-fable` or `codex-default`
- runs, leases, attempts, evidence, and lifecycle events

Worker and model selection therefore changes without editing the product repository.

## Registration

```text
agent-runner register /path/to/product-repository \
  --contract /path/to/project-workspace/runner/project.yml \
  --worker <profile>
```

Registration requires both locations explicitly, resolves symlinks, validates the contract, verifies
that the product path is the Git working-tree root, and creates an idempotent registry record. It
rejects a contract inside the product repository. For GitHub-backed task or delivery adapters, it
also reads the configured `origin` URL locally and requires it to match `project.id`; registration
does not make a network call or change the repository.

Reusing the same project id or root with different settings fails visibly instead of silently
redirecting work. The default controller database is
`~/.local/state/agent-runner/state.sqlite`; a project-support workspace should pass a path under
its external `runner/state/` directory with `--state` or `AGENT_RUNNER_STATE_PATH`.

## Task and dependency plug-ins

The contract names two controller-installed plug-ins:

```yaml
tasks:
  provider: github
  dependencies: github-native
  config:
    includeLabels: [agent:task]
    approvedHandoff: ../requirements/APPROVED_HANDOFF.json
```

Delivery selects its own plug-in so task discovery and pull-request hosting are not coupled:

```yaml
delivery:
  provider: github
  pullRequest: true
  merge: never
```

The task provider normalizes task id, revision, title, prompt, status, and dependency references. The
dependency resolver may preserve those references or derive them from another source. Neither name
is hard-coded in the contract parser. `config` is an optional provider-owned object; the core stores
it without interpreting GitHub labels or another provider's selection language.

Before a task can be claimed, the planner rejects duplicate ids, missing dependencies, duplicate
edges, self-dependencies, and cycles. A pending task is ready only when every dependency is complete.
Ready tasks are ordered deterministically by id.

For a Requirements Builder project, `approvedHandoff` is required by the workflow even though the
generic GitHub adapter retains its legacy label-only mode for separately managed task sources. The
handoff, active pointer, and approval record stay in the external project workspace. None may be
placed in the product repository.

## Multi-project isolation

Each project resolves its own task provider, dependency resolver, worker profile, concurrency limit,
and retry limit. Claims are unique by project, task id, and task revision. Per-project concurrency is
checked in the same SQLite transaction as the claim, so separate controller processes cannot exceed
the declared worker capacity.

Registration, project status, profile listing, readiness, and `run-once --dry-run` do not modify the
product or launch a coding agent. Mutating execution begins only at explicit `run-once`, which
consumes claims through the normalized worker interface and can publish drafts through the
separately selected delivery adapter.

## Explicit repository creation

When a product repository does not exist, creation is a separate owner-authorized action:

```text
agent-runner create-project /path/to/new-product-repository \
  --contract /path/to/project-workspace/runner/project.yml \
  --worker <profile> --visibility <public|private> --confirm-create
```

The command requires the external contract first so the GitHub repository identity and base branch
are explicit. It refuses a contract inside the product path, a non-empty non-repository folder, an
existing repository without an origin, a mismatched origin, a mismatched GitHub identity, or a
different visibility than requested. It creates an empty local Git repository, an empty
initialization commit, the GitHub repository and origin, pushes the configured base branch, and
registers the project. It does not add README, license, support-tooling files, or product
configuration.

Repeating the exact successful request verifies the same GitHub identity and visibility, observes
the existing base branch, and reuses the registration without creating or pushing again. A real use
still requires explicit owner authorization because it creates a remote repository; deterministic
tests use a fake GitHub executable and local bare remote.
