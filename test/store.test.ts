import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RunStore } from "../src/core/store.js";
import type { ClaimRequest } from "../src/core/types.js";

function request(overrides: Partial<ClaimRequest> = {}): ClaimRequest {
  return {
    projectId: "fixture/example",
    taskId: "ENV-01",
    revision: "revision-1",
    baseSha: "base-a",
    workerId: "worker-a",
    now: 1_000,
    leaseDurationMs: 100,
    maxAttempts: 2,
    ...overrides,
  };
}

test("a task revision can be claimed only once", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-claims-"));
  const databasePath = join(directory, "runs.sqlite");
  const firstController = new RunStore(databasePath);
  const secondController = new RunStore(databasePath);
  try {
    const first = firstController.claim(request());
    const duplicate = secondController.claim(request({ workerId: "worker-b" }));

    assert.equal(first.claimed, true);
    assert.equal(duplicate.claimed, false);
    assert.equal(duplicate.run.id, first.run.id);
    assert.equal(duplicate.run.leaseOwner, "worker-a");
    assert.equal(
      secondController.events(first.run.id).filter((event) => event.type === "claimed").length,
      1,
    );
  } finally {
    firstController.close();
    secondController.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a retryable task failure reclaims the same run only within its attempt budget", () => {
  const store = new RunStore();
  try {
    const first = store.claimWithinCapacity(request(), 1);
    assert.equal(first.outcome, "claimed");
    store.transition(first.run.id, "failed", 1_010, { failureReason: "verification-failed" });

    const second = store.claimWithinCapacity(request({
      workerId: "worker-b",
      now: 1_020,
      baseSha: "base-b",
    }), 1);
    assert.equal(second.outcome, "claimed");
    assert.equal(second.run.id, first.run.id);
    assert.equal(second.run.attempt, 2);
    assert.equal(second.run.baseSha, "base-b");
    assert.equal(second.run.failureReason, null);
    assert.equal(
      store.events(first.run.id).filter((event) => event.type === "task-retried").length,
      1,
    );

    store.transition(second.run.id, "failed", 1_030, { failureReason: "verification-failed" });
    const exhausted = store.claimWithinCapacity(request({ workerId: "worker-c", now: 1_040 }), 1);
    assert.equal(exhausted.outcome, "duplicate");
    assert.equal(exhausted.run.attempt, 2);
    assert.equal(exhausted.run.failureReason, "verification-failed");
  } finally {
    store.close();
  }
});

test("worker usage preserves totals across retry display-state replacement", () => {
  const store = new RunStore();
  try {
    const first = store.claim(request());
    store.recordWorker(first.run.id, {
      workerName: "fixture-worker",
      status: "failed",
      model: "fixture-model",
      sessionId: "session-one",
      summary: "first attempt",
      costUsd: 1.25,
      durationMs: 10,
    }, 1_005);
    store.transition(first.run.id, "failed", 1_010, { failureReason: "worker-failed" });

    const second = store.claim(request({ workerId: "worker-b", now: 1_020 }));
    store.recordWorker(second.run.id, {
      workerName: "fixture-worker",
      status: "succeeded",
      model: "fixture-model",
      sessionId: "session-two",
      summary: "second attempt",
      costUsd: 2.25,
      durationMs: 20,
    }, 1_025);

    assert.deepEqual(store.workerUsage(first.run.id), {
      attempts: 2,
      costUsd: 3.5,
      durationMs: 30,
    });
    assert.equal(store.execution(first.run.id)?.workerCostUsd, 2.25);
  } finally {
    store.close();
  }
});

test("an explicit owner retry extends only an exhausted pre-publication implementation run", () => {
  const store = new RunStore();
  try {
    const first = store.claim(request({ maxAttempts: 1 }));
    store.recordWorkspace(first.run.id, {
      workspacePath: "/old-attempt",
      branchName: "old-branch",
      workerProfile: "fixture-worker",
    }, 1_005);
    store.recordWorker(first.run.id, {
      workerName: "fixture-worker",
      status: "succeeded",
      model: "fixture-model",
      sessionId: "old-session",
      summary: "old result",
      costUsd: 1,
      durationMs: 10,
    }, 1_006);
    store.transition(first.run.id, "failed", 1_010, { failureReason: "verification-failed" });

    const authorized = store.authorizeFailedRetry(first.run.id, 1, 1_020);
    assert.equal(authorized.maxAttempts, 2);
    const retry = store.claim(request({ workerId: "worker-b", now: 1_030, maxAttempts: 1 }));
    assert.equal(retry.claimed, true);
    assert.equal(retry.run.id, first.run.id);
    assert.equal(retry.run.attempt, 2);
    assert.equal(store.execution(first.run.id)?.workspacePath, null);
    assert.equal(store.execution(first.run.id)?.workerStatus, null);
    assert.ok(store.events(first.run.id).some((event) => event.type === "owner-retry-authorized"));
  } finally {
    store.close();
  }
});

