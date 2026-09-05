import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RunStore } from "../src/core/store.js";
import { ShellCommandRunner } from "../src/execution/command-runner.js";
import { TaskExecutor } from "../src/execution/task-executor.js";
import { ProjectPlanner, type ClaimedTask } from "../src/planning/project-planner.js";
import { parseProjectContract, type ProjectContract } from "../src/project-contract.js";
import { ProjectRegistryStore } from "../src/projects/registry.js";
import type { ProjectRegistration } from "../src/projects/types.js";
import { DependencyResolverRegistry } from "../src/tasks/dependency-registry.js";
import { TaskProviderRegistry } from "../src/tasks/provider-registry.js";
import type { TaskNode } from "../src/tasks/types.js";
import { WorkerProfileRegistry } from "../src/workers/registry.js";
import type { WorkerAdapter } from "../src/workers/types.js";
import { GitWorkspaceRepository } from "../src/workspaces/git-repository.js";
import { GitWorktreeManager } from "../src/workspaces/git-worktree.js";

test("executes a claimed task through an isolated worker and independent verification", async () => {
  const worker: WorkerAdapter = {
    name: "fixture-agent",
    run: async (request) => {
      await mkdir(join(request.workspacePath, "src"), { recursive: true });
      await writeFile(join(request.workspacePath, "src", "result.txt"), "done\n");
      return {
        status: "succeeded",
        worker: "fixture-agent",
        model: "fixture-model",
        sessionId: "session-1",
        summary: "implemented fixture",
        costUsd: 0,
        durationMs: 12,
      };
    },
  };
  const context = await createContext(worker);

  try {
    const result = await context.executor.execute(context.request);

    assert.equal(result.outcome, "verified");
    assert.equal(result.run.state, "verified");
    assert.notEqual(result.run.headSha, context.baseSha);
    assert.deepEqual(result.changedPaths, ["src/result.txt"]);
    assert.equal(context.runs.activeCount(context.project.id), 0);
    assert.equal(git(result.workspace?.path ?? "", ["rev-parse", "HEAD"]), result.run.headSha);

    const execution = context.runs.execution(result.run.id);
    assert.equal(execution?.workspacePath, result.workspace?.path);
    assert.equal(execution?.workerProfile, "fixture-profile");
    assert.equal(execution?.workerName, "fixture-agent");
    assert.equal(execution?.workerSessionId, "session-1");
    assert.equal(execution?.workerStatus, "succeeded");
    assert.ok(
      context.runs.events(result.run.id).some((event) => event.type === "verification-passed"),
    );
  } finally {
    context.close();
  }
});

