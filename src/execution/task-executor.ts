import { protectedPathGate } from "../core/policy.js";
import type { RunStore } from "../core/store.js";
import type { RunRecord } from "../core/types.js";
import type { ClaimedTask } from "../planning/project-planner.js";
import type { ProjectContract } from "../project-contract.js";
import type { ProjectRegistration } from "../projects/types.js";
import type { WorkerProfileRegistry } from "../workers/registry.js";
import type { WorkerAdapter, WorkerOutcome } from "../workers/types.js";
import type { WorkspaceRepository } from "../workspaces/git-repository.js";
import type { BaseRevisionProvider } from "../workspaces/base-revision.js";
import type { WorkspaceManager, WorkspaceRecord } from "../workspaces/types.js";
import type { CommandOutcome, CommandRunner } from "./command-runner.js";
import {
  evidenceSnapshotUnchanged,
  stageEvidenceSnapshot,
  type EvidenceSnapshot,
} from "./evidence-snapshot.js";

const MAX_EVIDENCE_CHARS = 4_000;

export interface ExecuteTaskRequest {
  claimed: ClaimedTask;
  project: ProjectRegistration;
  contract: ProjectContract;
  controllerId: string;
  leaseDurationMs: number;
}

export interface TaskExecutionResult {
  outcome: "verified" | "waiting-human" | "failed" | "lease-lost";
  run: RunRecord;
  workspace: WorkspaceRecord | null;
  worker: WorkerOutcome | null;
  changedPaths: string[];
}

export interface TaskExecutorOptions {
  now?: () => number;
  baseRevisions?: BaseRevisionProvider;
}

export class TaskExecutor {
  readonly #runs: RunStore;
  readonly #workspaces: WorkspaceManager;
  readonly #repository: WorkspaceRepository;
  readonly #workers: WorkerProfileRegistry;
  readonly #commands: CommandRunner;
  readonly #now: () => number;
  readonly #baseRevisions: BaseRevisionProvider;

