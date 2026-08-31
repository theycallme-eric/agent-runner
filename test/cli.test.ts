import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("registers and lists a fixture project through the public CLI", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-cli-"));
  const project = join(directory, "project");
  const state = join(directory, "state", "controller.sqlite");
  const cli = resolve("dist/src/cli.js");
  const gh = join(directory, "fake-gh");
  const workerConfig = join(directory, "workers.yml");
  try {
    mkdirSync(project);
    writeFileSync(
      gh,
      `#!/usr/bin/env node
const endpoint = process.argv[3];
if (endpoint === "repos/fixture/cli/issues") {
  process.stdout.write(JSON.stringify([[
    {
      number: 1,
      id: 101,
      node_id: "I_1",
      repository_url: "https://api.github.com/repos/fixture/cli",
      title: "Fixture task",
      body: "Implement the fixture",
      state: "open",
      state_reason: null,
      updated_at: "2026-08-31T12:00:00Z",
      labels: [],
      html_url: "https://github.com/fixture/cli/issues/1"
    }
  ]]));
} else if (endpoint?.endsWith("/dependencies/blocked_by")) {
  process.stdout.write("[[]]");
} else {
  process.stderr.write("Unexpected endpoint: " + endpoint);
  process.exitCode = 1;
}
`,
    );
    chmodSync(gh, 0o755);
    writeFileSync(
      join(project, ".agent-runner.yml"),
      `version: 1
project: { id: fixture/cli, baseBranch: main }
tasks: { provider: github, dependencies: github-native }
workspace: { setup: [] }
verification:
  required: [npm test]
  protectedPaths: []
execution: { concurrency: 1, attempts: 2, timeoutMinutes: 10 }
delivery: { pullRequest: true, merge: never }
`,
    );
    writeFileSync(
      workerConfig,
      `version: 1
profiles:
  fixture-worker:
    adapter: json-process
    name: fixture-agent
    executable: fixture-agent
    environment:
      TOKEN: { fromEnv: CLI_FIXTURE_SECRET }
`,
    );

    const registered = JSON.parse(
      execFileSync(process.execPath, [cli, "register", project, "--worker", "fixture-worker", "--state", state], {
        encoding: "utf8",
      }),
    ) as { created: boolean; project: string; workerProfile: string };
    const status = JSON.parse(
      execFileSync(process.execPath, [cli, "status", "--state", state], { encoding: "utf8" }),
    ) as { projects: Array<{ id: string; workerProfile: string }> };
    const ready = JSON.parse(
      execFileSync(process.execPath, [cli, "ready", "fixture/cli", "--state", state], {
        encoding: "utf8",
        env: { ...process.env, AGENT_RUNNER_GH_BIN: gh },
      }),
    ) as { ready: Array<{ id: string; title: string }>; edges: number };
    const profilesOutput = execFileSync(
      process.execPath,
      [cli, "profiles", "--profiles", workerConfig],
      {
        encoding: "utf8",
        env: { ...process.env, CLI_FIXTURE_SECRET: "must-not-be-printed" },
      },
    );
    const profiles = JSON.parse(profilesOutput) as {
      profiles: Array<{ profile: string; adapter: string; environmentVariables: string[] }>;
    };

    assert.deepEqual(registered, {
      created: true,
      project: "fixture/cli",
      workerProfile: "fixture-worker",
      enabled: true,
    });
    assert.deepEqual(status.projects, [
      {
        id: "fixture/cli",
        rootPath: project,
        workerProfile: "fixture-worker",
        enabled: true,
        contractVersion: 1,
      },
    ]);
    assert.deepEqual(ready.ready, [{ id: "issue-1", title: "Fixture task" }]);
    assert.equal(ready.edges, 0);
    assert.deepEqual(profiles.profiles, [{
      profile: "fixture-worker",
      adapter: "json-process",
      worker: "fixture-agent",
      model: null,
      environmentVariables: ["CLI_FIXTURE_SECRET"],
    }]);
    assert.equal(profilesOutput.includes("must-not-be-printed"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
