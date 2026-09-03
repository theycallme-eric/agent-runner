import assert from "node:assert/strict";
import test from "node:test";

import { RunStore } from "../src/core/store.js";
import { DeliveryCoordinator } from "../src/delivery/coordinator.js";
import type {
  CiSnapshot,
  DraftPullRequestRequest,
  PullRequestPublisher,
  PullRequestSnapshot,
} from "../src/delivery/types.js";
import { parseProjectContract } from "../src/project-contract.js";
import type { ProjectRegistration } from "../src/projects/types.js";
import type { TaskNode } from "../src/tasks/types.js";
import type { WorkspaceRepository } from "../src/workspaces/git-repository.js";

const contract = parseProjectContract(`
version: 1
project: { id: fixture/delivery, baseBranch: main }
tasks: { provider: fixture, dependencies: embedded-dag }
workspace: { setup: [] }
verification:
  required: [npm test]
  protectedPaths:
    - pattern: .github/workflows/**
      gate: human
execution: { concurrency: 1, attempts: 2, timeoutMinutes: 10 }
delivery: { pullRequest: true, merge: never }
`);

const automaticMergeContract = parseProjectContract(`
version: 1
project: { id: fixture/delivery, baseBranch: main }
tasks: { provider: fixture, dependencies: embedded-dag }
workspace: { setup: [] }
verification:
  required: [npm test]
  protectedPaths:
    - pattern: .github/workflows/**
      gate: human
execution: { concurrency: 1, attempts: 2, timeoutMinutes: 10 }
delivery: { pullRequest: true, merge: after-required-checks }
`);

const project: ProjectRegistration = {
  id: "fixture/delivery",
  rootPath: "/fixture/repository",
  contractPath: "/controller/delivery/project.yml",
  workerProfile: "fixture-worker",
  enabled: true,
  contractVersion: 1,
  registeredAt: 1_000,
  updatedAt: 1_000,
};

const task: TaskNode = {
  id: "TASK-01",
  sourceId: "1",
  revision: "revision-1",
  title: "Publish the fixture",
  prompt: "Implement the fixture delivery task.",
  status: "pending",
  dependencies: [],
};

test("reconciles one draft pull request across pending and passing CI", async () => {
  const context = setup();
  const ci: CiSnapshot[] = [
    { status: "pending", evidence: ["check pending"] },
    { status: "passed", evidence: ["check passed"] },
  ];
  const publisher = fakePublisher(async (request, call) => pullRequest(request, String(77)), async () => {
    const result = ci.shift();
    assert.ok(result);
    return result;
  });
  const coordinator = new DeliveryCoordinator(context.runs, context.repository, publisher, {
    now: tickingClock(),
  });

  try {
    const first = await coordinator.deliver(context.request);
    const second = await coordinator.deliver(context.request);

    assert.equal(first.outcome, "waiting-ci");
    assert.equal(first.run.state, "ci");
    assert.equal(second.outcome, "completed");
    assert.equal(second.run.state, "completed");
    assert.equal(publisher.publishCalls, 1);
    assert.deepEqual([...publisher.externalIds], ["77"]);
    assert.equal(context.runs.delivery(context.runId)?.url, "https://example.invalid/pull/77");
    assert.equal(context.runs.delivery(context.runId)?.ciStatus, "passed");

    const third = await coordinator.deliver(context.request);
    assert.equal(third.outcome, "completed");
    assert.equal(publisher.publishCalls, 1);
  } finally {
    context.runs.close();
  }
});

test("recovers when publication succeeds remotely before local persistence", async () => {
  const context = setup();
  let first = true;
  const publisher = fakePublisher(async (request) => {
    if (first) {
      first = false;
      throw new Error("controller stopped after remote create");
    }
    return pullRequest(request, "88");
  }, async () => ({ status: "passed", evidence: ["passed"] }));
  const coordinator = new DeliveryCoordinator(context.runs, context.repository, publisher, {
    now: tickingClock(),
  });

  try {
    const interrupted = await coordinator.deliver(context.request);
    const recovered = await coordinator.deliver(context.request);

    assert.equal(interrupted.outcome, "retryable-failure");
    assert.equal(interrupted.run.state, "verified");
    assert.equal(context.runs.delivery(context.runId)?.externalId, "88");
    assert.equal(recovered.outcome, "completed");
    assert.equal(publisher.publishCalls, 2);
  } finally {
    context.runs.close();
  }
});

