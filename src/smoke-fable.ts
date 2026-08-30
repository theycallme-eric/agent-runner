#!/usr/bin/env node

import { ClaudeCodeWorker } from "./workers/claude-code.js";

const worker = new ClaudeCodeWorker(process.env.AGENT_RUNNER_CLAUDE_BIN ?? "claude");
const outcome = await worker.run({
  workspacePath: process.cwd(),
  prompt: "Reply with exactly FABLE_READY. Do not inspect, create, edit, or delete any files.",
  model: "fable",
  maxBudgetUsd: 0.1,
  maxTurns: 1,
  timeoutMs: 120_000,
  tools: [],
  settingSources: [],
  persistSession: false,
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
