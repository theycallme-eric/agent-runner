#!/usr/bin/env node

import { ClaudeCodeWorker } from "./workers/claude-code.js";

const worker = new ClaudeCodeWorker({
  executable: process.env.AGENT_RUNNER_CLAUDE_BIN ?? "claude",
  model: "claude-fable-5",
  maxBudgetUsd: 0.1,
  maxTurns: 1,
  tools: [],
  settingSources: [],
  persistSession: false,
});
const outcome = await worker.run({
  workspacePath: process.cwd(),
  prompt: "Reply with exactly FABLE_READY. Do not inspect, create, edit, or delete any files.",
  timeoutMs: 120_000,
});

console.log(
  JSON.stringify(
    {
      status: outcome.status,
      worker: outcome.worker,
      model: outcome.model,
      sessionIdPresent: outcome.sessionId !== null,
      summary: outcome.summary,
      costUsd: outcome.costUsd,
      durationMs: outcome.durationMs,
    },
    null,
    2,
  ),
);
process.exitCode = outcome.status === "succeeded" && outcome.summary.trim() === "FABLE_READY" ? 0 : 1;
