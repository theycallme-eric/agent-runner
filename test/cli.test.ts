import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("registers and lists a fixture project through the public CLI", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-cli-"));
  const project = join(directory, "project");
  const state = join(directory, "state", "controller.sqlite");
  const cli = resolve("dist/src/cli.js");
  try {
    mkdirSync(project);
    writeFileSync(
      join(project, ".agent-runner.yml"),
      `version: 1
project: { id: fixture/cli, baseBranch: main }
tasks: { provider: fixture, dependencies: fixture-dag }
workspace: { setup: [] }
verification:
  required: [npm test]
  protectedPaths: []
execution: { concurrency: 1, attempts: 2, timeoutMinutes: 10 }
delivery: { pullRequest: true, merge: never }
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
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