test("failed CI is persisted and cannot complete a run", async () => {
  const context = setup();
  const publisher = fakePublisher(
    async (request) => pullRequest(request, "99"),
    async () => ({ status: "failed", evidence: ["tests failed"] }),
  );
  const coordinator = new DeliveryCoordinator(context.runs, context.repository, publisher, {
    now: tickingClock(),
  });

  try {
    const result = await coordinator.deliver(context.request);

    assert.equal(result.outcome, "failed");
    assert.equal(result.run.state, "failed");
    assert.equal(result.run.failureReason, "ci-failed");
    assert.equal(context.runs.delivery(context.runId)?.ciStatus, "failed");
  } finally {
    context.runs.close();
  }
});

test("automatically merges the exact verified head and completes its source task", async () => {
  const context = setup();
  context.request.contract = automaticMergeContract;
  const publisher = fakePublisher(
    async (request) => pullRequest(request, "104"),
    async () => ({
      status: "passed",
      evidence: ["node-tests: pass"],
      checks: [{ name: "node-tests", bucket: "pass" as const }],
    }),
  );
  let mergeCalls = 0;
  publisher.validateAutomaticMerge = async () => ({
    evidence: ["strict protected branch"],
    requiredChecks: ["node-tests"],
  });
  publisher.mergeVerified = async (_request, pullRequest) => {
    mergeCalls += 1;
    return {
      pullRequest: { ...pullRequest, draft: false, state: "merged" },
      taskCompleted: true,
      evidence: ["exact verified head merged", "source task completed"],
    };
  };
  const coordinator = new DeliveryCoordinator(context.runs, context.repository, publisher, {
    now: tickingClock(),
  });

  try {
    const result = await coordinator.deliver(context.request);

    assert.equal(result.outcome, "completed");
    assert.equal(result.run.state, "completed");
    assert.equal(result.delivery?.draft, false);
    assert.equal(mergeCalls, 1);
    assert.equal(context.runs.delivery(context.runId)?.draft, false);
    assert.equal(context.runs.delivery(context.runId)?.ciStatus, "passed");
  } finally {
    context.runs.close();
  }
});

test("an unreported required context downgrades an apparent pass to waiting", async () => {
  const context = setup();
  context.request.contract = automaticMergeContract;
  const publisher = fakePublisher(
    async (request) => pullRequest(request, "105"),
    async () => ({
      status: "passed",
      evidence: ["verify: pass"],
      checks: [{ name: "verify", bucket: "pass" as const }],
    }),
  );
  let mergeCalls = 0;
  publisher.validateAutomaticMerge = async () => ({
    evidence: ["strict protected branch"],
    requiredChecks: ["node-tests", "verify"],
  });
  publisher.mergeVerified = async () => {
    mergeCalls += 1;
    throw new Error("automatic merge must not be attempted");
  };
  const coordinator = new DeliveryCoordinator(context.runs, context.repository, publisher, {
    now: tickingClock(),
  });

  try {
    const result = await coordinator.deliver(context.request);

    assert.equal(result.outcome, "waiting-ci");
    assert.equal(result.run.state, "ci");
    assert.equal(mergeCalls, 0);
    assert.match(result.message ?? "", /node-tests/);
    assert.equal(context.runs.delivery(context.runId)?.ciStatus, "pending");
    const evidence = context.runs
      .events(context.runId)
      .filter((event) => event.type === "required-checks-incomplete");
    assert.equal(evidence.length, 1);
    assert.match(JSON.stringify(evidence[0]?.detail), /node-tests/);
  } finally {
    context.runs.close();
  }
});

