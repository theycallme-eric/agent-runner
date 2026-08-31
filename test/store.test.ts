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
