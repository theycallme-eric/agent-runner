import assert from "node:assert/strict";
import test from "node:test";

import { SimulatorController, type ControllerServices } from "../src/core/controller.js";
import { RunStore } from "../src/core/store.js";
import type { RunRecord } from "../src/core/types.js";
import { parseProjectContract, type ProjectContract } from "../src/project-contract.js";

const contract = parseProjectContract(`
version: 1
project:
  id: fixture/example
  baseBranch: main
tasks:
  provider: github
  dependencies: github-native
workspace:
  setup: []
verification:
  required:
    - npm test
  protectedPaths:
    - pattern: .github/workflows/**
      gate: human
execution:
  concurrency: 2
  attempts: 2
  timeoutMinutes: 120
delivery:
  pullRequest: true
  merge: never
`);

function setup(
  services: ControllerServices,
  selectedContract: ProjectContract = contract,
): { store: RunStore; controller: SimulatorController; run: RunRecord } {
  const store = new RunStore();
  const claim = store.claim({
    projectId: "fixture/example",
    taskId: "APP-01",
    revision: "revision-1",
    baseSha: "base-a",
    workerId: "worker-a",
    now: 1_000,
    leaseDurationMs: 1_000,
    maxAttempts: 2,
  });
  assert.equal(claim.claimed, true);
  const controller = new SimulatorController(store, selectedContract, services);
  const run = controller.prepare(claim.run.id, 1_010);
  return { store, controller, run };
}

const passingServices: ControllerServices = {
  verify: () => ({ passed: true, evidence: ["tests passed"] }),
  checkCi: () => ({ passed: true, evidence: ["CI passed"] }),
};

test("controller verification rejects a worker's false success report", () => {
  const context = setup({
    ...passingServices,
    verify: () => ({ passed: false, evidence: ["tests failed"] }),
  });
  try {
    const result = context.controller.finish({
      runId: context.run.id,
      workerResult: {
        reportedSuccess: true,
        headSha: "head-a",
        changedPaths: ["src/app.ts"],
      },
      currentBaseSha: "base-a",
      now: 1_020,
    });

    assert.equal(result.state, "failed");
    assert.equal(result.failureReason, "verification-failed");
  } finally {
    context.store.close();
  }
});

test("an advanced base branch forces synchronization and complete reverification", () => {
  let verificationCalls = 0;
  const context = setup({
    ...passingServices,
    verify: () => {
      verificationCalls += 1;
      return { passed: true, evidence: [`verification ${verificationCalls}`] };
    },
  });
  try {
    const result = context.controller.finish({
      runId: context.run.id,
      workerResult: {
        reportedSuccess: true,
        headSha: "head-a",
        changedPaths: ["src/app.ts"],
      },
      currentBaseSha: "base-b",
      now: 1_020,
    });

    assert.equal(result.state, "completed");
    assert.equal(result.baseSha, "base-b");
    assert.equal(result.requiresReverification, false);
    assert.equal(verificationCalls, 2);
    assert.ok(
      context.store
        .events(result.id)
        .some((event) => event.type === "transition" && JSON.stringify(event.detail).includes("synchronized")),
    );
  } finally {
    context.store.close();
  }
});

test("protected-path changes stop at a visible human gate", () => {
  let ciCalls = 0;
  const context = setup({
    verify: passingServices.verify,
    checkCi: () => {
      ciCalls += 1;
      return { passed: true, evidence: ["CI passed"] };
    },
  });
  try {
    const result = context.controller.finish({
      runId: context.run.id,
      workerResult: {
        reportedSuccess: true,
        headSha: "head-a",
        changedPaths: [".github/workflows/ci.yml"],
      },
      currentBaseSha: "base-a",
      now: 1_020,
    });

    assert.equal(result.state, "waiting-human");
    assert.equal(ciCalls, 0);
  } finally {
    context.store.close();
  }
});

test("failing CI is recorded as a terminal controller failure", () => {
  const context = setup({
    verify: passingServices.verify,
    checkCi: () => ({ passed: false, evidence: ["CI failed"] }),
  });
  try {
    const result = context.controller.finish({
      runId: context.run.id,
      workerResult: {
        reportedSuccess: true,
        headSha: "head-a",
        changedPaths: ["src/app.ts"],
      },
      currentBaseSha: "base-a",
      now: 1_020,
    });

    assert.equal(result.state, "failed");
    assert.equal(result.failureReason, "ci-failed");
  } finally {
    context.store.close();
  }
});
