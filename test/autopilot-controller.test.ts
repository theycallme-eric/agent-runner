import assert from "node:assert/strict";
import test from "node:test";

import { AutopilotController } from "../src/autopilot/controller.js";
import { RunStore } from "../src/core/store.js";
import { ProjectRegistryStore } from "../src/projects/registry.js";
import type { RunOnceRequest, RunOnceResult } from "../src/runtime/run-once.js";

test("runs two projects and worker profiles sequentially, then stops after bounded no progress", async () => {
  const projects = projectsFixture();
  const runs = new RunStore();
  seedMorningReport(runs);
  const seen = new Set<string>();
  const calls: RunOnceRequest[] = [];
  let now = 1_000;
  const runner = {
    async run(request: RunOnceRequest): Promise<RunOnceResult> {
      calls.push(request);
      const first = !seen.has(request.projectId);
      seen.add(request.projectId);
      return resultFixture(
        request.projectId,
        request.projectId.endsWith("one") ? "worker-a" : "worker-b",
        first,
      );
    },
  };
  const controller = new AutopilotController(projects, runs, runner, {
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  });
  try {
    const result = await controller.run({
      enabled: true,
      controllerId: "overnight",
      leaseDurationMs: 1_000,
      deadlineAt: 20_000,
      maxNewClaims: 10,
      maxNoProgressPasses: 2,
      pollIntervalMs: 100,
      globalConcurrency: 1,
    });

    assert.equal(result.stopReason, "no-progress");
    assert.equal(result.totalNewClaims, 2);
    assert.equal(result.passes.length, 3);
    assert.deepEqual(calls.map((call) => call.projectId), [
      "fixture/one",
      "fixture/two",
      "fixture/one",
      "fixture/two",
      "fixture/one",
      "fixture/two",
    ]);
    assert.ok(calls.every((call) => call.maxClaims === 1 && call.targetTaskId === null));
    assert.ok(calls.every((call) => call.controllerId === "overnight"));
    assert.deepEqual(
      result.passes[0]?.projects.map((entry) => entry.workerProfile),
      ["worker-a", "worker-b"],
    );
    assert.equal(result.report.totals.runs, 2);
    assert.equal(result.report.totals.failed, 1);
    assert.equal(result.report.totals.estimatedCostUsd, 0.25);
    assert.equal(result.report.runs[0]?.pullRequestUrl, "https://example.invalid/pull/1");
  } finally {
    runs.close();
    projects.close();
  }
});

test("requires explicit enablement and bounded positive global concurrency", async () => {
  const projects = projectsFixture();
  const runs = new RunStore();
  const controller = new AutopilotController(projects, runs, {
    run: async () => resultFixture("fixture/one", "worker-a", false),
  });
  const base = {
    enabled: false,
    controllerId: "overnight",
    leaseDurationMs: 1_000,
    deadlineAt: Date.now() + 1_000,
    maxNewClaims: 1,
    maxNoProgressPasses: 1,
    pollIntervalMs: 1,
    globalConcurrency: 1,
  };
  try {
    await assert.rejects(controller.run(base), /explicit enable flag/);
    await assert.rejects(
      controller.run({ ...base, enabled: true, globalConcurrency: 17 }),
      /integer from 1 to 16/,
    );
  } finally {
    runs.close();
    projects.close();
  }
});

test("reports a fully drained DAG as completed", async () => {
  const projects = projectsFixture();
  const runs = new RunStore();
  let calls = 0;
  const controller = new AutopilotController(projects, runs, {
    run: async (request) => {
      calls += 1;
      const result = resultFixture(request.projectId, "worker-a", false);
      result.ready = [];
      result.completed = ["TASK-DONE"];
      result.duplicateTaskIds = [];
      return result;
    },
  });

  try {
    const result = await controller.run({
      enabled: true,
      controllerId: "completed",
      leaseDurationMs: 1_000,
      deadlineAt: Date.now() + 10_000,
      maxNewClaims: 5,
      maxNoProgressPasses: 3,
      pollIntervalMs: 1,
      globalConcurrency: 1,
    });

    assert.equal(result.stopReason, "completed");
    assert.equal(result.passes.length, 1);
    assert.equal(calls, 2);
  } finally {
    runs.close();
    projects.close();
  }
});

