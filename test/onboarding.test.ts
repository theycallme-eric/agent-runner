import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { onboardProject } from "../src/projects/onboarding.js";
import { ProjectRegistryStore } from "../src/projects/registry.js";

test("onboards a project from only its standard contract and controller worker choice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-onboard-"));
  writeFileSync(
    join(directory, ".agent-runner.yml"),
    `version: 1
project: { id: fixture/onboard, baseBranch: main }
tasks: { provider: any-provider, dependencies: any-dag }
workspace: { setup: [] }
verification:
  required: [npm test]
  protectedPaths: []
execution: { concurrency: 1, attempts: 2, timeoutMinutes: 10 }
delivery: { pullRequest: true, merge: never }
`,
  );
  const registry = new ProjectRegistryStore();
  try {
    const result = await onboardProject(registry, {
      rootPath: directory,
      workerProfile: "any-worker",
      now: 1_000,
    });

    assert.equal(result.created, true);
    assert.equal(result.project.id, "fixture/onboard");
    assert.equal(result.project.workerProfile, "any-worker");
    assert.equal(result.project.contractPath, join(directory, ".agent-runner.yml"));
  } finally {
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