  constructor(
    runs: RunStore,
    workspaces: WorkspaceManager,
    repository: WorkspaceRepository,
    workers: WorkerProfileRegistry,
    commands: CommandRunner,
    options: TaskExecutorOptions = {},
  ) {
    this.#runs = runs;
    this.#workspaces = workspaces;
    this.#repository = repository;
    this.#workers = workers;
    this.#commands = commands;
    this.#now = options.now ?? Date.now;
    this.#baseRevisions = options.baseRevisions ?? {
      inspect: (repositoryPath, baseBranch) => this.#repository.resolveRef(repositoryPath, baseBranch),
      refresh: (repositoryPath, baseBranch) => this.#repository.resolveRef(repositoryPath, baseBranch),
    };
  }

  async execute(request: ExecuteTaskRequest): Promise<TaskExecutionResult> {
    validateRequest(request);
    let lastTimestamp = request.claimed.run.updatedAt;
    const at = (): number => {
      lastTimestamp = Math.max(lastTimestamp + 1, this.#now());
      return lastTimestamp;
    };
    let workspace: WorkspaceRecord | null = null;
    let workerOutcome: WorkerOutcome | null = null;
    let evidenceSnapshot: EvidenceSnapshot | null = null;

    const keepLease = (): void => {
      if (
        !this.#runs.heartbeat(
          request.claimed.run.id,
          request.controllerId,
          at(),
          request.leaseDurationMs,
        )
      ) {
        throw new LeaseLostError(request.claimed.run.id);
      }
    };

    try {
      let worker: WorkerAdapter;
      try {
        worker = this.#workers.get(request.claimed.workerProfile);
      } catch (error) {
        return this.#failure(
          request.claimed.run.id,
          "worker-profile-unavailable",
          error,
          at(),
          workspace,
          workerOutcome,
        );
      }

      keepLease();
      const branchName = branchFor(request.claimed);
      try {
        workspace = await this.#workspaces.create({
          repositoryPath: request.project.rootPath,
          runId: `${request.claimed.run.id}-a${request.claimed.run.attempt}`,
          baseRef: request.claimed.run.baseSha,
          branchName,
        });
      } catch (error) {
        return this.#failure(
          request.claimed.run.id,
          "workspace-failed",
          error,
          at(),
          workspace,
          workerOutcome,
        );
      }
      if (workspace.baseSha !== request.claimed.run.baseSha) {
        return this.#failure(
          request.claimed.run.id,
          "workspace-base-mismatch",
          `Workspace started at ${workspace.baseSha}`,
          at(),
          workspace,
          workerOutcome,
        );
      }
      this.#runs.recordWorkspace(
        request.claimed.run.id,
        {
          workspacePath: workspace.path,
          branchName: workspace.branchName,
          workerProfile: request.claimed.workerProfile,
        },
        at(),
      );
      this.#runs.transition(request.claimed.run.id, "workspace-ready", at());

      keepLease();
      const timeoutMs = request.contract.execution.timeoutMinutes * 60_000;
      const setupPassed = await this.#runCommands(
        request.claimed.run.id,
        "setup",
        request.contract.workspace.setup,
        workspace.path,
        timeoutMs,
        request.controllerId,
        request.leaseDurationMs,
        keepLease,
        at,
      );
      if (!setupPassed) {
        return this.#failure(
          request.claimed.run.id,
          "setup-failed",
          "A workspace setup command failed",
          at(),
          workspace,
          workerOutcome,
        );
      }

      const setupSnapshot = await this.#repository.snapshot(
        workspace.path,
        request.claimed.run.baseSha,
      );
      if (
        setupSnapshot.dirty ||
        setupSnapshot.headSha !== request.claimed.run.baseSha ||
        setupSnapshot.changedPaths.length > 0
      ) {
        return this.#failure(
          request.claimed.run.id,
          "setup-modified-repository",
          { changedPaths: setupSnapshot.changedPaths, headSha: setupSnapshot.headSha },
          at(),
          workspace,
          workerOutcome,
        );
      }

      if (request.claimed.task.evidenceRootPath) {
        try {
          evidenceSnapshot = await stageEvidenceSnapshot(
            request.claimed.task.evidenceRootPath,
            request.claimed.task.sourceRefs ?? [],
            workspace.path,
          );
          this.#runs.recordEvidence(request.claimed.run.id, "approved-evidence-staged", {
            snapshotPath: evidenceSnapshot.rootPath,
            sha256: evidenceSnapshot.sha256,
            sourceRefs: request.claimed.task.sourceRefs ?? [],
          }, at());
        } catch (error) {
          return this.#failure(
            request.claimed.run.id,
            "evidence-preparation-failed",
            error,
            at(),
            workspace,
            workerOutcome,
          );
        }
      }

      this.#runs.transition(request.claimed.run.id, "running", at());
      keepLease();
      workerOutcome = await this.#runWorkerWithHeartbeat(
        request.claimed.run.id,
        request.controllerId,
        request.leaseDurationMs,
        worker,
        {
          workspacePath: workspace.path,
          prompt: workerPrompt(
            request.claimed,
            evidenceSnapshot?.rootPath ?? null,
            previousFailureEvidence(this.#runs, request.claimed.run.id),
          ),
          timeoutMs,
          additionalDirectories: evidenceSnapshot ? [evidenceSnapshot.rootPath] : [],
        },
        at,
      );
      this.#runs.recordWorker(
        request.claimed.run.id,
        {
          workerName: workerOutcome.worker,
          status: workerOutcome.status,
          model: workerOutcome.model,
          sessionId: workerOutcome.sessionId,
          summary: workerOutcome.summary,
          costUsd: workerOutcome.costUsd,
          durationMs: workerOutcome.durationMs,
        },
        at(),
      );
      let evidenceUnchanged = true;
      if (evidenceSnapshot) {
        try {
          evidenceUnchanged = await evidenceSnapshotUnchanged(evidenceSnapshot);
        } catch {
          evidenceUnchanged = false;
        }
      }
      if (!evidenceUnchanged) {
        return this.#failure(
          request.claimed.run.id,
          "worker-modified-evidence",
          "Worker changed its controller-prepared evidence snapshot",
          at(),
          workspace,
          workerOutcome,
        );
      }
      if (workerOutcome.status !== "succeeded") {
        return this.#failure(
          request.claimed.run.id,
          workerOutcome.status === "timed-out" ? "worker-timed-out" : "worker-failed",
          workerOutcome.summary,
          at(),
          workspace,
          workerOutcome,
        );
      }

      keepLease();
      const workerSnapshot = await this.#repository.snapshot(
        workspace.path,
        request.claimed.run.baseSha,
      );
      if (
        workerSnapshot.headSha === request.claimed.run.baseSha &&
        workerSnapshot.changedPaths.length === 0
      ) {
        return this.#failure(
          request.claimed.run.id,
          "worker-no-changes",
          "Worker reported success without changing the repository",
          at(),
          workspace,
          workerOutcome,
        );
      }

      this.#runs.transition(request.claimed.run.id, "verifying", at());
      const taskVerificationPassed = await this.#runCommands(
        request.claimed.run.id,
        "task-verification",
        taskVerificationCommands(request.claimed.task, request.contract.verification.required),
        workspace.path,
        timeoutMs,
        request.controllerId,
        request.leaseDurationMs,
        keepLease,
        at,
      );
      if (!taskVerificationPassed) {
        return this.#failure(
          request.claimed.run.id,
          "task-verification-failed",
          "An approved task-specific verification command failed",
          at(),
          workspace,
          workerOutcome,
        );
      }
      const verificationPassed = await this.#runCommands(
        request.claimed.run.id,
        "verification",
        request.contract.verification.required,
        workspace.path,
        timeoutMs,
        request.controllerId,
        request.leaseDurationMs,
        keepLease,
        at,
      );
      if (!verificationPassed) {
        return this.#failure(
          request.claimed.run.id,
          "verification-failed",
          "A required verification command failed",
          at(),
          workspace,
          workerOutcome,
        );
      }

      keepLease();
      const currentBaseSha = await this.#baseRevisions.inspect(
        request.project.rootPath,
        request.contract.project.baseBranch,
      );
      if (currentBaseSha !== request.claimed.run.baseSha) {
        return this.#failure(
          request.claimed.run.id,
          "base-advanced",
          { claimedBaseSha: request.claimed.run.baseSha, currentBaseSha },
          at(),
          workspace,
          workerOutcome,
        );
      }
      const headSha = await this.#repository.commit(
        workspace.path,
        `agent-runner: ${request.claimed.task.title}`,
      );
      const finalSnapshot = await this.#repository.snapshot(
        workspace.path,
        request.claimed.run.baseSha,
      );
      if (
        headSha === request.claimed.run.baseSha ||
        finalSnapshot.headSha !== headSha ||
        finalSnapshot.changedPaths.length === 0 ||
        finalSnapshot.dirty
      ) {
        return this.#failure(
          request.claimed.run.id,
          "invalid-verified-workspace",
          {
            headSha,
            snapshotHeadSha: finalSnapshot.headSha,
            changedPaths: finalSnapshot.changedPaths,
            dirty: finalSnapshot.dirty,
          },
          at(),
          workspace,
          workerOutcome,
        );
      }

      this.#runs.recordEvidence(
        request.claimed.run.id,
        "verification-passed",
        { headSha, changedPaths: finalSnapshot.changedPaths },
        at(),
      );
      const gate = protectedPathGate(
        finalSnapshot.changedPaths,
        request.contract.verification.protectedPaths,
      );
      const nextState = gate.required ? "waiting-human" : "verified";
      const run = this.#runs.transition(request.claimed.run.id, nextState, at(), { headSha });
      if (gate.required) {
        this.#runs.recordEvidence(
          run.id,
          "human-gate-required",
          { matchedPaths: gate.matchedPaths },
          at(),
        );
      }
      return {
        outcome: gate.required ? "waiting-human" : "verified",
        run: this.#runs.get(run.id) ?? run,
        workspace,
        worker: workerOutcome,
        changedPaths: finalSnapshot.changedPaths,
      };
    } catch (error) {
      if (error instanceof LeaseLostError) {
        const run = this.#runs.get(request.claimed.run.id) ?? request.claimed.run;
        return {
          outcome: "lease-lost",
          run,
          workspace,
          worker: workerOutcome,
          changedPaths: [],
        };
      }
      return this.#failure(
        request.claimed.run.id,
        "execution-error",
        error,
        at(),
        workspace,
        workerOutcome,
      );
    }
  }

  async #runCommands(
    runId: string,
    phase: "setup" | "task-verification" | "verification",
    commands: readonly string[],
    workspacePath: string,
    timeoutMs: number,
    controllerId: string,
    leaseDurationMs: number,
    keepLease: () => void,
    at: () => number,
  ): Promise<boolean> {
    for (const command of commands) {
      keepLease();
      const outcome = await this.#withHeartbeat(
        runId,
        controllerId,
        leaseDurationMs,
        at,
        () => this.#commands.run({ command, cwd: workspacePath, timeoutMs }),
      );
      this.#runs.recordEvidence(runId, "command-finished", commandEvidence(phase, outcome), at());
      if (!outcome.passed) {
        return false;
      }
    }
    return true;
  }

  async #runWorkerWithHeartbeat(
    runId: string,
    controllerId: string,
    leaseDurationMs: number,
    worker: WorkerAdapter,
    request: Parameters<WorkerAdapter["run"]>[0],
    at: () => number,
  ): Promise<WorkerOutcome> {
    return this.#withHeartbeat(runId, controllerId, leaseDurationMs, at, async () => {
      let outcome: WorkerOutcome;
      try {
        outcome = await worker.run(request);
      } catch (error) {
        outcome = failedWorker(worker.name, error);
      }
      return outcome;
    });
  }

  async #withHeartbeat<T>(
    runId: string,
    controllerId: string,
    leaseDurationMs: number,
    at: () => number,
    action: () => Promise<T>,
  ): Promise<T> {
    let leaseLost = false;
    const heartbeatEveryMs = Math.max(250, Math.min(30_000, Math.floor(leaseDurationMs / 3)));
    const timer = setInterval(() => {
      if (!this.#runs.heartbeat(runId, controllerId, at(), leaseDurationMs)) {
        leaseLost = true;
      }
    }, heartbeatEveryMs);
    timer.unref();
    try {
      const result = await action();
      if (leaseLost) {
        throw new LeaseLostError(runId);
      }
      return result;
    } finally {
      clearInterval(timer);
    }
  }

  #failure(
    runId: string,
    reason: string,
    detail: unknown,
    now: number,
    workspace: WorkspaceRecord | null,
    worker: WorkerOutcome | null,
  ): TaskExecutionResult {
    this.#runs.recordEvidence(runId, "execution-failed", { reason, detail: errorDetail(detail) }, now);
    const current = this.#runs.get(runId);
    const run = current && current.state !== "failed" && current.state !== "completed"
      ? this.#runs.transition(runId, "failed", now + 1, { failureReason: reason })
      : current;
    if (!run) {
      throw new Error(`Unknown run: ${runId}`);
    }
    return { outcome: "failed", run, workspace, worker, changedPaths: [] };
  }
}

