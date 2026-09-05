import { protectedPathGate } from "../core/policy.js";
import type { RunStore } from "../core/store.js";
import type { RunRecord } from "../core/types.js";
import type { CommandOutcome, CommandRunner } from "../execution/command-runner.js";
import type { ProjectInspection } from "../planning/project-planner.js";
import type { ProjectContract } from "../project-contract.js";
import type { ProjectRegistration } from "../projects/types.js";
import type { TaskNode } from "../tasks/types.js";
import type { BaseRevisionProvider } from "../workspaces/base-revision.js";
import type { WorkspaceRepository } from "../workspaces/git-repository.js";

const MAX_EVIDENCE_CHARS = 4_000;

export interface RecoveryWorkspaceRepository extends WorkspaceRepository {
  currentBranch(workspacePath: string): Promise<string>;
  isAncestor(workspacePath: string, ancestorSha: string, descendantSha: string): Promise<boolean>;
}

export interface FailedWorkspaceRecoveryRequest {
  runId: string;
  project: ProjectRegistration;
  contract: ProjectContract;
  inspection: ProjectInspection;
}

export interface FailedWorkspaceRecoveryResult {
  recovered: true;
  run: RunRecord;
  taskId: string;
  workspacePath: string;
  branchName: string;
  baseSha: string;
  baseSynchronized: boolean;
  headSha: string;
  changedPaths: string[];
  verificationCommands: string[];
  nextAction: "normal-controller-delivery";
}

/**
 * Explicit owner recovery for useful code left by a failed worker.
 *
 * This path never launches a worker and never publishes. It converts one still-current,
 * independently verified failed workspace into the ordinary `verified` state so the existing
 * delivery/reconciliation path remains the only code allowed to push, open, or merge a PR.
 */
export class FailedWorkspaceRecovery {
  readonly #runs: RunStore;
  readonly #repository: RecoveryWorkspaceRepository;
  readonly #baseRevisions: BaseRevisionProvider;
  readonly #commands: CommandRunner;
  readonly #now: () => number;

  constructor(
    runs: RunStore,
    repository: RecoveryWorkspaceRepository,
    baseRevisions: BaseRevisionProvider,
    commands: CommandRunner,
    options: { now?: () => number } = {},
  ) {
    this.#runs = runs;
    this.#repository = repository;
    this.#baseRevisions = baseRevisions;
    this.#commands = commands;
    this.#now = options.now ?? Date.now;
  }

