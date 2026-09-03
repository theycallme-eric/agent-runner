import { protectedPathGate } from "../core/policy.js";
import type { RunStore } from "../core/store.js";
import type { RunRecord, RunState } from "../core/types.js";
import {
  DEFAULT_MAX_CI_WAIT_MINUTES,
  DeliveryCoordinator,
  type DeliveryResult,
} from "../delivery/coordinator.js";
import type { PullRequestPublisher } from "../delivery/types.js";
import type { CommandOutcome, CommandRunner } from "../execution/command-runner.js";
import { TaskExecutor, type TaskExecutionResult } from "../execution/task-executor.js";
import type { ProjectInspection } from "../planning/project-planner.js";
import type { ProjectContract } from "../project-contract.js";
import type { ProjectRegistration } from "../projects/types.js";
import type { TaskNode } from "../tasks/types.js";
import type { WorkerProfileRegistry } from "../workers/registry.js";
import type { BaseRevisionProvider } from "../workspaces/base-revision.js";
import type { WorkspaceRepository } from "../workspaces/git-repository.js";
import type { WorkspaceManager } from "../workspaces/types.js";

const ACTIVE_STATES: readonly RunState[] = [
  "claimed",
  "workspace-ready",
  "running",
  "verifying",
];
const RECONCILABLE_STATES: readonly RunState[] = [
  "synchronized",
  "verified",
  "pr-open",
  "ci",
];
const MAX_EVIDENCE_CHARS = 4_000;

export interface ReconcileProjectRequest {
  project: ProjectRegistration;
  contract: ProjectContract;
  inspection: ProjectInspection;
  currentBaseSha: string;
  controllerId: string;
  leaseDurationMs: number;
}

export interface ReconciliationResult {
  runId: string;
  taskId: string;
  initialState: RunState;
  state: RunState;
  execution: TaskExecutionResult["outcome"] | "not-run";
  lease: "none" | "live" | "acquired" | "reclaimed";
  outcome:
    | "live-lease"
    | "waiting-human"
    | "reclaimed"
    | "synchronized"
    | "waiting-ci"
    | "completed"
    | "retryable-failure"
    | "failed";
  base: "current" | "advanced";
  workspace: "not-recorded" | "present" | "missing";
  workerStatus: string | null;
  workerSessionId: string | null;
  branchName: string | null;
  pullRequestUrl: string | null;
  pullRequestState: "none" | "open" | "closed" | "merged" | "missing" | "unknown";
  ciStatus: string | null;
  ciWaitExpired: boolean;
  ciWaitDetail: string | null;
  failureReason: string | null;
}

export interface ReconciliationControllerOptions {
  now?: () => number;
  maxCiWaitMinutes?: number;
}

export class ReconciliationController {
  readonly #runs: RunStore;
  readonly #workspaces: WorkspaceManager;
  readonly #repository: WorkspaceRepository;
  readonly #workers: WorkerProfileRegistry;
  readonly #commands: CommandRunner;
  readonly #baseRevisions: BaseRevisionProvider;
  readonly #publisher: PullRequestPublisher | null;
  readonly #now: () => number;
  readonly #maxCiWaitMinutes: number;

  constructor(
    runs: RunStore,
    workspaces: WorkspaceManager,
    repository: WorkspaceRepository,
    workers: WorkerProfileRegistry,
    commands: CommandRunner,
    baseRevisions: BaseRevisionProvider,
    publisher: PullRequestPublisher | null,
    options: ReconciliationControllerOptions = {},
  ) {
    this.#runs = runs;
    this.#workspaces = workspaces;
    this.#repository = repository;
    this.#workers = workers;
    this.#commands = commands;
    this.#baseRevisions = baseRevisions;
    this.#publisher = publisher;
    this.#now = options.now ?? Date.now;
    this.#maxCiWaitMinutes = options.maxCiWaitMinutes ?? DEFAULT_MAX_CI_WAIT_MINUTES;
  }

