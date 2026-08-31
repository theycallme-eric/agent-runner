import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonProcessWorker } from "../src/workers/json-process.js";

test("runs any worker that implements the versioned JSON process protocol", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-json-worker-"));
  const executable = join(directory, "worker");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  process.stdout.write(JSON.stringify({
    status: request.protocolVersion === 1 ? "succeeded" : "failed",
    model: "arbitrary-model",
    sessionId: "arbitrary-session",
    summary: request.prompt,
    durationMs: 5
  }));
});
`,
  );
  chmodSync(executable, 0o755);

  try {
    const worker = new JsonProcessWorker({ name: "arbitrary-agent", executable });
    const result = await worker.run({
      workspacePath: directory,
      prompt: "Implement the fixture task",
      timeoutMs: 1_000,
    });

    assert.equal(result.status, "succeeded");
    assert.equal(result.worker, "arbitrary-agent");
    assert.equal(result.model, "arbitrary-model");
    assert.equal(result.summary, "Implement the fixture task");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