test("failed workspace recovery requires owner authorization and preserves worker evidence", () => {
  const store = new RunStore();
  try {
    const claim = store.claim(request({ maxAttempts: 1 }));
    store.recordWorkspace(claim.run.id, {
      workspacePath: "/failed-attempt",
      branchName: "agent-runner/failed-attempt",
      workerProfile: "fixture-worker",
    }, 1_005);
    store.recordWorker(claim.run.id, {
      workerName: "fixture-worker",
      status: "failed",
      model: "fixture-model",
      sessionId: "failed-session",
      summary: "budget exhausted",
      costUsd: 2,
      durationMs: 20,
    }, 1_006);
    store.transition(claim.run.id, "failed", 1_010, { failureReason: "worker-failed" });

    assert.throws(
      () => store.completeFailedWorkspaceRecovery(
        claim.run.id,
        "base-a",
        "head-a",
        ["result.txt"],
        1_020,
      ),
      /no owner-authorized workspace recovery/,
    );
    store.authorizeFailedWorkspaceRecovery(claim.run.id, 1_021);
    const recovered = store.completeFailedWorkspaceRecovery(
      claim.run.id,
      "base-b",
      "head-a",
      ["result.txt"],
      1_022,
    );

    assert.equal(recovered.state, "verified");
    assert.equal(recovered.baseSha, "base-b");
    assert.equal(recovered.failureReason, null);
    assert.equal(recovered.headSha, "head-a");
    assert.equal(store.execution(claim.run.id)?.workerStatus, "failed");
    assert.ok(store.events(claim.run.id).some((event) => event.type === "failed-workspace-recovered"));
  } finally {
    store.close();
  }
});

test("a controller restart reads the existing run and reclaims it only after lease expiry", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-restart-"));
  const databasePath = join(directory, "runs.sqlite");

  try {
    const firstController = new RunStore(databasePath);
    const claim = firstController.claim(request());
    firstController.transition(claim.run.id, "workspace-ready", 1_010);
    firstController.transition(claim.run.id, "running", 1_011);
    firstController.close();

    const restartedController = new RunStore(databasePath);
    const restored = restartedController.get(claim.run.id);
    const duplicate = restartedController.claim(request({ workerId: "worker-b", now: 1_050 }));
    const beforeExpiry = restartedController.reclaimExpired(
      claim.run.id,
      "worker-b",
      1_099,
      100,
    );
    const afterExpiry = restartedController.reclaimExpired(
      claim.run.id,
      "worker-b",
      1_101,
      100,
    );

    assert.equal(restored?.state, "running");
    assert.equal(duplicate.claimed, false);
    assert.equal(beforeExpiry.outcome, "not-stale");
    assert.equal(afterExpiry.outcome, "reclaimed");
    assert.equal(afterExpiry.run?.state, "claimed");
    assert.equal(afterExpiry.run?.attempt, 2);
    assert.equal(afterExpiry.run?.leaseOwner, "worker-b");
    restartedController.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a crashed worker fails visibly after its attempt budget is exhausted", () => {
  const store = new RunStore();
  try {
    const claim = store.claim(request({ maxAttempts: 1 }));
    const result = store.reclaimExpired(claim.run.id, "worker-b", 1_101, 100);

    assert.equal(result.outcome, "failed");
    assert.equal(result.run?.state, "failed");
    assert.equal(result.run?.failureReason, "attempts-exhausted");
  } finally {
    store.close();
  }
});

test("invalid lifecycle transitions fail closed", () => {
  const store = new RunStore();
  try {
    const claim = store.claim(request());

    assert.throws(
      () => store.transition(claim.run.id, "completed", 1_010),
      /Invalid transition: claimed -> completed/,
    );
  } finally {
    store.close();
  }
});

