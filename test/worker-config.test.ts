import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseWorkerProfiles } from "../src/workers/config.js";

test("loads Claude and arbitrary JSON worker profiles without exposing resolved secrets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-profiles-"));
  const claude = join(directory, "fake-claude");
  const generic = join(directory, "fake-worker");
  writeFileSync(claude, claudeScript());
  writeFileSync(generic, jsonWorkerScript());
  chmodSync(claude, 0o755);
  chmodSync(generic, 0o755);
  const secret = "never-print-this-value";
  const source = workerConfig(claude, generic);

  try {
    const loaded = parseWorkerProfiles(source, { FIXTURE_SECRET: secret });

    assert.deepEqual(loaded.registry.list(), [
      { profile: "claude-fable", worker: "claude-code" },
      { profile: "generic-agent", worker: "fixture-json-agent" },
    ]);
    assert.deepEqual(loaded.summaries, [
      {
        profile: "claude-fable",
        adapter: "claude-code",
        worker: "claude-code",
        model: "fable",
        environmentVariables: ["FIXTURE_SECRET"],
      },
      {
        profile: "generic-agent",
        adapter: "json-process",
        worker: "fixture-json-agent",
        model: null,
        environmentVariables: ["FIXTURE_SECRET"],
      },
    ]);
    assert.equal(JSON.stringify(loaded.summaries).includes(secret), false);

    const claudeResult = await loaded.registry.get("claude-fable").run({
      workspacePath: directory,
      prompt: "fixture",
      timeoutMs: 5_000,
    });
    const genericResult = await loaded.registry.get("generic-agent").run({
      workspacePath: directory,
      prompt: "fixture",
      timeoutMs: 5_000,
    });
    assert.equal(claudeResult.status, "succeeded");
    assert.equal(genericResult.status, "succeeded");
    assert.equal(claudeResult.summary, "isolated");
    assert.equal(genericResult.summary, "environment resolved");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("profile configuration fails closed on missing secrets and unsafe executables", () => {
  const valid = `
version: 1
profiles:
  unsafe:
    adapter: json-process
    name: fixture
    executable: worker
    environment:
      TOKEN: { fromEnv: REQUIRED_TOKEN }
`;
  assert.throws(() => parseWorkerProfiles(valid, {}), /missing environment variable REQUIRED_TOKEN/);
  assert.throws(
    () => parseWorkerProfiles(valid.replace("executable: worker", "executable: worker; touch bad"), {
      REQUIRED_TOKEN: "secret",
    }),
    /without shell syntax/,
  );
  assert.throws(
    () => parseWorkerProfiles(valid.replace("{ fromEnv: REQUIRED_TOKEN }", "literal-secret"), {
      REQUIRED_TOKEN: "secret",
    }),
    /must be an object/,
  );
});

test("loads credentials only for selected worker profiles", () => {
  const source = `
version: 1
profiles:
  selected:
    adapter: claude-code
    executable: claude
    model: claude-fable-5
    maxBudgetUsd: 1
    maxTurns: 1
  unused:
    adapter: json-process
    name: unused-worker
    executable: unused-worker
    environment:
      TOKEN: { fromEnv: UNUSED_TOKEN }
`;

  const loaded = parseWorkerProfiles(source, {}, ["selected"]);
  assert.deepEqual(loaded.registry.list(), [{ profile: "selected", worker: "claude-code" }]);
  assert.deepEqual(loaded.summaries.map((summary) => summary.profile), ["selected", "unused"]);
  assert.throws(
    () => parseWorkerProfiles(source, {}, ["unused"]),
    /missing environment variable UNUSED_TOKEN/,
  );
});

test("unknown adapters and fields are rejected instead of ignored", () => {
  assert.throws(
    () => parseWorkerProfiles(`
version: 1
profiles:
  unknown:
    adapter: mystery-agent
`, {}),
    /Unsupported worker adapter/,
  );
  assert.throws(
    () => parseWorkerProfiles(`
version: 1
profiles:
  generic:
    adapter: json-process
    name: fixture
    executable: worker
    surprise: true
`, {}),
    /unknown fields: surprise/,
  );
  assert.throws(
    () => parseWorkerProfiles(`
version: 1
profiles:
  unsafe-claude:
    adapter: claude-code
    model: fable
    maxBudgetUsd: 1
    maxTurns: 1
    permissionMode: bypassPermissions
`, {}),
    /must be dontAsk or acceptEdits/,
  );
});

function workerConfig(claude: string, generic: string): string {
  return `
version: 1
profiles:
  claude-fable:
    adapter: claude-code
    executable: ${claude}
    model: fable
    maxBudgetUsd: 2
    maxTurns: 5
    permissionMode: acceptEdits
    environment:
      FIXTURE_TOKEN: { fromEnv: FIXTURE_SECRET }
  generic-agent:
    adapter: json-process
    name: fixture-json-agent
    executable: ${generic}
    arguments: [--fixture]
    environment:
      FIXTURE_TOKEN: { fromEnv: FIXTURE_SECRET }
`;
}

function claudeScript(): string {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
  const isolated = process.env.FIXTURE_TOKEN === "never-print-this-value"
  && args.includes("--strict-mcp-config")
  && args.includes("--no-chrome")
  && args.includes("--no-session-persistence")
  && args[args.indexOf("--permission-mode") + 1] === "acceptEdits"
  && args[args.indexOf("--setting-sources") + 1] === "";
process.stdout.write(JSON.stringify({
  type: "result",
  subtype: "success",
  result: isolated ? "isolated" : "unsafe",
  session_id: "session-1",
  is_error: !isolated,
  total_cost_usd: 0,
  duration_ms: 1
}));
`;
}

function jsonWorkerScript(): string {
  return `#!/usr/bin/env node
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const resolved = process.env.FIXTURE_TOKEN === "never-print-this-value";
  process.stdout.write(JSON.stringify({
    status: resolved && request.protocolVersion === 1 ? "succeeded" : "failed",
    model: null,
    sessionId: "session-2",
    summary: resolved ? "environment resolved" : "missing environment",
    durationMs: 1
  }));
});
`;
}
