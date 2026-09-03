import assert from "node:assert/strict";
import test from "node:test";

import { RunStore } from "../src/core/store.js";
import type { PullRequestPublisher, PullRequestSnapshot } from "../src/delivery/types.js";
import type { CommandRunner } from "../src/execution/command-runner.js";
import type { ProjectInspection } from "../src/planning/project-planner.js";
import { parseProjectContract } from "../src/project-contract.js";
import type { ProjectRegistration } from "../src/projects/types.js";
import { ReconciliationController } from "../src/reconciliation/controller.js";
import type { TaskNode } from "../src/tasks/types.js";
import { WorkerProfileRegistry } from "../src/workers/registry.js";
import type { BaseRevisionProvider } from "../src/workspaces/base-revision.js";
import type {
  WorkspaceRepository,
  WorkspaceSynchronization,
} from "../src/workspaces/git-repository.js";
import type { WorkspaceManager } from "../src/workspaces/types.js";

const contract = parseProjectContract(`
version: 1
project: { id: fixture/reconciliation, baseBranch: main }
tasks: { provider: fixture, dependencies: fixture }
workspace: { setup: [] }
verification: { required: [npm test], protectedPaths: [] }
execution: { concurrency: 1, attempts: 2, timeoutMinutes: 10 }
delivery: { provider: fixture, pullRequest: true, merge: never }
`);

const automaticMergeContract = parseProjectContract(`
version: 1
project: { id: fixture/reconciliation, baseBranch: main }
tasks: { provider: fixture, dependencies: fixture }
workspace: { setup: [] }
verification: { required: [npm test], protectedPaths: [] }
execution: { concurrency: 1, attempts: 2, timeoutMinutes: 10 }
delivery: { provider: fixture, pullRequest: true, merge: after-required-checks }
`);

const project: ProjectRegistration = {
  id: "fixture/reconciliation",
  rootPath: "/fixture/repository",
  contractPath: "/controller/reconciliation/project.yml",
  workerProfile: "fixture-worker",
  enabled: true,
  contractVersion: 1,
  registeredAt: 1,
  updatedAt: 1,
};

const task: TaskNode = {
  id: "TASK-01",
  sourceId: "1",
  revision: "revision-1",
  title: "Reconcile the fixture",
  prompt: "Implement the fixture.",
  status: "pending",
  dependencies: [],
};

const inspection: ProjectInspection = {
  projectId: project.id,
  provider: "fixture",
  dependencies: "fixture",
  graph: { ready: [task], waiting: [], blocked: [], completed: [], edgeCount: 0 },
};

test("synchronizes an advanced base, reverifies, updates one draft, and later polls only CI", async () => {
  const context = fixture({ state: "ci", delivery: true });
  const ci = ["pending", "passed"] as const;
  let ciIndex = 0;
  let head = "head-a";
  let synchronizeCalls = 0;
  let verificationCalls = 0;
  let updateCalls = 0;
  let publishCalls = 0;
  let observed = pullRequest("head-a");
  const repository = repositoryFixture({
    snapshot: async () => ({ headSha: head, changedPaths: ["src/result.ts"], dirty: false }),
    synchronize: async () => {
      synchronizeCalls += 1;
      head = "head-b";
      return { outcome: "synchronized", headSha: head };
    },
  });
  const publisher: PullRequestPublisher = {
    name: "fixture",
    publishDraft: async () => {
      publishCalls += 1;
      return observed;
    },
    inspectPullRequest: async () => observed,
    updateDraft: async (request, expected) => {
      updateCalls += 1;
      assert.equal(expected.headSha, "head-a");
      observed = pullRequest(request.headSha);
      return observed;
    },
    checkCi: async () => ({ status: ci[ciIndex++] ?? "passed", evidence: [] }),
  };
  const commands: CommandRunner = {
    run: async ({ command }) => {
      verificationCalls += 1;
      return { command, passed: true, exitCode: 0, stdout: "passed", stderr: "", durationMs: 1 };
    },
  };
  const controller = controllerFixture(context.runs, repository, publisher, commands);

  try {
    const first = await controller.reconcileProject(request("base-b"));
    assert.equal(first[0]?.outcome, "waiting-ci");
    assert.equal(first[0]?.pullRequestState, "open");
    assert.equal(context.runs.get(context.runId)?.baseSha, "base-b");
    assert.equal(context.runs.get(context.runId)?.headSha, "head-b");
    assert.equal(context.runs.get(context.runId)?.requiresReverification, false);
    assert.equal(context.runs.delivery(context.runId)?.headSha, "head-b");
    assert.equal(synchronizeCalls, 1);
    assert.equal(verificationCalls, 1);
    assert.equal(updateCalls, 1);
    assert.equal(publishCalls, 0);

    const second = await controller.reconcileProject(request("base-b"));
    assert.equal(second[0]?.outcome, "completed");
    assert.equal(context.runs.get(context.runId)?.state, "completed");
    assert.equal(synchronizeCalls, 1);
    assert.equal(verificationCalls, 1);
    assert.equal(updateCalls, 1);
    assert.equal(publishCalls, 0);
  } finally {
    context.runs.close();
  }
});