test("an apparent pass without check rows refuses to merge under the automatic policy", async () => {
  const context = setup();
  context.request.contract = automaticMergeContract;
  const publisher = fakePublisher(
    async (request) => pullRequest(request, "106"),
    async () => ({ status: "passed", evidence: ["required check passed"] }),
  );
  let mergeCalls = 0;
  publisher.validateAutomaticMerge = async () => ({
    evidence: ["strict protected branch"],
    requiredChecks: ["node-tests"],
  });
  publisher.mergeVerified = async () => {
    mergeCalls += 1;
    throw new Error("automatic merge must not be attempted");
  };
  const coordinator = new DeliveryCoordinator(context.runs, context.repository, publisher, {
    now: tickingClock(),
  });

  try {
    const result = await coordinator.deliver(context.request);

    assert.equal(result.outcome, "failed");
    assert.equal(result.run.failureReason, "required-checks-unreported");
    assert.equal(mergeCalls, 0);
  } finally {
    context.runs.close();
  }
});

test("a bounded CI wait expires without failing or transitioning the run", async () => {
  const context = setup();
  context.request.contract = automaticMergeContract;
  context.request.maxCiWaitMinutes = 5;
  const checks: CiSnapshot[] = [
    { status: "pending", evidence: ["node-tests: pending"], checks: [{ name: "node-tests", bucket: "pending" }] },
    { status: "pending", evidence: ["node-tests: pending"], checks: [{ name: "node-tests", bucket: "pending" }] },
    { status: "passed", evidence: ["node-tests: pass"], checks: [{ name: "node-tests", bucket: "pass" }] },
  ];
  const publisher = fakePublisher(async (request) => pullRequest(request, "107"), async () => {
    const next = checks.shift();
    assert.ok(next);
    return next;
  });
  publisher.validateAutomaticMerge = async () => ({
    evidence: ["strict protected branch"],
    requiredChecks: ["node-tests"],
  });
  publisher.mergeVerified = async (_request, observed) => ({
    pullRequest: { ...observed, draft: false, state: "merged" as const },
    taskCompleted: true,
    evidence: ["exact verified head merged"],
  });
  let now = 10_000_000;
  const coordinator = new DeliveryCoordinator(context.runs, context.repository, publisher, {
    now: () => now,
  });

  try {
    const first = await coordinator.deliver(context.request);
    const startedAt = context.runs.ciWait(context.runId)?.firstPendingAt;
    now += 6 * 60_000;
    const expired = await coordinator.deliver(context.request);
    const stillStartedAt = context.runs.ciWait(context.runId)?.firstPendingAt;
    now += 60_000;
    const completed = await coordinator.deliver(context.request);

    assert.equal(first.outcome, "waiting-ci");
    assert.equal(first.ciWaitExpired, false);
    assert.ok(startedAt);
    assert.equal(expired.outcome, "waiting-ci");
    assert.equal(expired.ciWaitExpired, true);
    assert.equal(expired.run.state, "ci");
    assert.equal(expired.run.failureReason, null);
    assert.equal(stillStartedAt, startedAt);
    assert.equal(completed.outcome, "completed");
    assert.equal(completed.ciWaitExpired, false);
    assert.equal(context.runs.ciWait(context.runId), null);
  } finally {
    context.runs.close();
  }
});

test("protected paths cannot reach the publisher", async () => {
  const context = setup([".github/workflows/ci.yml"]);
  const publisher = fakePublisher(
    async (request) => pullRequest(request, "100"),
    async () => ({ status: "passed", evidence: [] }),
  );
  const coordinator = new DeliveryCoordinator(context.runs, context.repository, publisher, {
    now: tickingClock(),
  });

  try {
    const result = await coordinator.deliver(context.request);

    assert.equal(result.outcome, "waiting-human");
    assert.equal(result.run.state, "waiting-human");
    assert.equal(publisher.publishCalls, 0);
    assert.equal(context.runs.delivery(context.runId), null);
  } finally {
    context.runs.close();
  }
});

test("a publisher cannot silently create a non-draft pull request", async () => {
  const context = setup();
  const publisher = fakePublisher(
    async (request) => ({ ...pullRequest(request, "101"), draft: false }),
    async () => ({ status: "passed", evidence: [] }),
  );
  const coordinator = new DeliveryCoordinator(context.runs, context.repository, publisher, {
    now: tickingClock(),
  });

  try {
    const result = await coordinator.deliver(context.request);

    assert.equal(result.outcome, "failed");
    assert.equal(result.run.failureReason, "invalid-draft-pull-request");
    assert.equal(context.runs.delivery(context.runId), null);
  } finally {
    context.runs.close();
  }
});

