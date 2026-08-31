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
workspace, synchronizes against the current base, runs project verification, evaluates protected
paths, and observes CI before changing delivery state.