test("quarantines a human-gated branch and continues until the bounded no-progress stop", async () => {
  const projects = projectsFixture();
  const runs = new RunStore();
  let calls = 0;
  let first = true;
  const controller = new AutopilotController(projects, runs, {
    run: async (request) => {
      calls += 1;
      const result = resultFixture(request.projectId, "worker-a", false);
      if (first) result.reconciliation.push({
        runId: "run-gate",
        taskId: "task-gate",
        initialState: "verifying",
        state: "waiting-human",
        execution: "not-run",
        lease: "acquired",
        outcome: "waiting-human",
        base: "current",
        workspace: "present",
        workerStatus: "succeeded",
        workerSessionId: "session",
        branchName: "agent/task",
        pullRequestUrl: null,
        pullRequestState: "none",
        ciStatus: null,
        ciWaitExpired: false,
        ciWaitDetail: null,
        failureReason: null,
      });
      first = false;
      return result;
    },
  }, { sleep: async () => undefined });
  try {
    const result = await controller.run({
      enabled: true,
      controllerId: "overnight",
      leaseDurationMs: 1_000,
      deadlineAt: Date.now() + 10_000,
      maxNewClaims: 5,
      maxNoProgressPasses: 3,
      pollIntervalMs: 1,
      globalConcurrency: 1,
    });
    assert.equal(result.stopReason, "no-progress");
    assert.ok(calls > 1, "unrelated projects should continue after one human gate");
  } finally {
    runs.close();
    projects.close();
  }
});

test("honors both the deadline and maximum-new-claim ceiling", async () => {
  const projects = projectsFixture();
  const runs = new RunStore();
  let calls = 0;
  let now = 100;
  const controller = new AutopilotController(projects, runs, {
    run: async (request) => {
      calls += 1;
      return resultFixture(request.projectId, "worker-a", request.maxClaims > 0);
    },
  }, { now: () => now, sleep: async () => undefined });
  const base = {
    enabled: true,
    controllerId: "overnight",
    leaseDurationMs: 1_000,
    maxNewClaims: 1,
    maxNoProgressPasses: 2,
    pollIntervalMs: 1,
    globalConcurrency: 1,
  };
  try {
    const deadline = await controller.run({ ...base, deadlineAt: 100 });
    assert.equal(deadline.stopReason, "deadline");
    assert.equal(calls, 0);

    now = 101;
    const bounded = await controller.run({ ...base, deadlineAt: 1_000 });
    assert.equal(bounded.stopReason, "max-new-claims");
    assert.equal(bounded.totalNewClaims, 1);
    assert.equal(calls, 2);
  } finally {
    runs.close();
    projects.close();
  }
});

test("stops new claims at the ceiling but drains already claimed work", async () => {
  const projects = projectsFixture();
  const runs = new RunStore();
  const requests: RunOnceRequest[] = [];
  const claimed = runs.claim({
    projectId: "fixture/one",
    taskId: "TASK-IN-FLIGHT",
    revision: "one",
    baseSha: "base-a",
    workerId: "overnight",
    now: 1,
    leaseDurationMs: 10_000,
    maxAttempts: 2,
  });
  let active = runs.transition(claimed.run.id, "workspace-ready", 2);
  active = runs.transition(active.id, "running", 3);
  active = runs.transition(active.id, "verifying", 4, { headSha: "head-a" });
  active = runs.transition(active.id, "verified", 5, { headSha: "head-a" });
  active = runs.transition(active.id, "pr-open", 6);
  active = runs.transition(active.id, "ci", 7);

  const controller = new AutopilotController(projects, runs, {
    run: async (request) => {
      requests.push(request);
      const result = resultFixture(request.projectId, "worker-a", requests.length === 1);
      if (requests.length === 3) {
        runs.transition(active.id, "completed", 8);
        result.reconciliation.push({
          runId: active.id,
          taskId: "TASK-IN-FLIGHT",
          initialState: "ci",
          state: "completed",
          execution: "not-run",
          lease: "acquired",
          outcome: "completed",
          base: "current",
          workspace: "present",
          workerStatus: "succeeded",
          workerSessionId: "session",
          branchName: "agent/task-in-flight",
          pullRequestUrl: "https://example.invalid/pull/in-flight",
          pullRequestState: "merged",
          ciStatus: "passed",
          ciWaitExpired: false,
          ciWaitDetail: null,
          failureReason: null,
        });
      }
      return result;
    },
  }, { sleep: async () => undefined });

  try {
    const result = await controller.run({
      enabled: true,
      controllerId: "overnight",
      leaseDurationMs: 1_000,
      deadlineAt: Date.now() + 10_000,
      maxNewClaims: 1,
      maxNoProgressPasses: 3,
      pollIntervalMs: 1,
      globalConcurrency: 1,
    });

    assert.equal(result.stopReason, "max-new-claims");
    assert.equal(result.passes.length, 2);
    assert.deepEqual(requests.map((request) => request.maxClaims), [1, 0, 0, 0]);
    assert.equal(runs.get(active.id)?.state, "completed");
  } finally {
    runs.close();
    projects.close();
  }
});