test("a retry cannot replace the persisted pull request identity", async () => {
  const context = setup();
  const publisher = fakePublisher(
    async (request, call) => pullRequest(request, call === 1 ? "102" : "103"),
    async () => ({ status: "pending", evidence: ["pending"] }),
  );
  const coordinator = new DeliveryCoordinator(context.runs, context.repository, publisher, {
    now: tickingClock(),
  });

  try {
    assert.equal((await coordinator.deliver(context.request)).outcome, "waiting-ci");
    publisher.driftExternalId("103");
    const drifted = await coordinator.deliver(context.request);

    assert.equal(drifted.outcome, "failed");
    assert.equal(drifted.run.failureReason, "delivery-identity-drift");
    assert.equal(context.runs.delivery(context.runId)?.externalId, "102");
  } finally {
    context.runs.close();
  }
});

function setup(changedPaths = ["src/app.ts"]): {
  runs: RunStore;
  runId: string;
  repository: WorkspaceRepository;
  request: {
    runId: string;
    task: TaskNode;
    project: ProjectRegistration;
    contract: typeof contract;
    maxCiWaitMinutes?: number;
  };
} {
  const runs = new RunStore();
  const claim = runs.claim({
    projectId: project.id,
    taskId: task.id,
    revision: task.revision,
    baseSha: "base-a",
    workerId: "controller-1",
    now: 1_000,
    leaseDurationMs: 10_000,
    maxAttempts: 2,
  });
  let run = runs.transition(claim.run.id, "workspace-ready", 1_001);
  run = runs.transition(run.id, "running", 1_002);
  run = runs.transition(run.id, "verifying", 1_003, { headSha: "head-a" });
  run = runs.transition(run.id, "verified", 1_004, { headSha: "head-a" });
  runs.recordWorkspace(run.id, {
    workspacePath: "/fixture/workspace",
    branchName: "agent-runner/task-01-a1-run",
    workerProfile: "fixture-worker",
  }, 1_005);
  const repository: WorkspaceRepository = {
    resolveRef: async () => "base-a",
    snapshot: async () => ({ headSha: "head-a", changedPaths, dirty: false }),
    commit: async () => {
      throw new Error("Delivery must not commit");
    },
    synchronize: async () => {
      throw new Error("Delivery must not synchronize");
    },
  };
  return {
    runs,
    runId: run.id,
    repository,
    request: { runId: run.id, task, project, contract },
  };
}

interface FakePublisher extends PullRequestPublisher {
  publishCalls: number;
  externalIds: Set<string>;
  driftExternalId(externalId: string): void;
}

function fakePublisher(
  publish: (request: DraftPullRequestRequest, call: number) => Promise<PullRequestSnapshot>,
  checkCi: (
    request: DraftPullRequestRequest,
    pullRequest: PullRequestSnapshot,
  ) => Promise<CiSnapshot>,
): FakePublisher {
  let observed: PullRequestSnapshot | null = null;
  return {
    name: "fixture-forge",
    publishCalls: 0,
    externalIds: new Set<string>(),
    async publishDraft(request) {
      this.publishCalls += 1;
      const result = await publish(request, this.publishCalls);
      this.externalIds.add(result.externalId);
      observed = result;
      return result;
    },
    async inspectPullRequest() {
      return observed;
    },
    async updateDraft(request, expected) {
      const result = pullRequest(request, expected.externalId);
      observed = result;
      return result;
    },
    driftExternalId(externalId) {
      if (!observed) {
        throw new Error("No pull request exists to drift");
      }
      observed = {
        ...observed,
        externalId,
        url: `https://example.invalid/pull/${externalId}`,
      };
    },
    checkCi,
  };
}

function pullRequest(request: DraftPullRequestRequest, externalId: string): PullRequestSnapshot {
  return {
    externalId,
    url: `https://example.invalid/pull/${externalId}`,
    branchName: request.branchName,
    baseBranch: request.baseBranch,
    headSha: request.headSha,
    draft: true,
    state: "open",
  };
}

function tickingClock(): () => number {
  let now = 2_000;
  return () => ++now;
}
