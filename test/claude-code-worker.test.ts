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
const addDirIndex = args.indexOf("--add-dir");
const isolated = args.includes("--strict-mcp-config")
  && args.includes("--no-chrome")
  && args.includes("--disable-slash-commands")
  && args[settingIndex + 1] === ""
  && args[addDirIndex + 1] === ${JSON.stringify(join(directory, "evidence"))}
  && process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1";
process.stdout.write(JSON.stringify({
  type: "result",
  subtype: "success",
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
    const worker = new ClaudeCodeWorker({
      executable,
      model: "fixture-model",
      maxBudgetUsd: 1,
      maxTurns: 3,
      tools: [],
      settingSources: [],
      persistSession: false,
    });
    const result = await worker.run({
      workspacePath: directory,
      prompt: "Run the fixture",
      timeoutMs: 1_000,
      additionalDirectories: [join(directory, "evidence")],
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

test("treats a max-turn result as a failed worker outcome", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-claude-turns-"));
  const executable = join(directory, "fake-claude");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: "result",
  subtype: "error_max_turns",
  is_error: false,
  num_turns: 50,
  session_id: "session-turn-limit",
  total_cost_usd: 0.25,
  duration_ms: 42
}));
`,
  );
  chmodSync(executable, 0o755);

  try {
    const worker = new ClaudeCodeWorker({
      executable,
      model: "fixture-model",
      maxBudgetUsd: 1,
      maxTurns: 50,
      tools: [],
      settingSources: [],
      persistSession: false,
    });
    const result = await worker.run({
      workspacePath: directory,
      prompt: "Run until the configured limit",
      timeoutMs: 1_000,
    });

    assert.equal(result.status, "failed");
    assert.match(result.summary, /error_max_turns after 50 turns/);
    assert.equal(result.sessionId, "session-turn-limit");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects invalid Claude-specific limits during adapter construction", () => {
  assert.throws(
    () =>
      new ClaudeCodeWorker({
        executable: "unused",
        model: "fixture-model",
        maxBudgetUsd: 0,
        maxTurns: 0,
        tools: [],
        settingSources: [],
        persistSession: false,
      }),
    /maxBudgetUsd must be greater than zero/,
  );
});