test("passes an explicit parallel ceiling to the bounded run-once controller", async () => {
  const projects = projectsFixture();
  const runs = new RunStore();
  const requests: RunOnceRequest[] = [];
  let first = true;
  const controller = new AutopilotController(projects, runs, {
    run: async (request) => {
      requests.push(request);
      const result = resultFixture(request.projectId, "worker-a", false);
      if (first) result.reconciliation.push({
        runId: "stop-after-capacity-check",
        taskId: "TASK-GATE",
        initialState: "verified",
        state: "waiting-human",
        execution: "not-run",
        lease: "acquired",
        outcome: "waiting-human",
        base: "current",
        workspace: "present",
        workerStatus: "succeeded",
        workerSessionId: "session",
        branchName: "agent/task",
        pullRequestUrl: null,
        pullRequestState: "none",
        ciStatus: null,
        ciWaitExpired: false,
        ciWaitDetail: null,
        failureReason: null,
      });
      first = false;
      return result;
    },
  }, { sleep: async () => undefined });
  try {
    const result = await controller.run({
      enabled: true,
      controllerId: "parallel",
      leaseDurationMs: 1_000,
      deadlineAt: Date.now() + 10_000,
      maxNewClaims: 5,
      maxNoProgressPasses: 2,
      pollIntervalMs: 1,
      globalConcurrency: 3,
    });

    assert.equal(result.stopReason, "no-progress");
    assert.ok(requests.length > 1);
    assert.equal(requests[0]?.maxClaims, 3);
  } finally {
    runs.close();
    projects.close();
  }
});

test("retries transient delivery failures until the bounded no-progress stop", async () => {
  const projects = projectsFixture();
  const runs = new RunStore();
  let calls = 0;
  const controller = new AutopilotController(projects, runs, {
    run: async (request) => {
      calls += 1;
      const result = resultFixture(request.projectId, "worker-a", false);
      result.ok = false;
      result.reconciled.push({
        taskId: "TASK-RETRY",
        runId: "run-retry",
        state: "ci",
        execution: "not-run",
        worker: null,
        workspacePath: "/workspaces/retry",
        delivery: "retryable-failure",
        pullRequestUrl: "https://example.invalid/pull/retry",
        ciStatus: "passed",
        ciWaitExpired: false,
        ciWaitDetail: null,
        failureReason: null,
      });
      result.reconciliation.push({
        runId: "run-retry",
        taskId: "TASK-RETRY",
        initialState: "ci",
        state: "ci",
        execution: "not-run",
        lease: "acquired",
        outcome: "retryable-failure",
        base: "current",
        workspace: "present",
        workerStatus: "succeeded",
        workerSessionId: "session",
        branchName: "agent/task-retry",
        pullRequestUrl: "https://example.invalid/pull/retry",
        pullRequestState: "open",
        ciStatus: "passed",
        ciWaitExpired: false,
        ciWaitDetail: null,
        failureReason: null,
      });
      return result;
    },
  }, { sleep: async () => undefined });

  try {
    const result = await controller.run({
      enabled: true,
      controllerId: "retry",
      leaseDurationMs: 1_000,
      deadlineAt: Date.now() + 10_000,
      maxNewClaims: 5,
      maxNoProgressPasses: 2,
      pollIntervalMs: 1,
      globalConcurrency: 1,
    });

    assert.equal(result.stopReason, "no-progress");
    assert.equal(calls, 4);
  } finally {
    runs.close();
    projects.close();
  }
});

