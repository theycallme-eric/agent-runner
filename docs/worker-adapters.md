# Worker adapters

Agent Runner controls task ownership, workspace isolation, verification, and delivery. A coding agent
controls only the implementation attempt inside the workspace. The boundary is intentionally small:

```ts
interface WorkerAdapter {
  readonly name: string;
  run(request: {
    workspacePath: string;
    prompt: string;
    timeoutMs: number;
    additionalDirectories?: string[];
    allowedCommands?: string[];
  }): Promise<WorkerOutcome>;
}
```

Model names, authentication, tools, turn limits, and provider-specific settings belong to an adapter
or controller installation. They are not product-repository requirements and do not appear in the
external per-project contract.

The controller registry maps a project to a named worker profile. `WorkerProfileRegistry` resolves
that profile to a configured adapter at execution time, so the claim and lifecycle code never needs
to know which agent or model is behind it.

## Controller-owned profiles

Worker profiles live in a versioned local YAML file, not in product repositories. The default is
`~/.config/agent-runner/workers.yml`; `AGENT_RUNNER_WORKER_CONFIG` or the CLI `--profiles` option may
select another location. A complete non-secret template is available at
[`examples/workers.yml`](../examples/workers.yml).

Claude profiles require an explicit model, turn limit, and local usage guard. Tool selection,
setting sources, session persistence, and executable have isolated defaults when omitted. JSON
process profiles name an executable and optional argument list. Both adapters accept environment
entries only as references:

```yaml
environment:
  PROVIDER_TOKEN:
    fromEnv: PROVIDER_TOKEN
```

The loader resolves the value only in memory. Status output reports the source variable name, never
the value. Inline environment values, missing variables, unknown fields/adapters, duplicate profile
ids, and executable strings containing shell syntax fail closed.

Claude permission mode is also explicit. `dontAsk` is the default and auto-denies operations that
would prompt in a headless run. `acceptEdits` allows file Write/Edit operations inside the isolated
worktree while retaining normal permission checks for other tools. `bypassPermissions` is not a
valid profile value.

## Native adapters

`ClaudeCodeWorker` invokes Claude Code with explicit model, tool, permission, setting-source, MCP,
session, turn, budget, timeout, and controller-approved additional-directory choices. The latter is
used for a read-only evidence snapshot outside the product worktree. The live acceptance proof
selected Fable, but changing that selection does not change the controller or a product's contract.

Native Codex, OpenHands, or other adapters can implement `WorkerAdapter` when their richer event and
resume semantics are useful.

## JSON process protocol

`JsonProcessWorker` is the universal compatibility path. It starts a configured executable in the
isolated workspace and writes one JSON request to standard input:

```json
{
  "protocolVersion": 1,
  "workspacePath": "/isolated/worktree",
  "prompt": "Implement task APP-01",
  "timeoutMs": 120000,
  "additionalDirectories": ["/controller/evidence/run-attempt"],
  "allowedCommands": ["npm test"]
}
```

The executable returns one JSON object on standard output:

```json
{
  "status": "succeeded",
  "model": "optional-model-name",
  "sessionId": "optional-session-id",
  "summary": "Implementation completed",
  "costUsd": null,
  "durationMs": 42000
}
```

Valid statuses are `succeeded`, `failed`, and `timed-out`. Invalid JSON, non-zero exit, timeout, or a
missing status/summary fails closed. The wrapper may call a CLI, SDK, local model, or remote service;
the controller treats all of them identically after normalization.

Claude's JSON result is accepted as worker success only when its documented `type` is `result`, its
`subtype` is `success`, `is_error` is false, and a text result is present. A clean process exit with
`error_max_turns`, another error subtype, or no result is a worker failure—not a completed attempt.
The task prompt names every controller verification command verbatim and tells the worker to run and
fix them before reporting success; the controller still reruns them independently.

For Claude, those exact commands are also passed as scoped `Bash(<command>)` allowlist entries. This
lets a headless worker run the checks it has already been instructed to satisfy without granting
unrestricted shell access. The allowlist comes only from the approved task verification expectations
and the external project contract; other terminal commands retain Claude's normal permission rules.
The provider-neutral JSON request carries the same `allowedCommands` list for wrappers to enforce.

## Trust boundary

A worker success report is never sufficient to complete a run. Agent Runner independently checks the
workspace, runs project verification, rejects an advanced base during the initial attempt, evaluates
protected paths, and records a committed verified head. Reconciliation synchronizes an advanced
base, repeats all required verification, and updates the same pull request only after the new head
passes. The separate delivery coordinator owns pull-request identity, CI observation, and any
policy-authorized exact-head merge without granting that authority to the worker.
