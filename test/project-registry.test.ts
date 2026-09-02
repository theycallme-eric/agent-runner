import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProjectRegistryStore } from "../src/projects/registry.js";

test("persists multiple projects and controller-owned worker profiles across restarts", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-projects-"));
  const databasePath = join(directory, "state.sqlite");
  try {
    const first = new ProjectRegistryStore(databasePath);
    const alpha = first.register({
      id: "example/alpha",
      rootPath: join(directory, "alpha"),
      contractPath: join(directory, "runner-alpha", "project.yml"),
      workerProfile: "claude-fable",
      contractVersion: 1,
      now: 1_000,
    });
    const beta = first.register({
      id: "example/beta",
      rootPath: join(directory, "beta"),
      contractPath: join(directory, "runner-beta", "project.yml"),
      workerProfile: "codex-default",
      contractVersion: 1,
      now: 1_001,
    });
    assert.equal(alpha.created, true);
    assert.equal(beta.created, true);
    first.close();

    const restarted = new ProjectRegistryStore(databasePath);
    assert.deepEqual(
      restarted.list().map((project) => [project.id, project.workerProfile]),
      [
        ["example/alpha", "claude-fable"],
        ["example/beta", "codex-default"],
      ],
    );
    assert.equal(restarted.setEnabled("example/beta", false, 2_000).enabled, false);
    assert.equal(
      restarted.setWorkerProfile("example/alpha", "openhands-local", 2_001).workerProfile,
      "openhands-local",
    );
    restarted.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("registration is idempotent but rejects identity drift", () => {
  const registry = new ProjectRegistryStore();
  const request = {
    id: "example/alpha",
    rootPath: "/projects/alpha",
    contractPath: "/controller/alpha/project.yml",
    workerProfile: "claude-fable",
    contractVersion: 1,
    now: 1_000,
  };
  try {
    assert.equal(registry.register(request).created, true);
    assert.equal(registry.register({ ...request, now: 2_000 }).created, false);
    assert.throws(
      () => registry.register({ ...request, workerProfile: "codex-default" }),
      /already registered with different settings/,
    );
    assert.throws(
      () =>
        registry.register({
          ...request,
          id: "example/other",
        }),
      /Project root is already registered/,
    );
    assert.throws(
      () => registry.register({
        ...request,
        id: "example/injected",
        rootPath: "/projects/injected",
        contractPath: "/projects/injected/.agent-runner.yml",
      }),
      /outside the product root/,
    );
  } finally {
    registry.close();
  }
});
