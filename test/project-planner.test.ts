import assert from "node:assert/strict";
import test from "node:test";

import { RunStore } from "../src/core/store.js";
import { ProjectPlanner } from "../src/planning/project-planner.js";
import { parseProjectContract } from "../src/project-contract.js";
import type { ProjectRegistration } from "../src/projects/types.js";
import { TaskProviderRegistry } from "../src/tasks/provider-registry.js";
import { DependencyResolverRegistry } from "../src/tasks/dependency-registry.js";
import type { TaskNode } from "../src/tasks/types.js";

function contract(id: string, provider: string, concurrency: number) {
  return parseProjectContract(`
version: 1
project: { id: ${id}, baseBranch: main }
tasks: { provider: ${provider}, dependencies: embedded-dag }
workspace: { setup: [] }
verification:
  required: [npm test]
  protectedPaths: []
execution: { concurrency: ${concurrency}, attempts: 2, timeoutMinutes: 10 }
delivery: { pullRequest: true, merge: never }
`);
}

function registration(id: string, workerProfile: string): ProjectRegistration {
  return {
    id,
    rootPath: `/projects/${id}`,
    contractPath: `/projects/${id}/.agent-runner.yml`,
    workerProfile,
    enabled: true,
    contractVersion: 1,
    registeredAt: 1_000,
    updatedAt: 1_000,
  };
}

function task(id: string, dependencies: string[] = []): TaskNode {
  return {
    id,
    sourceId: id,
    revision: `${id}-revision`,
    title: id,
    prompt: `Implement ${id}`,
    status: "pending",
    dependencies,
  };
}

test("plans independent projects through different providers and worker profiles", async () => {
  const runs = new RunStore();
  const providers = new TaskProviderRegistry();
  const dependencies = new DependencyResolverRegistry();
  dependencies.register({
    name: "embedded-dag",
    resolve: async (tasks) => tasks,
  });
  providers.register({
    name: "alpha-tasks",
    listTasks: async () => [task("A-01"), task("A-02")],
  });
  providers.register({
    name: "beta-tasks",
    listTasks: async () => [task("B-01")],
  });
  const planner = new ProjectPlanner(runs, providers, dependencies);
  try {
    const alpha = await planner.claimReady({
      project: registration("example/alpha", "claude-fable"),
      contract: contract("example/alpha", "alpha-tasks", 1),
      baseSha: "alpha-base",
      controllerId: "controller-1",
      now: 1_000,
      leaseDurationMs: 1_000,
    });
    const beta = await planner.claimReady({
      project: registration("example/beta", "codex-default"),
      contract: contract("example/beta", "beta-tasks", 2),
      baseSha: "beta-base",
      controllerId: "controller-1",
      now: 1_000,
      leaseDurationMs: 1_000,
    });

    assert.deepEqual(alpha.claimed.map(({ task }) => task.id), ["A-01"]);
    assert.equal(alpha.dependencies, "embedded-dag");
    assert.equal(alpha.claimed[0]?.workerProfile, "claude-fable");
    assert.equal(alpha.capacityReached, true);
    assert.deepEqual(beta.claimed.map(({ task }) => task.id), ["B-01"]);
    assert.equal(beta.claimed[0]?.workerProfile, "codex-default");
    assert.equal(runs.activeCount("example/alpha"), 1);
    assert.equal(runs.activeCount("example/beta"), 1);
  } finally {
    runs.close();
  }
});

test("replanning the same task revision never creates a second run", async () => {
  const runs = new RunStore();
  const providers = new TaskProviderRegistry();
  const dependencies = new DependencyResolverRegistry();
  dependencies.register({ name: "embedded-dag", resolve: async (tasks) => tasks });
  providers.register({ name: "fixture", listTasks: async () => [task("ONE")] });
  const planner = new ProjectPlanner(runs, providers, dependencies);
  const request = {
    project: registration("example/one", "worker-one"),
    contract: contract("example/one", "fixture", 2),
    baseSha: "base",
    controllerId: "controller-1",
    now: 1_000,
    leaseDurationMs: 1_000,
  };
  try {
    assert.equal((await planner.claimReady(request)).claimed.length, 1);
    const second = await planner.claimReady({ ...request, controllerId: "controller-2" });
    assert.deepEqual(second.duplicateTaskIds, ["ONE"]);
    assert.equal(second.claimed.length, 0);
  } finally {
    runs.close();
  }
});

test("an explicit claim limit can be lower than project concurrency", async () => {
  const runs = new RunStore();
  const providers = new TaskProviderRegistry();
  const dependencies = new DependencyResolverRegistry();
  dependencies.register({ name: "embedded-dag", resolve: async (tasks) => tasks });
  providers.register({ name: "fixture", listTasks: async () => [task("ONE"), task("TWO")] });
  const planner = new ProjectPlanner(runs, providers, dependencies);
  try {
    const result = await planner.claimReady({
      project: registration("example/limited", "worker-one"),
      contract: contract("example/limited", "fixture", 2),
      baseSha: "base",
      controllerId: "controller-1",
      now: 1_000,
      leaseDurationMs: 1_000,
      maxClaims: 1,
    });

    assert.equal(result.claimed.length, 1);
    assert.equal(result.limitReached, true);
    assert.equal(result.capacityReached, false);
    assert.equal(runs.activeCount("example/limited"), 1);
  } finally {
    runs.close();
  }
});