class LeaseLostError extends Error {
  constructor(runId: string) {
    super(`Lease lost for run ${runId}`);
  }
}

function validateRequest(request: ExecuteTaskRequest): void {
  const { claimed, project, contract, controllerId, leaseDurationMs } = request;
  if (claimed.run.state !== "claimed") {
    throw new Error(`Execution requires a claimed run, received ${claimed.run.state}`);
  }
  if (
    claimed.run.projectId !== project.id ||
    claimed.run.projectId !== contract.project.id ||
    claimed.run.taskId !== claimed.task.id ||
    claimed.run.revision !== claimed.task.revision
  ) {
    throw new Error("Claim, task, registration, and contract identities do not match");
  }
  if (claimed.workerProfile !== project.workerProfile) {
    throw new Error("Claimed worker profile does not match project registration");
  }
  if (claimed.run.leaseOwner !== controllerId || controllerId.trim() === "") {
    throw new Error("Controller does not own the claimed run lease");
  }
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 1) {
    throw new Error("leaseDurationMs must be a positive integer");
  }
}

function branchFor(claimed: ClaimedTask): string {
  const task = claimed.task.id
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";
  return `agent-runner/${task}-a${claimed.run.attempt}-${claimed.run.id.slice(0, 8)}`;
}

function workerPrompt(
  claimed: ClaimedTask,
  evidenceRootPath: string | null,
  previousFailure: string | null,
): string {
  const lines = [
    "Implement exactly one repository task in this isolated workspace.",
    "Follow the repository's checked-in agent instructions.",
    "Do not push, create a pull request, merge, or change unrelated work.",
    "Leave the workspace changes ready for independent controller verification.",
  ];
  if (evidenceRootPath) {
    lines.push(
      "",
      `Approved evidence snapshot (read-only): ${evidenceRootPath}`,
      "Resolve every approved sources/... reference beneath that directory.",
      "Only the task's listed source references are authoritative. You may read files they directly import or reference (such as their design-system bundle and assets), but do not use other prototype candidates or unrelated context from the package.",
      "Never edit, delete, rename, or generate files in the evidence snapshot.",
    );
  }
  if (claimed.run.attempt > 1) {
    lines.push(
      "",
      `This is attempt ${claimed.run.attempt} of ${claimed.run.maxAttempts}.`,
      "The previous attempt failed independent controller verification. Correct that failure and run every required command before reporting success.",
      ...(previousFailure ? ["Previous verification evidence:", previousFailure] : []),
    );
  }
  lines.push("", claimed.task.prompt);
  return lines.join("\n");
}