  async reconcileProject(request: ReconcileProjectRequest): Promise<ReconciliationResult[]> {
    validateRequest(request);
    const tasks = new Map(allTasks(request.inspection).map((task) => [task.id, task]));
    const runs = this.#runs
      .listProject(request.project.id)
      .filter((run) => !["completed", "failed"].includes(run.state));
    const results: ReconciliationResult[] = [];
    let currentBaseSha = request.currentBaseSha;
    for (const run of runs) {
      const result = await this.#reconcileRun(run, tasks.get(run.taskId), {
        ...request,
        currentBaseSha,
      });
      results.push(result);
      if (
        request.contract.delivery.merge === "after-required-checks" &&
        result.outcome === "completed"
      ) {
        currentBaseSha = await this.#baseRevisions.refresh(
          request.project.rootPath,
          request.contract.project.baseBranch,
        );
      }
    }
    return results;
  }

  async #reconcileRun(
    initial: RunRecord,
    task: TaskNode | undefined,
    request: ReconcileProjectRequest,
  ): Promise<ReconciliationResult> {
    const execution = this.#runs.execution(initial.id);
    const delivery = this.#runs.delivery(initial.id);
    const base = initial.baseSha === request.currentBaseSha ? "current" : "advanced";
    let workspaceState: ReconciliationResult["workspace"] = execution?.workspacePath
      ? "present"
      : "not-recorded";
    let observedPullRequestState: ReconciliationResult["pullRequestState"] = delivery
      ? "unknown"
      : "none";
    let executionOutcome: ReconciliationResult["execution"] = "not-run";
    let leaseState: ReconciliationResult["lease"] = "none";
    const result = (): ReconciliationResult => {
      const run = this.#runs.get(initial.id) ?? initial;
      const currentExecution = this.#runs.execution(initial.id);
      const currentDelivery = this.#runs.delivery(initial.id);
      return {
        runId: run.id,
        taskId: run.taskId,
        initialState: initial.state,
        state: run.state,
        execution: executionOutcome,
        lease: leaseState,
        outcome: outcomeFor(run),
        base,
        workspace: workspaceState,
        workerStatus: currentExecution?.workerStatus ?? null,
        workerSessionId: currentExecution?.workerSessionId ?? null,
        branchName: currentExecution?.branchName ?? null,
        pullRequestUrl: currentDelivery?.url ?? null,
        pullRequestState: currentDelivery ? observedPullRequestState : "none",
        ciStatus: currentDelivery?.ciStatus ?? null,
        ciWaitExpired: false,
        ciWaitDetail: null,
        failureReason: run.failureReason,
      };
    };

    if (initial.state === "waiting-human") {
      return { ...result(), outcome: "waiting-human" };
    }
    if (ACTIVE_STATES.includes(initial.state) && !initial.requiresReverification) {
      if (initial.leaseExpiresAt === null) {
        return this.#fail(initial, "active-run-without-lease", null, result);
      }
      if (initial.leaseExpiresAt > this.#now()) {
        leaseState = "live";
        return { ...result(), outcome: "live-lease" };
      }
      if (!task || task.revision !== initial.revision || task.status !== "pending") {
        return this.#fail(initial, taskFailure(initial, task), null, result);
      }
      const reclaimed = this.#runs.reclaimExpired(
        initial.id,
        request.controllerId,
        this.#now(),
        request.leaseDurationMs,
      );
      if (reclaimed.outcome === "failed") {
        return { ...result(), outcome: "failed" };
      }
      if (reclaimed.outcome !== "reclaimed") {
        leaseState = "live";
        return { ...result(), outcome: "live-lease" };
      }
      leaseState = "reclaimed";
      const executor = new TaskExecutor(
        this.#runs,
        this.#workspaces,
        this.#repository,
        this.#workers,
        this.#commands,
        { now: this.#now, baseRevisions: this.#baseRevisions },
      );
      const executed = await executor.execute({
        claimed: { task, run: reclaimed.run, workerProfile: request.project.workerProfile },
        project: request.project,
        contract: request.contract,
        controllerId: request.controllerId,
        leaseDurationMs: request.leaseDurationMs,
      });
      executionOutcome = executed.outcome;
      let delivered: DeliveryResult | null = null;
      if (executed.outcome === "verified" && this.#publisher) {
        delivered = await this.#deliver(initial.id, task, request);
      }
      this.#runs.releaseLease(initial.id, request.controllerId, this.#now());
      return executionResult(result(), executed, delivered);
    }
    if (!RECONCILABLE_STATES.includes(initial.state)) {
      return this.#fail(initial, "unsupported-reconciliation-state", initial.state, result);
    }

    const lease = initial.requiresReverification &&
        ["synchronized", "verifying"].includes(initial.state) &&
        initial.leaseExpiresAt !== null &&
        initial.leaseExpiresAt <= this.#now()
      ? this.#runs.resumeExpired(
          initial.id,
          request.controllerId,
          this.#now(),
          request.leaseDurationMs,
        )
      : this.#runs.acquireLease(
          initial.id,
          request.controllerId,
          this.#now(),
          request.leaseDurationMs,
        );
    if (lease.outcome === "failed") {
      return { ...result(), outcome: "failed" };
    }
    if (lease.outcome !== "acquired" && lease.outcome !== "reclaimed") {
      if (lease.outcome === "live" || lease.outcome === "not-stale") {
        leaseState = "live";
      }
      return {
        ...result(),
        outcome: lease.outcome === "live" || lease.outcome === "not-stale"
          ? "live-lease"
          : "failed",
      };
    }
    leaseState = lease.outcome === "reclaimed" ? "reclaimed" : "acquired";

    try {
      const run = this.#runs.get(initial.id) ?? initial;
      if (!task || task.revision !== run.revision || task.status !== "pending") {
        return this.#fail(run, taskFailure(run, task), null, result);
      }
      if (!execution?.workspacePath || !execution.branchName || !run.headSha) {
        return this.#fail(run, "missing-verified-workspace", null, result, "missing");
      }
      let snapshot;
      try {
        snapshot = await this.#repository.snapshot(execution.workspacePath, run.baseSha);
      } catch (error) {
        workspaceState = "missing";
        return this.#fail(run, "missing-verified-workspace", error, result, "missing");
      }
      if (snapshot.dirty || snapshot.headSha !== run.headSha || snapshot.changedPaths.length === 0) {
        return this.#fail(run, "verified-workspace-drifted", snapshot, result);
      }
      if (delivery && this.#publisher) {
        let observed;
        try {
          observed = await this.#publisher.inspectPullRequest(request.project.id, delivery.externalId);
        } catch (error) {
          this.#runs.recordEvidence(run.id, "reconciliation-retryable-failure", {
            reason: "pull-request-observation-failed",
            detail: errorText(error),
          }, this.#now());
          return { ...result(), outcome: "retryable-failure", pullRequestState: "unknown" };
        }
        if (!observed) {
          observedPullRequestState = "missing";
          return this.#fail(run, "pull-request-missing", delivery, result, undefined, "missing");
        }
        observedPullRequestState = observed.state;
        const automaticMerge = request.contract.delivery.merge === "after-required-checks";
        if (observed.state !== "open" && !(automaticMerge && observed.state === "merged")) {
          return this.#fail(
            run,
            observed.state === "merged" ? "pull-request-merged" : "pull-request-closed",
            observed,
            result,
            undefined,
            observed.state,
          );
        }
        if (
          (!automaticMerge && !observed.draft) ||
          observed.externalId !== delivery.externalId ||
          observed.branchName !== delivery.branchName ||
          observed.baseBranch !== delivery.baseBranch ||
          (observed.headSha !== delivery.headSha && observed.headSha !== run.headSha)
        ) {
          return this.#fail(run, "pull-request-identity-drift", observed, result);
        }
        if (observed.state === "merged") {
          const delivered = await this.#deliver(run.id, task, request);
          const final = withDelivery(result(), delivered);
          return { ...final, pullRequestState: "merged" };
        }
      }

      const current = this.#runs.get(run.id) ?? run;
      if (current.baseSha !== request.currentBaseSha || current.requiresReverification) {
        const synchronized = await this.#synchronize(current, task, execution.workspacePath, request);
        if (synchronized !== "verified") {
          return {
            ...result(),
            outcome: synchronized === "waiting-human" ? "waiting-human" : "failed",
          };
        }
      }
      const ready = this.#runs.get(run.id) ?? run;
      const delivered = this.#publisher
        ? await this.#deliver(ready.id, task, request)
        : null;
      const final = result();
      return delivered
        ? withDelivery(final, delivered)
        : { ...final, outcome: "synchronized" };
    } catch (error) {
      const run = this.#runs.get(initial.id) ?? initial;
      return this.#fail(run, "reconciliation-error", errorText(error), result);
    } finally {
      this.#runs.releaseLease(initial.id, request.controllerId, this.#now());
    }
  }

  async #synchronize(
    initial: RunRecord,
    task: TaskNode,
    workspacePath: string,
    request: ReconcileProjectRequest,
  ): Promise<"verified" | "waiting-human" | "failed"> {
    let run = initial;
    if (run.baseSha !== request.currentBaseSha) {
      run = this.#runs.transition(run.id, "synchronized", this.#now(), {
        baseSha: request.currentBaseSha,
        requiresReverification: true,
      });
      this.#runs.recordEvidence(run.id, "base-advance-detected", {
        previousBaseSha: initial.baseSha,
        currentBaseSha: request.currentBaseSha,
      }, this.#now());
    }
    const synchronization = await this.#repository.synchronize(workspacePath, request.currentBaseSha);
    if (synchronization.outcome === "conflict") {
      this.#terminal(run, "base-synchronization-conflict", {
        conflictedPaths: synchronization.conflictedPaths,
      });
      return "failed";
    }
    const snapshot = await this.#repository.snapshot(workspacePath, request.currentBaseSha);
    if (snapshot.dirty || snapshot.changedPaths.length === 0) {
      this.#terminal(run, "invalid-synchronized-workspace", snapshot);
      return "failed";
    }
    if (run.state === "synchronized") {
      run = this.#runs.transition(run.id, "verifying", this.#now(), {
        headSha: synchronization.headSha,
        requiresReverification: true,
      });
    }
    const timeoutMs = request.contract.execution.timeoutMinutes * 60_000;
    const commands = [
      ...(task.verificationExpectations ?? []).filter(
        (command) => !request.contract.verification.required.includes(command),
      ),
      ...request.contract.verification.required,
    ];
    for (const command of commands) {
      if (!this.#runs.heartbeat(run.id, request.controllerId, this.#now(), request.leaseDurationMs)) {
        this.#terminal(run, "reconciliation-lease-lost", null);
        return "failed";
      }
      const outcome = await this.#withHeartbeat(
        run.id,
        request.controllerId,
        request.leaseDurationMs,
        () => this.#commands.run({ command, cwd: workspacePath, timeoutMs }),
      );
      this.#runs.recordEvidence(run.id, "command-finished", commandEvidence(outcome), this.#now());
      if (!outcome.passed) {
        this.#terminal(run, "post-sync-verification-failed", { command });
        return "failed";
      }
    }
    const verified = await this.#repository.snapshot(workspacePath, request.currentBaseSha);
    if (verified.dirty || verified.headSha !== synchronization.headSha || verified.changedPaths.length === 0) {
      this.#terminal(run, "invalid-post-sync-verification", verified);
      return "failed";
    }
    const gate = protectedPathGate(
      verified.changedPaths,
      request.contract.verification.protectedPaths,
    );
    if (gate.required) {
      this.#runs.transition(run.id, "waiting-human", this.#now(), {
        headSha: verified.headSha,
        requiresReverification: false,
      });
      this.#runs.recordEvidence(run.id, "human-gate-required", gate, this.#now());
      return "waiting-human";
    }
    this.#runs.recordEvidence(run.id, "synchronization-verified", {
      baseSha: request.currentBaseSha,
      headSha: verified.headSha,
      changedPaths: verified.changedPaths,
    }, this.#now());
    this.#runs.transition(run.id, "verified", this.#now(), {
      headSha: verified.headSha,
      requiresReverification: false,
    });
    return "verified";
  }

  #deliver(
    runId: string,
    task: TaskNode,
    request: ReconcileProjectRequest,
  ): Promise<DeliveryResult> {
    if (!this.#publisher) {
      throw new Error("Pull-request delivery is not configured");
    }
    return new DeliveryCoordinator(
      this.#runs,
      this.#repository,
      this.#publisher,
      { now: this.#now, baseRevisions: this.#baseRevisions },
    ).deliver({
      runId,
      task,
      project: request.project,
      contract: request.contract,
      maxCiWaitMinutes: this.#maxCiWaitMinutes,
    });
  }

  async #withHeartbeat<T>(
    runId: string,
    controllerId: string,
    leaseDurationMs: number,
    action: () => Promise<T>,
  ): Promise<T> {
    let leaseLost = false;
    const every = Math.max(250, Math.min(30_000, Math.floor(leaseDurationMs / 3)));
    const timer = setInterval(() => {
      if (!this.#runs.heartbeat(runId, controllerId, this.#now(), leaseDurationMs)) {
        leaseLost = true;
      }
    }, every);
    timer.unref();
    try {
      const value = await action();
      if (leaseLost) {
        throw new Error(`Lease lost for run ${runId}`);
      }
      return value;
    } finally {
      clearInterval(timer);
    }
  }

  #fail(
    run: RunRecord,
    reason: string,
    detail: unknown,
    current: () => ReconciliationResult,
    workspace?: ReconciliationResult["workspace"],
    pullRequestState?: ReconciliationResult["pullRequestState"],
  ): ReconciliationResult {
    this.#terminal(run, reason, detail);
    return {
      ...current(),
      outcome: "failed",
      ...(workspace ? { workspace } : {}),
      ...(pullRequestState ? { pullRequestState } : {}),
    };
  }

  #terminal(run: RunRecord, reason: string, detail: unknown): void {
    this.#runs.recordEvidence(run.id, "reconciliation-failed", { reason, detail }, this.#now());
    const current = this.#runs.get(run.id);
    if (current && !["failed", "completed"].includes(current.state)) {
      this.#runs.transition(run.id, "failed", this.#now(), { failureReason: reason });
    }
  }
}

