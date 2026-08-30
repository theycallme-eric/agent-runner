import assert from "node:assert/strict";
import test from "node:test";

import { SimulatorController } from "../src/core/controller.js";
import { RunStore } from "../src/core/store.js";
import { FixtureRunner } from "../src/execution/fixture-runner.js";
import { parseProjectContract } from "../src/project-contract.js";
import type { WorkerAdapter } from "../src/workers/types.js";
import type { WorkspaceManager } from "../src/workspaces/types.js";

const contract = parseProjectContract(`
version: 1
project: { id: fixture/example, baseBranch: main }
tasks: { provider: github, dependencies: github-native }
workspace: { setup: [] }
verification:
  required: [npm test]
  protectedPaths: []
execution: { concurrency: 1, attempts: 2, timeoutMinutes: 10 }
delivery: { pullRequest: true, merge: never }
`);

test("runs a model-neutral worker in the workspace and verifies it independently", async () => {
  const store = new RunStore();
  let workerWorkspace = "";
  const workspaces: WorkspaceManager = {
    create: async (request) => ({
      path: `/fixture/${request.runId}`,
      branchName: request.branchName,
      baseSha: "base-a",
    }),
  };
  const worker: WorkerAdapter = {
    name: "fake-worker",
    run: async (request) => {
      workerWorkspace = request.workspacePath;
      return {
        status: "succeeded",
        worker: "fake-worker",
        model: request.model,
        sessionId: "session-1",
        summary: "done",
        costUsd: 0,
        durationMs: 1,
      };
    },
  };
  const controller = new SimulatorController(store, contract, {
    verify: () => ({ passed: true, evidence: ["fixture passed"] }),
    checkCi: () => ({ passed: true, evidence: ["fixture CI passed"] }),
  });
  const runner = new FixtureRunner(store, controller, workspaces, worker);

  try {
    const result = await runner.execute({
      claim: {
        projectId: "fixture/example",
        taskId: "APP-01",
        revision: "revision-1",
        baseSha: "base-a",
        workerId: "worker-a",
        now: 1_000,
        leaseDurationMs: 1_000,
        maxAttempts: 2,
      },
      repositoryPath: "/fixture/repository",
      baseRef: "main",
      branchName: "agent/app-01",
      worker: {
        prompt: "Implement APP-01",
        model: "test-model",
        maxBudgetUsd: 1,
        maxTurns: 10,
        timeoutMs: 1_000,
        tools: ["Read", "Edit"],
        settingSources: ["project"],
        persistSession: true,
      },
      changedPaths: ["src/app.ts"],
      headSha: "head-a",
      currentBaseSha: "base-a",
    });

    assert.equal(result.outcome, "executed");
    assert.equal(result.run.state, "completed");
    assert.equal(result.worker.status, "succeeded");
    assert.equal(workerWorkspace, result.workspace.path);
  } finally {
    store.close();
  }
});

test("a worker process failure cannot be reported as completed", async () => {
  const store = new RunStore();
  const workspaces: WorkspaceManager = {
    create: async (request) => ({
      path: `/fixture/${request.runId}`,
      branchName: request.branchName,
      baseSha: "base-a",
    }),
  };
  const worker: WorkerAdapter = {
    name: "fake-worker",
    run: async (request) => ({
      status: "failed",
      worker: "fake-worker",
      model: request.model,
      sessionId: null,
      summary: "process crashed",
      costUsd: null,
      durationMs: 1,
    }),
  };
  const controller = new SimulatorController(store, contract, {
    verify: () => ({ passed: true, evidence: [] }),
    checkCi: () => ({ passed: true, evidence: [] }),
  });
  const runner = new FixtureRunner(store, controller, workspaces, worker);

  try {
    const result = await runner.execute({
      claim: {
        projectId: "fixture/example",
        taskId: "APP-02",
        revision: "revision-1",
        baseSha: "base-a",
        workerId: "worker-a",
        now: 2_000,
        leaseDurationMs: 1_000,
        maxAttempts: 2,
      },
      repositoryPath: "/fixture/repository",
      baseRef: "main",
      branchName: "agent/app-02",
      worker: {
        prompt: "Implement APP-02",
        model: "test-model",
        maxBudgetUsd: 1,
        maxTurns: 10,
        timeoutMs: 1_000,
        tools: [],
        settingSources: ["project"],
        persistSession: true,
      },
      changedPaths: [],
      headSha: "head-b",
      currentBaseSha: "base-a",
    });

    assert.equal(result.run.state, "failed");
    assert.equal(result.run.failureReason, "worker-failed");
  } finally {
    store.close();
  }
});