test("one terminal task failure is quarantined while unrelated work continues", async () => {
  const projects = projectsFixture();
  const runs = new RunStore();
  let calls = 0;
  const terminalRunId = seedFailedRun(
    runs,
    "fixture/one",
    "TASK-TERMINAL",
    "terminal-revision",
    "verified-workspace-drifted",
  );
  const controller = new AutopilotController(projects, runs, {
    run: async (request) => {
      calls += 1;
      const result = resultFixture(request.projectId, "worker-a", false);
      result.ok = false;
      result.reconciled.push({
        taskId: "TASK-TERMINAL",
        runId: terminalRunId,
        state: "failed",
        execution: "not-run",
        worker: null,
        workspacePath: "/workspaces/terminal",
        delivery: "failed",
        pullRequestUrl: null,
        ciStatus: null,
        ciWaitExpired: false,
        ciWaitDetail: null,
        failureReason: "verified-workspace-drifted",
      });
      result.reconciled.push({
        taskId: "TASK-RETRY",
        runId: "run-retry",
        state: "ci",
        execution: "not-run",
        worker: null,
        workspacePath: "/workspaces/retry",
        delivery: "retryable-failure",
        pullRequestUrl: "https://example.invalid/pull/retry",
        ciStatus: "passed",
        ciWaitExpired: false,
        ciWaitDetail: null,
        failureReason: null,
      });
      return result;
    },
  }, { sleep: async () => undefined });

  try {
    const result = await controller.run({
      enabled: true,
      controllerId: "terminal",
      leaseDurationMs: 1_000,
      deadlineAt: Date.now() + 10_000,
      maxNewClaims: 5,
      maxNoProgressPasses: 3,
      pollIntervalMs: 1,
      globalConcurrency: 1,
    });

    assert.equal(result.stopReason, "no-progress");
    assert.ok(calls > 1);
    assert.deepEqual(result.report.quarantined.map((entry) => entry.taskId), ["TASK-TERMINAL"]);
  } finally {
    runs.close();
    projects.close();
  }
});

test("pending required CI is progress until its bounded wait expires", async () => {
  const projects = projectsFixture();
  const runs = new RunStore();
  let now = 0;
  let calls = 0;
  const waiting = (expired: boolean) => ({
    runId: "run-waiting",
    taskId: "TASK-WAITING",
    initialState: "ci" as const,
    state: "ci" as const,
    execution: "not-run" as const,
    lease: "acquired" as const,
    outcome: "waiting-ci" as const,
    base: "current" as const,
    workspace: "present" as const,
    workerStatus: "succeeded",
    workerSessionId: "session",
    branchName: "agent/task-waiting",
    pullRequestUrl: "https://example.invalid/pull/waiting",
    pullRequestState: "open" as const,
    ciStatus: "pending",
    ciWaitExpired: expired,
    ciWaitDetail: expired ? "Required checks are not complete: node-tests (pending)" : null,
    failureReason: null,
  });
  const runner = (expired: boolean) => ({
    run: async (request: RunOnceRequest): Promise<RunOnceResult> => {
      calls += 1;
      const result = resultFixture(request.projectId, "worker-a", false);
      result.reconciliation.push(waiting(expired));
      result.reconciled.push({
        taskId: "TASK-WAITING",
        runId: "run-waiting",
        state: "ci",
        execution: "not-run",
        worker: null,
        workspacePath: "/workspaces/waiting",
        delivery: "waiting-ci",
        pullRequestUrl: "https://example.invalid/pull/waiting",
        ciStatus: "pending",
        ciWaitExpired: expired,
        ciWaitDetail: expired ? "Required checks are not complete: node-tests (pending)" : null,
        failureReason: null,
      });
      return result;
    },
  });

  try {
    const pending = await new AutopilotController(projects, runs, runner(false), {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    }).run({
      enabled: true,
      controllerId: "waiting",
      leaseDurationMs: 1_000,
      deadlineAt: 1_000,
      maxNewClaims: 5,
      maxNoProgressPasses: 2,
      pollIntervalMs: 100,
      globalConcurrency: 1,
    });

    assert.equal(pending.stopReason, "deadline");
    assert.ok(pending.passes.length > 2, "an unexpired CI wait must outlive the no-progress limit");
    assert.equal(pending.noProgressPasses, 0);

    calls = 0;
    const expired = await new AutopilotController(projects, runs, runner(true), {
      sleep: async () => undefined,
    }).run({
      enabled: true,
      controllerId: "waiting",
      leaseDurationMs: 1_000,
      deadlineAt: Date.now() + 10_000,
      maxNewClaims: 5,
      maxNoProgressPasses: 3,
      pollIntervalMs: 1,
      globalConcurrency: 1,
    });

    assert.equal(expired.stopReason, "no-progress");
    assert.ok(calls > 1);
    assert.deepEqual(expired.report.ciWaitTimeouts, [{
      projectId: "fixture/one",
      taskId: "TASK-WAITING",
      runId: "run-waiting",
      pullRequestUrl: "https://example.invalid/pull/waiting",
      detail: "Required checks are not complete: node-tests (pending)",
    }]);
  } finally {
    runs.close();
    projects.close();
  }
});