test("project concurrency is enforced atomically across controller connections", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-capacity-"));
  const databasePath = join(directory, "runs.sqlite");
  const firstController = new RunStore(databasePath);
  const secondController = new RunStore(databasePath);
  try {
    const first = firstController.claimWithinCapacity(request(), 1);
    const second = secondController.claimWithinCapacity(
      request({ taskId: "ENV-02", revision: "revision-2", workerId: "worker-b" }),
      1,
    );

    assert.equal(first.outcome, "claimed");
    assert.equal(second.outcome, "capacity");
    assert.equal(firstController.activeCount("fixture/example"), 1);
  } finally {
    firstController.close();
    secondController.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reconciliation leases cannot steal live ownership and can be released", () => {
  const store = new RunStore();
  try {
    const claim = store.claim(request());
    let run = store.transition(claim.run.id, "workspace-ready", 1_010);
    run = store.transition(run.id, "running", 1_011);
    run = store.transition(run.id, "verifying", 1_012, { headSha: "head-a" });
    store.transition(run.id, "verified", 1_013, { headSha: "head-a" });

    const live = store.acquireLease(run.id, "worker-b", 1_050, 100);
    const acquired = store.acquireLease(run.id, "worker-b", 1_101, 100);
    assert.equal(live.outcome, "live");
    assert.equal(acquired.outcome, "acquired");
    assert.equal(acquired.run?.leaseOwner, "worker-b");
    assert.equal(store.releaseLease(run.id, "worker-b", 1_102), true);
    assert.equal(store.get(run.id)?.leaseOwner, null);
  } finally {
    store.close();
  }
});

test("an interrupted synchronization resumes in place within the attempt budget", () => {
  const store = new RunStore();
  try {
    const claim = store.claim(request());
    let run = store.transition(claim.run.id, "workspace-ready", 1_010);
    run = store.transition(run.id, "running", 1_011);
    run = store.transition(run.id, "verifying", 1_012, { headSha: "head-a" });
    run = store.transition(run.id, "verified", 1_013, { headSha: "head-a" });
    run = store.transition(run.id, "synchronized", 1_014, {
      baseSha: "base-b",
      requiresReverification: true,
    });

    const resumed = store.resumeExpired(run.id, "worker-b", 1_101, 100);
    assert.equal(resumed.outcome, "reclaimed");
    assert.equal(resumed.run?.state, "synchronized");
    assert.equal(resumed.run?.attempt, 2);
    assert.equal(resumed.run?.baseSha, "base-b");
  } finally {
    store.close();
  }
});

test("a per-pull-request CI wait clock survives a controller restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-ci-wait-"));
  const databasePath = join(directory, "runs.sqlite");
  const first = new RunStore(databasePath);
  try {
    const claimed = first.claim(request());
    const runId = claimed.run.id;

    const started = first.recordCiWait(runId, "head-a", 10_000);
    const unchanged = first.recordCiWait(runId, "head-a", 20_000);
    assert.equal(started.firstPendingAt, 10_000);
    assert.equal(unchanged.firstPendingAt, 10_000);
    assert.equal(first.ciWait(runId)?.headSha, "head-a");

    const restarted = new RunStore(databasePath);
    try {
      assert.equal(restarted.ciWait(runId)?.firstPendingAt, 10_000);
      const advanced = restarted.recordCiWait(runId, "head-b", 30_000);
      assert.equal(advanced.firstPendingAt, 30_000);
      assert.equal(advanced.headSha, "head-b");
      restarted.clearCiWait(runId);
      assert.equal(restarted.ciWait(runId), null);
    } finally {
      restarted.close();
    }
    assert.equal(first.ciWait(runId), null);
  } finally {
    first.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an interrupted autopilot execution preserves its distinct task-revision quarantines", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-autopilot-execution-"));
  const databasePath = join(directory, "runs.sqlite");
  const first = new RunStore(databasePath);
  try {
    const claimed = first.claim(request());
    const started = first.startOrResumeAutopilot(10_000);
    first.recordAutopilotQuarantine(started.execution.id, claimed.run.id, "ci-failed", 10_001);
    first.recordAutopilotQuarantine(started.execution.id, claimed.run.id, "duplicate", 10_002);
    first.close();

    const restarted = new RunStore(databasePath);
    try {
      const resumed = restarted.startOrResumeAutopilot(20_000);
      assert.equal(resumed.resumed, true);
      assert.equal(resumed.execution.id, started.execution.id);
      assert.deepEqual(restarted.autopilotQuarantines(resumed.execution.id).map((entry) => ({
        taskId: entry.taskId,
        revision: entry.revision,
        reason: entry.reason,
      })), [{ taskId: "ENV-01", revision: "revision-1", reason: "ci-failed" }]);
      restarted.finishAutopilot(resumed.execution.id, 20_001, "no-progress");
      assert.equal(restarted.startOrResumeAutopilot(30_000).resumed, false);
    } finally {
      restarted.close();
    }
  } finally {
    try {
      first.close();
    } catch {
      // The first connection was deliberately closed to simulate an interrupted process.
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
