import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RunStore } from "../src/core/store.js";
import { ShellCommandRunner } from "../src/execution/command-runner.js";
import type { ProjectInspection } from "../src/planning/project-planner.js";
import { parseProjectContract } from "../src/project-contract.js";
import type { ProjectRegistration } from "../src/projects/types.js";
import { FailedWorkspaceRecovery } from "../src/recovery/failed-workspace.js";
import type { TaskNode } from "../src/tasks/types.js";
import { GitWorkspaceRepository } from "../src/workspaces/git-repository.js";

test("owner recovery independently verifies a failed worker workspace without another worker", async () => {
  const context = createContext();
  try {
    writeFileSync(join(context.workspace, "result.txt"), "done\n");
    const result = await context.recovery.recover(context.request);

    assert.equal(result.recovered, true);
    assert.equal(result.run.state, "verified");
    assert.equal(result.run.failureReason, null);
    assert.notEqual(result.headSha, context.baseSha);
    assert.deepEqual(result.changedPaths, ["result.txt"]);
    assert.deepEqual(result.verificationCommands, [
      'test "$(cat result.txt)" = done',
      "git diff --check",
    ]);
    assert.equal(context.runs.execution(context.runId)?.workerStatus, "failed");
    const events = context.runs.events(context.runId);
    assert.equal(
      events.filter((event) => event.type === "owner-workspace-recovery-authorized").length,
      1,
    );
    assert.ok(events.some((event) => event.type === "failed-workspace-recovered"));
  } finally {
    context.close();
  }
});

test("failed-workspace recovery leaves the run failed when an approved check fails", async () => {
  const context = createContext();
  try {
    writeFileSync(join(context.workspace, "result.txt"), "wrong\n");
    await assert.rejects(
      () => context.recovery.recover(context.request),
      /failed approved command/,
    );

    assert.equal(context.runs.get(context.runId)?.state, "failed");
    assert.equal(context.runs.get(context.runId)?.failureReason, "worker-failed");
    assert.ok(
      context.runs.events(context.runId)
        .some((event) => event.type === "workspace-recovery-verification-failed"),
    );
  } finally {
    context.close();
  }
});

test("failed-workspace recovery refuses protected changes before committing", async () => {
  const context = createContext(["result.txt"]);
  try {
    writeFileSync(join(context.workspace, "result.txt"), "done\n");
    await assert.rejects(
      () => context.recovery.recover(context.request),
      /cannot include protected paths/,
    );

    assert.equal(context.runs.get(context.runId)?.state, "failed");
    assert.equal(git(context.workspace, ["status", "--porcelain=v1"]), "?? result.txt");
    assert.equal(
      context.runs.events(context.runId)
        .some((event) => event.type === "owner-workspace-recovery-authorized"),
      false,
    );
  } finally {
    context.close();
  }
});

interface FixtureContext {
  directory: string;
  workspace: string;
  baseSha: string;
  runId: string;
  runs: RunStore;
  recovery: FailedWorkspaceRecovery;
  request: Parameters<FailedWorkspaceRecovery["recover"]>[0];
  close(): void;
}

function createContext(protectedPaths: string[] = []): FixtureContext {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-recovery-"));
  const repository = join(directory, "repository");
  const workspace = join(directory, "workspace");
  mkdirSync(repository);
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Fixture"]);
  git(repository, ["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repository, "README.md"), "fixture\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "Fixture base"]);
  const baseSha = git(repository, ["rev-parse", "HEAD"]);
  const branchName = "agent-runner/task-01-a1-fixture";
  git(repository, ["worktree", "add", "-b", branchName, workspace, baseSha]);

  const runs = new RunStore(join(directory, "state.sqlite"));
  const claim = runs.claim({
    projectId: "fixture/recovery",
    taskId: "TASK-01",
    revision: "revision-1",
    baseSha,
    workerId: "controller-1",
    now: 1_000,
    leaseDurationMs: 60_000,
    maxAttempts: 1,
  });
  runs.recordWorkspace(claim.run.id, {
    workspacePath: workspace,
    branchName,
    workerProfile: "fixture-worker",
  }, 1_001);
  runs.recordWorker(claim.run.id, {
    workerName: "fixture-agent",
    status: "failed",
    model: "fixture-model",
    sessionId: "fixture-session",
    summary: "usage budget ended after writing a candidate",
    costUsd: 1,
    durationMs: 10,
  }, 1_002);
  runs.transition(claim.run.id, "failed", 1_003, { failureReason: "worker-failed" });
  const protectedYaml = protectedPaths.length === 0
    ? "[]"
    : `\n${protectedPaths.map((path) => `    - pattern: ${path}\n      gate: human`).join("\n")}`;
  const contract = parseProjectContract(`
version: 1
project: { id: fixture/recovery, baseBranch: main }
tasks: { provider: fixture, dependencies: embedded-dag }
workspace: { setup: [] }
verification:
  required:
    - git diff --check
  protectedPaths: ${protectedYaml}
execution: { concurrency: 1, attempts: 1, timeoutMinutes: 1 }
delivery: { pullRequest: true, merge: never }
`);
  const project: ProjectRegistration = {
    id: "fixture/recovery",
    rootPath: repository,
    contractPath: join(directory, "project.yml"),
    workerProfile: "fixture-worker",
    contractVersion: 1,
    enabled: true,
    registeredAt: 1,
    updatedAt: 1,
  };
  const task: TaskNode = {
    id: "TASK-01",
    sourceId: "1",
    revision: "revision-1",
    title: "Recover the fixture",
    prompt: "Create result.txt containing done.",
    status: "pending",
    dependencies: [],
    verificationExpectations: ['test "$(cat result.txt)" = done'],
  };
  const inspection: ProjectInspection = {
    projectId: project.id,
    provider: "fixture",
    dependencies: "embedded-dag",
    graph: { ready: [task], waiting: [], blocked: [], completed: [], edgeCount: 0 },
  };
  let now = 2_000;
  const recovery = new FailedWorkspaceRecovery(
    runs,
    new GitWorkspaceRepository(),
    { inspect: async () => baseSha, refresh: async () => baseSha },
    new ShellCommandRunner(),
    { now: () => ++now },
  );
  return {
    directory,
    workspace,
    baseSha,
    runId: claim.run.id,
    runs,
    recovery,
    request: { runId: claim.run.id, project, contract, inspection },
    close() {
      runs.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function git(cwd: string, argumentsList: string[]): string {
  return execFileSync("git", argumentsList, { cwd, encoding: "utf8" }).trim();
}
