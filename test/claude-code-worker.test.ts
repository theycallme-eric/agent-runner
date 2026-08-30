import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ClaudeCodeWorker } from "../src/workers/claude-code.js";

test("normalizes Claude Code JSON without depending on a live model", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-claude-"));
  const executable = join(directory, "fake-claude");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const settingIndex = args.indexOf("--setting-sources");
const isolated = args.includes("--strict-mcp-config")
  && args.includes("--no-chrome")
  && args.includes("--disable-slash-commands")
  && args[settingIndex + 1] === ""
  && process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1";
process.stdout.write(JSON.stringify({
  result: isolated ? "fixture complete" : "not isolated",
  session_id: "session-1",
  is_error: !isolated,
  total_cost_usd: 0.01,
  duration_ms: 12
}));
`,
  );
  chmodSync(executable, 0o755);

  try {
    const worker = new ClaudeCodeWorker(executable);
    const result = await worker.run({
      workspacePath: directory,
      prompt: "Run the fixture",
      model: "fixture-model",
      maxBudgetUsd: 1,
      maxTurns: 3,
      timeoutMs: 1_000,
      tools: [],
      settingSources: [],
      persistSession: false,
    });

    assert.deepEqual(result, {
      status: "succeeded",
      worker: "claude-code",
      model: "fixture-model",
      sessionId: "session-1",
      summary: "fixture complete",
      costUsd: 0.01,
      durationMs: 12,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects missing spend and timeout limits before launching Claude", () => {
  const worker = new ClaudeCodeWorker("unused");

  assert.throws(
    () =>
      worker.run({
        workspacePath: "/tmp",
        prompt: "Run the fixture",
        model: "fixture-model",
        maxBudgetUsd: 0,
        maxTurns: 0,
        timeoutMs: 0,
        tools: [],
        settingSources: [],
        persistSession: false,
      }),
    /maxBudgetUsd must be greater than zero/,
  );
});