test("stops only after three distinct task revisions are quarantined", async () => {
  const projects = projectsFixture();
  const runs = new RunStore();
  const failures = ["TASK-A", "TASK-B", "TASK-C"].map((taskId, index) => ({
    taskId,
    runId: seedFailedRun(runs, "fixture/one", taskId, `revision-${index}`, "ci-failed"),
  }));
  let calls = 0;
  const controller = new AutopilotController(projects, runs, {
    run: async (request) => {
      calls += 1;
      const result = resultFixture(request.projectId, "worker-a", false);
      result.ok = false;
      if (request.projectId === "fixture/one") {
        result.reconciled.push(...failures.map((failure) => ({
          taskId: failure.taskId,
          runId: failure.runId,
          state: "failed",
          execution: "not-run" as const,
          worker: null,
          workspacePath: null,
          delivery: "failed" as const,
          pullRequestUrl: null,
          ciStatus: "failed",
          ciWaitExpired: false,
          ciWaitDetail: null,
          failureReason: "ci-failed",
        })));
      }
      return result;
    },
  }, { sleep: async () => undefined });

  try {
    const result = await controller.run({
      enabled: true,
      controllerId: "failure-budget",
      leaseDurationMs: 1_000,
      deadlineAt: Date.now() + 10_000,
      maxNewClaims: 5,
      maxNoProgressPasses: 3,
      pollIntervalMs: 1,
      globalConcurrency: 1,
      maxTaskFailures: 3,
    });

    assert.equal(result.stopReason, "failure-budget");
    assert.equal(calls, 1);
    assert.deepEqual(result.report.quarantined.map((entry) => entry.taskId), [
      "TASK-A",
      "TASK-B",
      "TASK-C",
    ]);
  } finally {
    runs.close();
    projects.close();
  }
});

test("a crash-resumed execution enforces its existing failure budget before another project pass", async () => {
  const projects = projectsFixture();
  const runs = new RunStore();
  const execution = runs.startOrResumeAutopilot(100).execution;
  for (const [index, taskId] of ["TASK-A", "TASK-B", "TASK-C"].entries()) {
    const runId = seedFailedRun(runs, "fixture/one", taskId, `revision-${index}`, "ci-failed");
    runs.recordAutopilotQuarantine(execution.id, runId, "ci-failed", 110 + index);
  }
  let calls = 0;
  const controller = new AutopilotController(projects, runs, {
    run: async (request) => {
      calls += 1;
      return resultFixture(request.projectId, "worker-a", false);
    },
  }, { now: () => 200 });

  try {
    const result = await controller.run({
      enabled: true,
      controllerId: "resumed-failure-budget",
      leaseDurationMs: 1_000,
      deadlineAt: 10_000,
      maxNewClaims: 5,
      maxNoProgressPasses: 3,
      pollIntervalMs: 1,
      globalConcurrency: 1,
      maxTaskFailures: 3,
    });
    assert.equal(result.stopReason, "failure-budget");
    assert.equal(result.resumedAfterInterruption, true);
    assert.equal(result.startedAt, 100);
    assert.equal(calls, 0);
    assert.equal(result.report.quarantined.length, 3);
  } finally {
    runs.close();
    projects.close();
  }
});