test("stages approved evidence outside the product as an immutable worker reference", async () => {
  let observedPrompt = "";
  let observedEvidenceRoot = "";
  const worker: WorkerAdapter = {
    name: "fixture-agent",
    run: async (request) => {
      observedPrompt = request.prompt;
      observedEvidenceRoot = request.additionalDirectories?.[0] ?? "";
      assert.equal(
        await readFile(join(observedEvidenceRoot, "sources", "design.md"), "utf8"),
        "approved evidence\n",
      );
      await assert.rejects(
        () => writeFile(join(observedEvidenceRoot, "sources", "design.md"), "changed\n"),
      );
      await mkdir(join(request.workspacePath, "src"), { recursive: true });
      await writeFile(join(request.workspacePath, "src", "result.txt"), "done\n");
      return {
        status: "succeeded",
        worker: "fixture-agent",
        model: "fixture-model",
        sessionId: "session-evidence",
        summary: "used approved evidence",
        costUsd: 0,
        durationMs: 1,
      };
    },
  };
  const context = await createContext(worker);
  const evidenceRoot = join(context.directory, "requirements-run");
  mkdirSync(join(evidenceRoot, "sources"), { recursive: true });
  writeFileSync(join(evidenceRoot, "sources", "design.md"), "approved evidence\n");
  context.request.claimed.task.evidenceRootPath = evidenceRoot;
  context.request.claimed.task.sourceRefs = ["sources/design.md"];

  try {
    const result = await context.executor.execute(context.request);
    assert.equal(result.outcome, "verified");
    assert.match(observedPrompt, /Approved evidence snapshot \(read-only\)/);
    assert.match(observedPrompt, /Only the task's listed source references are authoritative/);
    assert.notEqual(observedEvidenceRoot, evidenceRoot);
    assert.equal(readFileSync(join(evidenceRoot, "sources", "design.md"), "utf8"), "approved evidence\n");
  } finally {
    if (observedEvidenceRoot) {
      chmodSync(observedEvidenceRoot, 0o755);
      chmodSync(join(observedEvidenceRoot, "sources"), 0o755);
      chmodSync(join(observedEvidenceRoot, "sources", "design.md"), 0o644);
    }
    context.close();
  }
});

test("fails closed when a worker reports success without repository changes", async () => {
  const context = await createContext(successWorker(async () => undefined));
  try {
    const result = await context.executor.execute(context.request);

    assert.equal(result.outcome, "failed");
    assert.equal(result.run.state, "failed");
    assert.equal(result.run.failureReason, "worker-no-changes");
    assert.equal(context.runs.execution(result.run.id)?.workerStatus, "succeeded");
  } finally {
    context.close();
  }
});

test("persists a thrown worker failure instead of trusting or losing it", async () => {
  const context = await createContext({
    name: "crashing-agent",
    run: async () => {
      throw new Error("worker process crashed");
    },
  });
  try {
    const result = await context.executor.execute(context.request);

    assert.equal(result.outcome, "failed");
    assert.equal(result.run.failureReason, "worker-failed");
    assert.equal(context.runs.execution(result.run.id)?.workerName, "crashing-agent");
    assert.match(context.runs.execution(result.run.id)?.workerSummary ?? "", /process crashed/);
  } finally {
    context.close();
  }
});

test("required verification runs outside the worker and rejects its changes", async () => {
  const context = await createContext(
    successWorker(async (workspacePath) => {
      await mkdir(join(workspacePath, "src"), { recursive: true });
      await writeFile(join(workspacePath, "src", "result.txt"), "wrong\n");
    }),
    ["test \"$(cat src/result.txt)\" = done"],
  );
  try {
    const result = await context.executor.execute(context.request);

    assert.equal(result.outcome, "failed");
    assert.equal(result.run.failureReason, "verification-failed");
    const verification = context.runs.events(result.run.id).find((event) => {
      if (event.type !== "command-finished" || typeof event.detail !== "object" || !event.detail) {
        return false;
      }
      return (event.detail as { phase?: string }).phase === "verification";
    });
    assert.ok(verification);
    assert.equal((verification.detail as { passed: boolean }).passed, false);
  } finally {
    context.close();
  }
});

test("approved task-specific verification also runs outside the worker", async () => {
  const context = await createContext(successWorker(async (workspacePath) => {
    await mkdir(join(workspacePath, "src"), { recursive: true });
    await writeFile(join(workspacePath, "src", "result.txt"), "done\n");
  }));
  context.request.claimed.task.verificationExpectations = [
    "test \"$(cat src/result.txt)\" = a-different-approved-result",
  ];
  try {
    const result = await context.executor.execute(context.request);

    assert.equal(result.outcome, "failed");
    assert.equal(result.run.failureReason, "task-verification-failed");
    const taskVerification = context.runs.events(result.run.id).find((event) => {
      if (event.type !== "command-finished" || typeof event.detail !== "object" || !event.detail) {
        return false;
      }
      return (event.detail as { phase?: string }).phase === "task-verification";
    });
    assert.ok(taskVerification);
    assert.equal((taskVerification.detail as { passed: boolean }).passed, false);
  } finally {
    context.close();
  }
});

test("verified protected-path changes stop at a human gate", async () => {
  const context = await createContext(
    successWorker(async (workspacePath) => {
      const workflowDirectory = join(workspacePath, ".github", "workflows");
      await mkdir(workflowDirectory, { recursive: true });
      await writeFile(join(workflowDirectory, "ci.yml"), "name: fixture\n");
    }),
    ["git diff --check"],
    [".github/workflows/**"],
  );
  try {
    const result = await context.executor.execute(context.request);

    assert.equal(result.outcome, "waiting-human");
    assert.equal(result.run.state, "waiting-human");
    assert.deepEqual(result.changedPaths, [".github/workflows/ci.yml"]);
    assert.ok(
      context.runs.events(result.run.id).some((event) => event.type === "human-gate-required"),
    );
  } finally {
    context.close();
  }
});

test("an advanced base fails closed before the verified workspace is committed", async () => {
  let repositoryPath = "";
  const context = await createContext(
    successWorker(async (workspacePath) => {
      await mkdir(join(workspacePath, "src"), { recursive: true });
      await writeFile(join(workspacePath, "src", "result.txt"), "done\n");
      writeFileSync(join(repositoryPath, "base-change.txt"), "advanced\n");
      git(repositoryPath, ["add", "base-change.txt"]);
      git(repositoryPath, ["commit", "-m", "Advance base"]);
    }),
  );
  repositoryPath = context.project.rootPath;
  try {
    const result = await context.executor.execute(context.request);

    assert.equal(result.outcome, "failed");
    assert.equal(result.run.failureReason, "base-advanced");
    assert.equal(result.run.headSha, null);
  } finally {
    context.close();
  }
});

interface FixtureContext {
  directory: string;
  baseSha: string;
  runs: RunStore;
  registry: ProjectRegistryStore;
  project: ProjectRegistration;
  contract: ProjectContract;
  executor: TaskExecutor;
  request: {
    claimed: ClaimedTask;
    project: ProjectRegistration;
    contract: ProjectContract;
    controllerId: string;
    leaseDurationMs: number;
  };
  close(): void;
}

async function createContext(
  worker: WorkerAdapter,
  verification = ["test \"$(cat src/result.txt)\" = done", "git diff --check"],
  protectedPaths: string[] = [],
): Promise<FixtureContext> {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-execution-"));
  const repository = join(directory, "repository");
  const runner = join(directory, "runner");
  const contractPath = join(runner, "project.yml");
  mkdirSync(repository);
  mkdirSync(runner);
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Fixture"]);
  git(repository, ["config", "user.email", "fixture@example.invalid"]);
  const source = contractSource(verification, protectedPaths);
  writeFileSync(join(repository, "README.md"), "fixture\n");
  writeFileSync(contractPath, source);
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "Fixture base"]);
  const baseSha = git(repository, ["rev-parse", "HEAD"]);
  const contract = parseProjectContract(source);
  const databasePath = join(directory, "state.sqlite");
  const registry = new ProjectRegistryStore(databasePath);
  const project = registry.register({
    id: contract.project.id,
    rootPath: repository,
    contractPath,
    workerProfile: "fixture-profile",
    contractVersion: contract.version,
    now: 1_000,
  }).project;
  const runs = new RunStore(databasePath);
  const providers = new TaskProviderRegistry();
  providers.register({ name: "fixture", listTasks: async () => [fixtureTask()] });
  const dependencies = new DependencyResolverRegistry();
  dependencies.register({ name: "embedded-dag", resolve: async (tasks) => tasks });
  const planner = new ProjectPlanner(runs, providers, dependencies);
  const plan = await planner.claimReady({
    project,
    contract,
    baseSha,
    controllerId: "controller-1",
    now: 1_100,
    leaseDurationMs: 60_000,
  });
  const claimed = plan.claimed[0];
  assert.ok(claimed);
  const workers = new WorkerProfileRegistry();
  workers.register("fixture-profile", worker);
  let now = 1_101;
  const executor = new TaskExecutor(
    runs,
    new GitWorktreeManager(join(directory, "workspaces")),
    new GitWorkspaceRepository(),
    workers,
    new ShellCommandRunner(),
    { now: () => ++now },
  );
  const request = {
    claimed,
    project,
    contract,
    controllerId: "controller-1",
    leaseDurationMs: 60_000,
  };
  return {
    directory,
    baseSha,
    runs,
    registry,
    project,
    contract,
    executor,
    request,
    close() {
      runs.close();
      registry.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function contractSource(verification: string[], protectedPaths: string[]): string {
  const protectedYaml = protectedPaths.length === 0
    ? "[]"
    : `\n${protectedPaths.map((path) => `    - pattern: ${path}\n      gate: human`).join("\n")}`;
  return `
version: 1
project: { id: fixture/executor, baseBranch: main }
tasks: { provider: fixture, dependencies: embedded-dag }
workspace:
  setup:
    - test -f README.md
verification:
  required:
${verification.map((command) => `    - ${command}`).join("\n")}
  protectedPaths: ${protectedYaml}
execution: { concurrency: 1, attempts: 2, timeoutMinutes: 1 }
delivery: { pullRequest: true, merge: never }
`;
}

function fixtureTask(): TaskNode {
  return {
    id: "TASK-01",
    sourceId: "1",
    revision: "revision-1",
    title: "Implement the fixture",
    prompt: "Create src/result.txt containing done.",
    status: "pending",
    dependencies: [],
  };
}

function successWorker(change: (workspacePath: string) => Promise<void>): WorkerAdapter {
  return {
    name: "fixture-agent",
    run: async (request) => {
      await change(request.workspacePath);
      return {
        status: "succeeded",
        worker: "fixture-agent",
        model: "fixture-model",
        sessionId: "session-1",
        summary: "fixture complete",
        costUsd: 0,
        durationMs: 1,
      };
    },
  };
}

function git(cwd: string, argumentsList: string[]): string {
  return execFileSync("git", argumentsList, { cwd, encoding: "utf8" }).trim();
}
