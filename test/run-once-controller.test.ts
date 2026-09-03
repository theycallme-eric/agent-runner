import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RunStore } from "../src/core/store.js";
import { PullRequestPublisherRegistry } from "../src/delivery/registry.js";
import { ProjectPlanner } from "../src/planning/project-planner.js";
import { ProjectRegistryStore } from "../src/projects/registry.js";
import { RunOnceController } from "../src/runtime/run-once.js";
import { DependencyResolverRegistry } from "../src/tasks/dependency-registry.js";
import { TaskProviderRegistry } from "../src/tasks/provider-registry.js";
import { WorkerProfileRegistry } from "../src/workers/registry.js";

test("refreshes the base after reconciliation before claiming more work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-post-reconcile-base-"));
  const productPath = join(directory, "product");
  const contractPath = join(directory, "runner", "project.yml");
  mkdirSync(productPath);
  mkdirSync(join(directory, "runner"));
  writeFileSync(contractPath, `version: 1
project: { id: fixture/post-reconcile, baseBranch: main }
tasks: { provider: fixture, dependencies: fixture }
workspace: { setup: [] }
verification: { required: [node --test], protectedPaths: [] }
execution: { concurrency: 1, attempts: 2, timeoutMinutes: 10 }
delivery: { provider: fixture, pullRequest: true, merge: never }
`);

  const projects = new ProjectRegistryStore();
  const runs = new RunStore();
  const providers = new TaskProviderRegistry();
  const dependencies = new DependencyResolverRegistry();
  const workers = new WorkerProfileRegistry();
  const publishers = new PullRequestPublisherRegistry();
  let refreshes = 0;

  projects.register({
    id: "fixture/post-reconcile",
    rootPath: productPath,
    contractPath,
    workerProfile: "fixture",
    contractVersion: 1,
    now: 1,
  });
  providers.register({
    name: "fixture",
    listTasks: async () => [{
      id: "TASK-READY",
      sourceId: "1",
      revision: "revision-a",
      title: "Ready fixture",
      prompt: "Do not run",
      status: "pending",
      dependencies: [],
    }],
  });
  dependencies.register({ name: "fixture", resolve: async (tasks) => tasks });
  workers.register("fixture", { name: "fixture", run: async () => {
    throw new Error("worker must not run");
  } });
  publishers.register({
    name: "fixture",
    publishDraft: async () => { throw new Error("must not publish"); },
    inspectPullRequest: async () => null,
    updateDraft: async () => { throw new Error("must not update"); },
    checkCi: async () => { throw new Error("must not inspect CI"); },
  });

  const unused = async () => { throw new Error("unused fixture dependency"); };
  const controller = new RunOnceController(
    projects,
    runs,
    new ProjectPlanner(runs, providers, dependencies),
    workers,
    { create: unused },
    { resolveRef: unused, snapshot: unused, commit: unused, synchronize: unused },
    {
      inspect: async () => "a".repeat(40),
      refresh: async () => (++refreshes === 1 ? "a" : "b").repeat(40),
    },
    publishers,
    { run: unused },
  );

  try {
    const result = await controller.run({
      projectId: "fixture/post-reconcile",
      controllerId: "fixture-controller",
      leaseDurationMs: 1_000,
      maxClaims: 0,
      dryRun: false,
      targetTaskId: null,
    });

    assert.equal(refreshes, 2);
    assert.equal(result.baseSha, "b".repeat(40));
    assert.deepEqual(result.claimed, []);
    assert.equal(result.limitReached, true);
  } finally {
    runs.close();
    projects.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unpinned required check fails the automatic-merge preflight before any claim", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-unpinned-preflight-"));
  const productPath = join(directory, "product");
  const contractPath = join(directory, "runner", "project.yml");
  mkdirSync(productPath);
  mkdirSync(join(directory, "runner"));
  writeFileSync(contractPath, `version: 1
project: { id: fixture/unpinned, baseBranch: main }
tasks: { provider: fixture, dependencies: fixture }
workspace: { setup: [] }
verification: { required: [node --test], protectedPaths: [] }
execution: { concurrency: 1, attempts: 2, timeoutMinutes: 10 }
delivery: { provider: fixture, pullRequest: true, merge: after-required-checks }
`);

  const projects = new ProjectRegistryStore();
  const runs = new RunStore();
  const providers = new TaskProviderRegistry();
  const dependencies = new DependencyResolverRegistry();
  const workers = new WorkerProfileRegistry();
  const publishers = new PullRequestPublisherRegistry();
  let validations = 0;

  projects.register({
    id: "fixture/unpinned",
    rootPath: productPath,
    contractPath,
    workerProfile: "fixture",
    contractVersion: 1,
    now: 1,
  });
  providers.register({
    name: "fixture",
    listTasks: async () => [{
      id: "TASK-READY",
      sourceId: "1",
      revision: "revision-a",
      title: "Ready fixture",
      prompt: "Do not run",
      status: "pending",
      dependencies: [],
    }],
  });
  dependencies.register({ name: "fixture", resolve: async (tasks) => tasks });
  workers.register("fixture", { name: "fixture", run: async () => {
    throw new Error("worker must not run");
  } });
  publishers.register({
    name: "fixture",
    publishDraft: async () => { throw new Error("must not publish"); },
    inspectPullRequest: async () => null,
    updateDraft: async () => { throw new Error("must not update"); },
    checkCi: async () => { throw new Error("must not inspect CI"); },
    validateAutomaticMerge: async () => {
      validations += 1;
      throw new Error(
        "Automatic merge requires every required check on main to be provided by a specific " +
          "GitHub App. Configure a reporting application for: legacy-status",
      );
    },
    observeRequiredChecks: async () => { throw new Error("must not observe checks"); },
    mergeVerified: async () => { throw new Error("must not merge"); },
  });

  const unused = async () => { throw new Error("unused fixture dependency"); };
  const controller = new RunOnceController(
    projects,
    runs,
    new ProjectPlanner(runs, providers, dependencies),
    workers,
    { create: unused },
    { resolveRef: unused, snapshot: unused, commit: unused, synchronize: unused },
    { inspect: async () => "a".repeat(40), refresh: async () => "a".repeat(40) },
    publishers,
    { run: unused },
  );

  const request = {
    projectId: "fixture/unpinned",
    controllerId: "fixture-controller",
    leaseDurationMs: 1_000,
    maxClaims: 1,
    dryRun: false,
    targetTaskId: null,
  };

  try {
    await assert.rejects(controller.run(request), /specific GitHub App/);
    await assert.rejects(controller.run({ ...request, dryRun: true }), /legacy-status/);

    assert.equal(validations, 2);
    assert.deepEqual(runs.listProject("fixture/unpinned"), []);
  } finally {
    runs.close();
    projects.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