test("does not steal a live worker lease", async () => {
  const context = fixture({ state: "running", leaseExpiresAt: 10_000 });
  const controller = controllerFixture(
    context.runs,
    repositoryFixture(),
    null,
    passingCommands(),
    5_000,
  );
  try {
    const result = await controller.reconcileProject(request("base-a"));
    assert.equal(result[0]?.outcome, "live-lease");
    assert.equal(context.runs.get(context.runId)?.leaseOwner, "original-controller");
    assert.equal(context.runs.get(context.runId)?.attempt, 1);
  } finally {
    context.runs.close();
  }
});

test("fails visibly when a persisted verified workspace is missing", async () => {
  const context = fixture({ state: "verified" });
  const repository = repositoryFixture({
    snapshot: async () => {
      throw new Error("ENOENT");
    },
  });
  const controller = controllerFixture(context.runs, repository, null, passingCommands());
  try {
    const result = await controller.reconcileProject(request("base-a"));
    assert.equal(result[0]?.outcome, "failed");
    assert.equal(result[0]?.workspace, "missing");
    assert.equal(context.runs.get(context.runId)?.failureReason, "missing-verified-workspace");
  } finally {
    context.runs.close();
  }
});

test("records synchronization conflicts without publishing", async () => {
  const context = fixture({ state: "verified" });
  const repository = repositoryFixture({
    synchronize: async () => ({ outcome: "conflict", conflictedPaths: ["src/result.ts"] }),
  });
  const controller = controllerFixture(context.runs, repository, null, passingCommands());
  try {
    const result = await controller.reconcileProject(request("base-b"));
    assert.equal(result[0]?.outcome, "failed");
    assert.equal(context.runs.get(context.runId)?.failureReason, "base-synchronization-conflict");
  } finally {
    context.runs.close();
  }
});

test("closed and merged pull requests fail instead of being recreated", async () => {
  for (const state of ["closed", "merged"] as const) {
    const context = fixture({ state: "ci", delivery: true });
    let publishCalls = 0;
    const publisher: PullRequestPublisher = {
      name: "fixture",
      publishDraft: async () => {
        publishCalls += 1;
        return pullRequest("head-a");
      },
      inspectPullRequest: async () => ({ ...pullRequest("head-a"), state }),
      updateDraft: async () => {
        throw new Error("must not update");
      },
      checkCi: async () => {
        throw new Error("must not poll CI");
      },
    };
    const controller = controllerFixture(
      context.runs,
      repositoryFixture(),
      publisher,
      passingCommands(),
    );
    try {
      const result = await controller.reconcileProject(request("base-a"));
      assert.equal(result[0]?.outcome, "failed");
      assert.equal(result[0]?.pullRequestState, state);
      assert.equal(context.runs.get(context.runId)?.failureReason, `pull-request-${state}`);
      assert.equal(publishCalls, 0);
    } finally {
      context.runs.close();
    }
  }
});

test("recovers an exact auto-merged pull request and completes its source task", async () => {
  const context = fixture({ state: "ci", delivery: true });
  const merged = { ...pullRequest("head-a"), draft: false, state: "merged" as const };
  let completionCalls = 0;
  const publisher: PullRequestPublisher = {
    name: "fixture",
    publishDraft: async () => {
      throw new Error("must not publish");
    },
    inspectPullRequest: async () => merged,
    updateDraft: async () => {
      throw new Error("must not update");
    },
    checkCi: async () => ({ status: "passed", evidence: ["required check passed"] }),
    validateAutomaticMerge: async () => ({
      evidence: ["strict protected branch"],
      requiredChecks: ["node-tests"],
    }),
    mergeVerified: async () => {
      completionCalls += 1;
      return {
        pullRequest: merged,
        taskCompleted: true,
        evidence: ["merged head recovered", "source task completed"],
      };
    },
  };
  const controller = controllerFixture(
    context.runs,
    repositoryFixture(),
    publisher,
    passingCommands(),
  );

  try {
    const result = await controller.reconcileProject(request("base-b", automaticMergeContract));

    assert.equal(result[0]?.outcome, "completed");
    assert.equal(result[0]?.pullRequestState, "merged");
    assert.equal(context.runs.get(context.runId)?.state, "completed");
    assert.equal(context.runs.delivery(context.runId)?.draft, false);
    assert.equal(completionCalls, 1);
  } finally {
    context.runs.close();
  }
});