function previousFailureEvidence(runs: RunStore, runId: string): string | null {
  const failed = [...runs.events(runId)].reverse().find((event) => {
    if (event.type !== "command-finished" || typeof event.detail !== "object" || !event.detail) {
      return false;
    }
    return (event.detail as { passed?: unknown }).passed === false;
  });
  if (!failed || typeof failed.detail !== "object" || !failed.detail) return null;
  const detail = failed.detail as {
    command?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  return [
    typeof detail.command === "string" ? `Command: ${detail.command}` : null,
    typeof detail.stdout === "string" && detail.stdout.trim()
      ? `Output: ${detail.stdout.trim().slice(0, 2_000)}`
      : null,
    typeof detail.stderr === "string" && detail.stderr.trim()
      ? `Error: ${detail.stderr.trim().slice(0, 2_000)}`
      : null,
  ].filter((entry): entry is string => entry !== null).join("\n") || null;
}

function taskVerificationCommands(
  task: ClaimedTask["task"],
  projectCommands: readonly string[],
): string[] {
  const project = new Set(projectCommands);
  return (task.verificationExpectations ?? []).filter((command) => !project.has(command));
}

function commandEvidence(
  phase: "setup" | "task-verification" | "verification",
  outcome: CommandOutcome,
): Record<string, unknown> {
  return {
    phase,
    command: outcome.command,
    passed: outcome.passed,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    stdout: outcome.stdout.slice(0, MAX_EVIDENCE_CHARS),
    stderr: outcome.stderr.slice(0, MAX_EVIDENCE_CHARS),
  };
}

function failedWorker(worker: string, error: unknown): WorkerOutcome {
  return {
    status: "failed",
    worker,
    model: null,
    sessionId: null,
    summary: error instanceof Error ? error.message : String(error),
    costUsd: null,
    durationMs: 0,
  };
}

function errorDetail(value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message } : value;
}