function allTasks(inspection: ProjectInspection): TaskNode[] {
  return [
    ...inspection.graph.ready,
    ...inspection.graph.waiting,
    ...inspection.graph.blocked,
    ...inspection.graph.completed,
  ];
}

function taskFailure(run: RunRecord, task: TaskNode | undefined): string {
  if (!task) {
    return "task-missing";
  }
  if (task.revision !== run.revision) {
    return "task-revision-changed";
  }
  return `task-${task.status}`;
}

function outcomeFor(run: RunRecord): ReconciliationResult["outcome"] {
  if (run.state === "completed") return "completed";
  if (run.state === "failed") return "failed";
  if (run.state === "waiting-human") return "waiting-human";
  if (run.state === "ci") return "waiting-ci";
  return "synchronized";
}

function withDelivery(
  current: ReconciliationResult,
  delivery: DeliveryResult,
): ReconciliationResult {
  return {
    ...current,
    outcome: delivery.outcome,
    ciWaitExpired: delivery.ciWaitExpired,
    ciWaitDetail: delivery.ciWaitExpired ? delivery.message : null,
  };
}

function executionResult(
  current: ReconciliationResult,
  execution: TaskExecutionResult,
  delivery: DeliveryResult | null,
): ReconciliationResult {
  if (delivery) {
    return withDelivery(current, delivery);
  }
  if (execution.outcome === "failed" || execution.outcome === "lease-lost") {
    return { ...current, outcome: "failed" };
  }
  if (execution.outcome === "waiting-human") {
    return { ...current, outcome: "waiting-human" };
  }
  return { ...current, outcome: "reclaimed" };
}

function commandEvidence(outcome: CommandOutcome): Record<string, unknown> {
  return {
    phase: "post-sync-verification",
    command: outcome.command,
    passed: outcome.passed,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    stdout: outcome.stdout.slice(0, MAX_EVIDENCE_CHARS),
    stderr: outcome.stderr.slice(0, MAX_EVIDENCE_CHARS),
  };
}

function validateRequest(request: ReconcileProjectRequest): void {
  if (
    request.project.id !== request.contract.project.id ||
    request.inspection.projectId !== request.project.id
  ) {
    throw new Error("Reconciliation project identities do not match");
  }
  if (request.controllerId.trim() === "" || request.currentBaseSha.trim() === "") {
    throw new Error("Reconciliation controller and base identities must be non-empty");
  }
  if (!Number.isInteger(request.leaseDurationMs) || request.leaseDurationMs < 1) {
    throw new Error("Reconciliation leaseDurationMs must be a positive integer");
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