test("an expired active run cannot exceed its attempt budget", async () => {
  const context = fixture({ state: "running", leaseExpiresAt: 100, maxAttempts: 1 });
  const controller = controllerFixture(context.runs, repositoryFixture(), null, passingCommands());
  try {
    const result = await controller.reconcileProject(request("base-a"));
    assert.equal(result[0]?.outcome, "failed");
    assert.equal(context.runs.get(context.runId)?.failureReason, "attempts-exhausted");
  } finally {
    context.runs.close();
  }
});

function fixture(options: {
  state: "running" | "verified" | "ci";
  delivery?: boolean;
  leaseExpiresAt?: number;
  maxAttempts?: number;
}): { runs: RunStore; runId: string } {
  const runs = new RunStore();
  const claim = runs.claim({
    projectId: project.id,
    taskId: task.id,
    revision: task.revision,
    baseSha: "base-a",
    workerId: "original-controller",
    now: 1,
    leaseDurationMs: options.leaseExpiresAt ?? 100,
    maxAttempts: options.maxAttempts ?? 2,
  });
  let run = runs.transition(claim.run.id, "workspace-ready", 2);
  runs.recordWorkspace(run.id, {
    workspacePath: "/fixture/workspace",
    branchName: "agent-runner/task-01-a1-fixture",
    workerProfile: "fixture-worker",
  }, 3);
  run = runs.transition(run.id, "running", 4);
  if (options.state !== "running") {
    runs.recordWorker(run.id, {
      workerName: "fixture-worker",
      status: "succeeded",
      model: "fixture-model",
      sessionId: "fixture-session",
      summary: "done",
      costUsd: 0,
      durationMs: 1,
    }, 5);
    run = runs.transition(run.id, "verifying", 6, { headSha: "head-a" });
    run = runs.transition(run.id, "verified", 7, { headSha: "head-a" });
  }
  if (options.state === "ci") {
    run = runs.transition(run.id, "pr-open", 8);
    run = runs.transition(run.id, "ci", 9);
  }
  if (options.delivery) {
    runs.recordDelivery(run.id, {
      provider: "fixture",
      externalId: "7",
      url: "https://example.invalid/pull/7",
      branchName: "agent-runner/task-01-a1-fixture",
      baseBranch: "main",
      baseSha: "base-a",
      headSha: "head-a",
      draft: true,
      ciStatus: "pending",
    }, 10);
  }
  return { runs, runId: run.id };
}

function controllerFixture(
  runs: RunStore,
  repository: WorkspaceRepository,
  publisher: PullRequestPublisher | null,
  commands: CommandRunner,
  now = 5_000,
): ReconciliationController {
  const workspaces: WorkspaceManager = {
    create: async () => {
      throw new Error("worker retry was not expected");
    },
  };
  const baseRevisions: BaseRevisionProvider = {
    inspect: async () => "base-b",
    refresh: async () => "base-b",
  };
  return new ReconciliationController(
    runs,
    workspaces,
    repository,
    new WorkerProfileRegistry(),
    commands,
    baseRevisions,
    publisher,
    { now: () => now },
  );
}

function repositoryFixture(overrides: Partial<WorkspaceRepository> = {}): WorkspaceRepository {
  let head = "head-a";
  const synchronize = async (): Promise<WorkspaceSynchronization> => {
    head = "head-b";
    return { outcome: "synchronized", headSha: head };
  };
  return {
    resolveRef: async () => "base-b",
    snapshot: async () => ({ headSha: head, changedPaths: ["src/result.ts"], dirty: false }),
    commit: async () => head,
    synchronize,
    ...overrides,
  };
}

function passingCommands(): CommandRunner {
  return {
    run: async ({ command }) => ({
      command,
      passed: true,
      exitCode: 0,
      stdout: "passed",
      stderr: "",
      durationMs: 1,
    }),
  };
}

function pullRequest(headSha: string): PullRequestSnapshot {
  return {
    externalId: "7",
    url: "https://example.invalid/pull/7",
    branchName: "agent-runner/task-01-a1-fixture",
    baseBranch: "main",
    headSha,
    draft: true,
    state: "open",
  };
}

function request(currentBaseSha: string, selectedContract = contract) {
  return {
    project,
    contract: selectedContract,
    inspection,
    currentBaseSha,
    controllerId: "reconciliation-controller",
    leaseDurationMs: 1_000,
  };
}