  async recover(request: FailedWorkspaceRecoveryRequest): Promise<FailedWorkspaceRecoveryResult> {
    const initial = requireRun(this.#runs, request.runId);
    validateIdentity(initial, request);
    const task = requireCurrentReadyTask(initial, request.inspection);
    const execution = this.#runs.execution(initial.id);
    if (!execution?.workspacePath || !execution.branchName) {
      throw new Error(`Run ${initial.id} has no recorded failed workspace`);
    }
    if (execution.workerProfile !== request.project.workerProfile) {
      throw new Error(`Run ${initial.id} worker profile no longer matches the project`);
    }

    let lastTimestamp = initial.updatedAt;
    const at = (): number => {
      lastTimestamp = Math.max(lastTimestamp + 1, this.#now());
      return lastTimestamp;
    };
    const branchName = await this.#repository.currentBranch(execution.workspacePath);
    if (branchName !== execution.branchName) {
      throw new Error(
        `Recovery refused because workspace branch ${branchName} does not match ${execution.branchName}`,
      );
    }
    const initialSnapshot = await this.#repository.snapshot(
      execution.workspacePath,
      initial.baseSha,
    );
    if (
      initialSnapshot.changedPaths.length === 0 ||
      !await this.#repository.isAncestor(
        execution.workspacePath,
        initial.baseSha,
        initialSnapshot.headSha,
      )
    ) {
      throw new Error("Recovery requires a changed workspace descended from the recorded base");
    }
    refuseProtectedPaths(
      initialSnapshot.changedPaths,
      request.contract.verification.protectedPaths,
    );

    this.#runs.authorizeFailedWorkspaceRecovery(initial.id, at());
    const verificationCommands = approvedVerificationCommands(
      task,
      request.contract.verification.required,
    );
    const timeoutMs = request.contract.execution.timeoutMinutes * 60_000;
    const candidateHeadSha = await this.#repository.commit(
      execution.workspacePath,
      `agent-runner: ${task.title}`,
    );
    const candidateSnapshot = await this.#repository.snapshot(
      execution.workspacePath,
      initial.baseSha,
    );
    if (
      candidateHeadSha === initial.baseSha ||
      candidateSnapshot.headSha !== candidateHeadSha ||
      candidateSnapshot.changedPaths.length === 0 ||
      candidateSnapshot.dirty ||
      !await this.#repository.isAncestor(execution.workspacePath, initial.baseSha, candidateHeadSha)
    ) {
      this.#runs.recordEvidence(initial.id, "workspace-recovery-invalid-commit", {
        headSha: candidateHeadSha,
        snapshot: candidateSnapshot,
      }, at());
      throw new Error("Recovered workspace did not produce a valid clean commit");
    }
    refuseProtectedPaths(candidateSnapshot.changedPaths, request.contract.verification.protectedPaths);

    const currentBaseSha = await this.#baseRevisions.refresh(
      request.project.rootPath,
      request.contract.project.baseBranch,
    );
    let recoveredBaseSha = initial.baseSha;
    let headSha = candidateHeadSha;
    if (currentBaseSha !== initial.baseSha) {
      this.#runs.recordEvidence(initial.id, "workspace-recovery-synchronization-started", {
        fromBaseSha: initial.baseSha,
        toBaseSha: currentBaseSha,
        candidateHeadSha,
      }, at());
      const synchronization = await this.#repository.synchronize(
        execution.workspacePath,
        currentBaseSha,
      );
      if (synchronization.outcome === "conflict") {
        this.#runs.recordEvidence(initial.id, "workspace-recovery-synchronization-conflict", {
          fromBaseSha: initial.baseSha,
          toBaseSha: currentBaseSha,
          conflictedPaths: synchronization.conflictedPaths,
        }, at());
        throw new Error(
          `Recovered workspace conflicts with the current base: ${synchronization.conflictedPaths.join(", ")}`,
        );
      }
      recoveredBaseSha = currentBaseSha;
      headSha = synchronization.headSha;
      this.#runs.recordEvidence(initial.id, "workspace-recovery-synchronized", {
        baseSha: recoveredBaseSha,
        headSha,
      }, at());
    }

    await this.#verify(
      initial.id,
      verificationCommands,
      execution.workspacePath,
      timeoutMs,
      at,
    );
    const baseAfterVerification = await this.#baseRevisions.inspect(
      request.project.rootPath,
      request.contract.project.baseBranch,
    );
    if (baseAfterVerification !== recoveredBaseSha) {
      this.#runs.recordEvidence(initial.id, "workspace-recovery-base-advanced", {
        verifiedBaseSha: recoveredBaseSha,
        currentBaseSha: baseAfterVerification,
      }, at());
      throw new Error("Recovery paused because the base advanced during verification; rerun it");
    }
    const finalSnapshot = await this.#repository.snapshot(
      execution.workspacePath,
      recoveredBaseSha,
    );
    if (
      finalSnapshot.headSha !== headSha ||
      finalSnapshot.changedPaths.length === 0 ||
      finalSnapshot.dirty ||
      !await this.#repository.isAncestor(execution.workspacePath, recoveredBaseSha, headSha)
    ) {
      this.#runs.recordEvidence(initial.id, "workspace-recovery-invalid-final-snapshot", {
        baseSha: recoveredBaseSha,
        headSha,
        snapshot: finalSnapshot,
      }, at());
      throw new Error("Recovered workspace changed or became invalid during verification");
    }
    refuseProtectedPaths(finalSnapshot.changedPaths, request.contract.verification.protectedPaths);
    const run = this.#runs.completeFailedWorkspaceRecovery(
      initial.id,
      recoveredBaseSha,
      headSha,
      finalSnapshot.changedPaths,
      at(),
    );
    return {
      recovered: true,
      run,
      taskId: task.id,
      workspacePath: execution.workspacePath,
      branchName: execution.branchName,
      baseSha: recoveredBaseSha,
      baseSynchronized: recoveredBaseSha !== initial.baseSha,
      headSha,
      changedPaths: finalSnapshot.changedPaths,
      verificationCommands: verificationCommands.map((item) => item.command),
      nextAction: "normal-controller-delivery",
    };
  }

  async #verify(
    runId: string,
    verificationCommands: ReturnType<typeof approvedVerificationCommands>,
    workspacePath: string,
    timeoutMs: number,
    at: () => number,
  ): Promise<void> {
    for (const item of verificationCommands) {
      const outcome = await this.#commands.run({ command: item.command, cwd: workspacePath, timeoutMs });
      this.#runs.recordEvidence(
        runId,
        "command-finished",
        commandEvidence(item.phase, outcome),
        at(),
      );
      if (!outcome.passed) {
        this.#runs.recordEvidence(runId, "workspace-recovery-verification-failed", {
          phase: item.phase,
          command: item.command,
        }, at());
        throw new Error(`Recovered workspace failed approved command: ${item.command}`);
      }
    }
  }
}

