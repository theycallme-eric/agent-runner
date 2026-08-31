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
  }): Promise<WorkerOutcome>;
}
```

Model names, authentication, tools, turn limits, and provider-specific settings belong to an adapter
or controller installation. They are not project requirements and do not appear in
`.agent-runner.yml`.

The controller registry maps a project to a named worker profile. `WorkerProfileRegistry` resolves
that profile to a configured adapter at execution time, so the claim and lifecycle code never needs
to know which agent or model is behind it.

## Native adapters

`ClaudeCodeWorker` invokes Claude Code with explicit model, tool, permission, setting-source, MCP,
session, turn, budget, and timeout choices. CLEAR's first worker selection is Fable, but changing
that selection does not change the controller or CLEAR's contract.

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
  "timeoutMs": 120000
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

## Trust boundary

A worker success report is never sufficient to complete a run. Agent Runner independently checks the
workspace, runs project verification, rejects an advanced base, evaluates protected paths, and
records a committed verified head. The simulator proves full re-verification after synchronization;
the concrete executor currently stops safely on an advanced base until reconciliation is connected.
CI and pull-request state belong to the next delivery slice.
