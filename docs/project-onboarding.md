# Project onboarding and planning

Agent Runner is built without access to any consumer project. Repository-owned fixtures prove the
contract first; real project locations are supplied only when an owner chooses to register them.

## Ownership boundary

The product repository owns:

- `.agent-runner.yml`
- requirements and tasks
- dependency truth
- setup and verification commands
- protected paths and delivery policy

Controller state owns:

- the absolute project and contract locations
- whether the project is enabled
- the selected worker profile, such as `claude-fable` or `codex-default`
- runs, leases, attempts, evidence, and lifecycle events

Worker and model selection therefore changes without editing the product repository.

## Registration

```text
agent-runner register /path/to/project --worker <profile>
```

Registration reads `/path/to/project/.agent-runner.yml`, validates it, and creates an idempotent
registry record. Reusing the same project id or root with different settings fails visibly instead
of silently redirecting work. The default controller database is
`~/.local/state/agent-runner/state.sqlite`; `--state` and `AGENT_RUNNER_STATE_PATH` override it.

## Task and dependency plug-ins

The contract names two controller-installed plug-ins:

```yaml
tasks:
  provider: github
  dependencies: github-native
  config:
    includeLabels: [agent:task]
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

## Multi-project isolation

Each project resolves its own task provider, dependency resolver, worker profile, concurrency limit,
and retry limit. Claims are unique by project, task id, and task revision. Per-project concurrency is
checked in the same SQLite transaction as the claim, so separate controller processes cannot exceed
the declared worker capacity.

Registration, profile listing, readiness, and `run-once --dry-run` do not launch a coding agent.
Mutating execution begins only at explicit `run-once`, which consumes claims through the normalized
worker interface and can publish drafts through the separately selected delivery adapter.