function requireRun(runs: RunStore, runId: string): RunRecord {
  const run = runs.get(runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  return run;
}

function validateIdentity(
  run: RunRecord,
  request: FailedWorkspaceRecoveryRequest,
): void {
  if (run.state !== "failed") {
    throw new Error(`Run ${run.id} is not failed`);
  }
  if (!["worker-failed", "worker-timed-out"].includes(run.failureReason ?? "")) {
    throw new Error(`Run ${run.id} is not eligible for failed-workspace recovery`);
  }
  if (
    run.projectId !== request.project.id ||
    request.project.id !== request.contract.project.id ||
    request.inspection.projectId !== request.project.id
  ) {
    throw new Error("Run, project, contract, and inspected task graph do not match");
  }
  if (request.project.contractVersion !== request.contract.version) {
    throw new Error("Registered and loaded project contract versions do not match");
  }
  if (request.project.enabled === false) {
    throw new Error(`Project ${request.project.id} is disabled`);
  }
}

function requireCurrentReadyTask(run: RunRecord, inspection: ProjectInspection): TaskNode {
  const allTasks = [
    ...inspection.graph.ready,
    ...inspection.graph.waiting,
    ...inspection.graph.blocked,
    ...inspection.graph.completed,
  ];
  const task = allTasks.find((candidate) => candidate.id === run.taskId);
  if (!task) {
    throw new Error(`Approved task ${run.taskId} no longer exists`);
  }
  if (task.revision !== run.revision) {
    throw new Error(`Approved task ${run.taskId} changed revision after the failed run`);
  }
  if (!inspection.graph.ready.some((candidate) => candidate.id === task.id)) {
    throw new Error(`Approved task ${run.taskId} is no longer ready`);
  }
  return task;
}

function approvedVerificationCommands(
  task: TaskNode,
  projectCommands: readonly string[],
): Array<{ phase: "recovery-task-verification" | "recovery-verification"; command: string }> {
  const project = new Set(projectCommands);
  return [
    ...(task.verificationExpectations ?? [])
      .filter((command) => !project.has(command))
      .map((command) => ({ phase: "recovery-task-verification" as const, command })),
    ...projectCommands.map((command) => ({
      phase: "recovery-verification" as const,
      command,
    })),
  ];
}

function refuseProtectedPaths(
  changedPaths: readonly string[],
  rules: ProjectContract["verification"]["protectedPaths"],
): void {
  const gate = protectedPathGate(changedPaths, rules);
  if (gate.required) {
    throw new Error(
      `Failed-workspace recovery cannot include protected paths: ${gate.matchedPaths.join(", ")}`,
    );
  }
}

function commandEvidence(
  phase: "recovery-task-verification" | "recovery-verification",
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