test("a merge-policy preflight error remains a global stop before any task quarantine", async () => {
  const projects = projectsFixture();
  const runs = new RunStore();
  const controller = new AutopilotController(projects, runs, {
    run: async () => {
      throw new Error("Automatic merge cannot prove a single safe GitHub Actions producer");
    },
  });
  try {
    const result = await controller.run({
      enabled: true,
      controllerId: "preflight",
      leaseDurationMs: 1_000,
      deadlineAt: Date.now() + 10_000,
      maxNewClaims: 5,
      maxNoProgressPasses: 3,
      pollIntervalMs: 1,
      globalConcurrency: 1,
    });
    assert.equal(result.stopReason, "run-failure");
    assert.deepEqual(result.report.quarantined, []);
  } finally {
    runs.close();
    projects.close();
  }
});

function projectsFixture(): ProjectRegistryStore {
  const projects = new ProjectRegistryStore();
  projects.register({
    id: "fixture/one",
    rootPath: "/fixture/one",
    contractPath: "/controller/one/project.yml",
    workerProfile: "worker-a",
    contractVersion: 1,
    now: 1,
  });
  projects.register({
    id: "fixture/two",
    rootPath: "/fixture/two",
    contractPath: "/controller/two/project.yml",
    workerProfile: "worker-b",
    contractVersion: 1,
    now: 1,
  });
  return projects;
}

function resultFixture(
  project: string,
  workerProfile: string,
  claimed: boolean,
): RunOnceResult {
  const task = {
    taskId: `${project}-task`,
    runId: `${project}-run`,
    state: "ci",
    execution: "verified" as const,
    worker: { name: "fixture", model: workerProfile, status: "succeeded" },
    workspacePath: `/workspaces/${project}`,
    delivery: "waiting-ci" as const,
    pullRequestUrl: `https://example.invalid/${project}`,
    ciStatus: "pending",
    ciWaitExpired: false,
    ciWaitDetail: null,
    failureReason: null,
  };
  return {
    ok: true,
    dryRun: false,
    targetTaskId: null,
    project,
    baseSha: "base-a",
    workerProfile,
    provider: "fixture",
    dependencies: "fixture",
    deliveryProvider: "fixture",
    ready: [{ id: task.taskId, title: "Fixture" }],
    waiting: [],
    blocked: [],
    completed: [],
    claimed: claimed ? [task] : [],
    reconciled: [],
    reconciliation: [],
    duplicateTaskIds: claimed ? [] : [task.taskId],
    capacityReached: false,
    limitReached: false,
    prerequisiteBlocks: [],
  };
}

function seedMorningReport(runs: RunStore): void {
  const first = runs.claim({
    projectId: "fixture/one",
    taskId: "TASK-01",
    revision: "one",
    baseSha: "base-a",
    workerId: "controller",
    now: 1,
    leaseDurationMs: 10,
    maxAttempts: 2,
  });
  let run = runs.transition(first.run.id, "workspace-ready", 2);
  run = runs.transition(run.id, "running", 3);
  run = runs.transition(run.id, "verifying", 4, { headSha: "head-a" });
  run = runs.transition(run.id, "verified", 5, { headSha: "head-a" });
  run = runs.transition(run.id, "pr-open", 6);
  runs.transition(run.id, "ci", 7);
  runs.recordWorker(run.id, {
    workerName: "fixture-agent",
    status: "succeeded",
    model: "model-a",
    sessionId: "session-a",
    summary: "done",
    costUsd: 0.25,
    durationMs: 10,
  }, 8);
  runs.recordDelivery(run.id, {
    provider: "fixture",
    externalId: "1",
    url: "https://example.invalid/pull/1",
    branchName: "agent/task-01",
    baseBranch: "main",
    baseSha: "base-a",
    headSha: "head-a",
    draft: true,
    ciStatus: "pending",
  }, 9);

  const second = runs.claim({
    projectId: "fixture/two",
    taskId: "TASK-02",
    revision: "two",
    baseSha: "base-a",
    workerId: "controller",
    now: 1,
    leaseDurationMs: 1,
    maxAttempts: 1,
  });
  runs.reclaimExpired(second.run.id, "restarted", 3, 1);
}

function seedFailedRun(
  runs: RunStore,
  projectId: string,
  taskId: string,
  revision: string,
  failureReason: string,
): string {
  const claimed = runs.claim({
    projectId,
    taskId,
    revision,
    baseSha: "base-a",
    workerId: "overnight",
    now: 1,
    leaseDurationMs: 100,
    maxAttempts: 1,
  });
  runs.transition(claimed.run.id, "failed", 2, { failureReason });
  return claimed.run.id;
}
