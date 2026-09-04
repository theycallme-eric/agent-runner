import type { RunStore } from "../core/store.js";
import {
  DEFAULT_MAX_CI_WAIT_MINUTES,
  DeliveryCoordinator,
  type DeliveryResult,
} from "../delivery/coordinator.js";
import type { PullRequestPublisherRegistry } from "../delivery/registry.js";
import type { CommandRunner } from "../execution/command-runner.js";
import { TaskExecutor, type TaskExecutionResult } from "../execution/task-executor.js";
import type { ProjectInspection, ProjectPlanner } from "../planning/project-planner.js";
import {
  ReconciliationController,
  type ReconciliationResult,
} from "../reconciliation/controller.js";
import { loadProjectContract, type ProjectContract } from "../project-contract.js";
import type { ProjectRegistryStore } from "../projects/registry.js";
import type { WorkerProfileRegistry } from "../workers/registry.js";
import type { BaseRevisionProvider } from "../workspaces/base-revision.js";
import type { WorkspaceRepository } from "../workspaces/git-repository.js";
import type { WorkspaceManager } from "../workspaces/types.js";

export interface RunOnceRequest {
  projectId: string;
  controllerId: string;
  leaseDurationMs: number;
  maxClaims: number;
  dryRun: boolean;
  targetTaskId: string | null;
}

export interface RunOnceTaskResult {
  taskId: string;
  runId: string;
  state: string;
  execution: TaskExecutionResult["outcome"] | "not-run";
  worker: { name: string; model: string | null; status: string } | null;
  workspacePath: string | null;
  delivery: DeliveryResult["outcome"] | "not-requested" | null;
  pullRequestUrl: string | null;
  ciStatus: string | null;
  ciWaitExpired: boolean;
  ciWaitDetail: string | null;
  failureReason: string | null;
}

export interface RunOnceResult {
  ok: boolean;
  dryRun: boolean;
  targetTaskId: string | null;
  project: string;
  baseSha: string;
  workerProfile: string;
  provider: string;
  dependencies: string;
  deliveryProvider: string | null;
  ready: Array<{ id: string; title: string }>;
  waiting: string[];
  blocked: string[];
  completed: string[];
  claimed: RunOnceTaskResult[];
  reconciled: RunOnceTaskResult[];
  reconciliation: ReconciliationResult[];
  duplicateTaskIds: string[];
  capacityReached: boolean;
  limitReached: boolean;
  prerequisiteBlocks: Array<{ taskId: string; prerequisiteIds: string[] }>;
}

export interface RunOnceControllerOptions {
  now?: () => number;
  maxCiWaitMinutes?: number;
}

export class RunOnceController {
  readonly #projects: ProjectRegistryStore;
  readonly #runs: RunStore;
  readonly #planner: ProjectPlanner;
  readonly #workers: WorkerProfileRegistry;
  readonly #workspaces: WorkspaceManager;
  readonly #repository: WorkspaceRepository;
  readonly #baseRevisions: BaseRevisionProvider;
  readonly #publishers: PullRequestPublisherRegistry;
  readonly #commands: CommandRunner;
  readonly #now: () => number;
  readonly #maxCiWaitMinutes: number;

  constructor(
    projects: ProjectRegistryStore,
    runs: RunStore,
    planner: ProjectPlanner,
    workers: WorkerProfileRegistry,
    workspaces: WorkspaceManager,
    repository: WorkspaceRepository,
    baseRevisions: BaseRevisionProvider,
    publishers: PullRequestPublisherRegistry,
    commands: CommandRunner,
    options: RunOnceControllerOptions = {},
  ) {
    this.#projects = projects;
    this.#runs = runs;
    this.#planner = planner;
    this.#workers = workers;
    this.#workspaces = workspaces;
    this.#repository = repository;
    this.#baseRevisions = baseRevisions;
    this.#publishers = publishers;
    this.#commands = commands;
    this.#now = options.now ?? Date.now;
    this.#maxCiWaitMinutes = options.maxCiWaitMinutes ?? DEFAULT_MAX_CI_WAIT_MINUTES;
  }

  async run(request: RunOnceRequest): Promise<RunOnceResult> {
    validateRequest(request);
    const project = this.#projects.get(request.projectId);
    if (!project) {
      throw new Error(`Unknown project: ${request.projectId}`);
    }
    if (!project.enabled) {
      throw new Error(`Project ${request.projectId} is disabled`);
    }
    const contract = await loadProjectContract(project.contractPath);
    this.#workers.get(project.workerProfile);
    const publisher = contract.delivery.pullRequest
      ? this.#publishers.get(contract.delivery.provider)
      : null;
    if (contract.delivery.merge === "after-required-checks") {
      assertAutomaticWorkflowProtected(contract);
      if (
        !publisher?.validateAutomaticMerge ||
        !publisher.observeRequiredChecks ||
        !publisher.mergeVerified
      ) {
        throw new Error(
          `Delivery provider ${contract.delivery.provider} does not support automatic merging`,
        );
      }
      await publisher.validateAutomaticMerge(project.id, contract.project.baseBranch);
    }
    let baseSha = request.dryRun
      ? await this.#baseRevisions.inspect(project.rootPath, contract.project.baseBranch)
      : await this.#baseRevisions.refresh(project.rootPath, contract.project.baseBranch);
    if (request.dryRun) {
      const inspected = await this.#planner.inspect(project, contract);
      const gated = await gateExecutionPrerequisites(
        inspected,
        project.rootPath,
        contract.execution.timeoutMinutes * 60_000,
        this.#commands,
      );
      assertTargetReady(request.targetTaskId, gated.inspection.graph.ready.map((task) => task.id));
      return {
        ok: true,
        dryRun: true,
        targetTaskId: request.targetTaskId,
        project: project.id,
        baseSha,
        workerProfile: project.workerProfile,
        provider: gated.inspection.provider,
        dependencies: gated.inspection.dependencies,
        deliveryProvider: publisher?.name ?? null,
        ...graphFields(gated.inspection.graph),
        claimed: [],
        reconciled: [],
        reconciliation: [],
        duplicateTaskIds: [],
        capacityReached: false,
        limitReached: (request.targetTaskId ? 1 : gated.inspection.graph.ready.length) > request.maxClaims,
        prerequisiteBlocks: gated.blocks,
      };
    }

    const inspected = await this.#planner.inspect(project, contract);
    const gated = await gateExecutionPrerequisites(
      inspected,
      project.rootPath,
      contract.execution.timeoutMinutes * 60_000,
      this.#commands,
    );
    assertTargetReady(request.targetTaskId, gated.inspection.graph.ready.map((task) => task.id));
    const reconciliation = await new ReconciliationController(
      this.#runs,
      this.#workspaces,
      this.#repository,
      this.#workers,
      this.#commands,
      this.#baseRevisions,
      publisher,
      { now: this.#now, maxCiWaitMinutes: this.#maxCiWaitMinutes },
    ).reconcileProject({
      project,
      contract,
      inspection: gated.inspection,
      currentBaseSha: baseSha,
      controllerId: request.controllerId,
      leaseDurationMs: request.leaseDurationMs,
    });
    baseSha = await this.#baseRevisions.refresh(
      project.rootPath,
      contract.project.baseBranch,
    );
    const plan = this.#planner.claimInspected({
      project,
      contract,
      baseSha,
      controllerId: request.controllerId,
      now: this.#now(),
      leaseDurationMs: request.leaseDurationMs,
      maxClaims: request.maxClaims,
      ...(request.targetTaskId ? { taskIds: [request.targetTaskId] } : {}),
    }, gated.inspection);
    const executor = new TaskExecutor(
      this.#runs,
      this.#workspaces,
      this.#repository,
      this.#workers,
      this.#commands,
      { now: this.#now, baseRevisions: this.#baseRevisions },
    );
    const claimed = await Promise.all(plan.claimed.map(async (claim) => {
      const execution = await executor.execute({
        claimed: claim,
        project,
        contract,
        controllerId: request.controllerId,
        leaseDurationMs: request.leaseDurationMs,
      });
      let delivery: DeliveryResult | null = null;
      if (execution.outcome === "verified" && publisher) {
        const coordinator = new DeliveryCoordinator(
          this.#runs,
          this.#repository,
          publisher,
          { now: this.#now, baseRevisions: this.#baseRevisions },
        );
        delivery = await coordinator.deliver({
          runId: execution.run.id,
          task: claim.task,
          project,
          contract,
          maxCiWaitMinutes: this.#maxCiWaitMinutes,
        });
      }
      const finalRun = this.#runs.get(execution.run.id) ?? execution.run;
      const persistedDelivery = this.#runs.delivery(finalRun.id);
      return {
        taskId: claim.task.id,
        runId: finalRun.id,
        state: finalRun.state,
        execution: execution.outcome,
        worker: execution.worker
          ? {
              name: execution.worker.worker,
              model: execution.worker.model,
              status: execution.worker.status,
            }
          : null,
        workspacePath: execution.workspace?.path ?? null,
        delivery: delivery?.outcome ?? (contract.delivery.pullRequest ? null : "not-requested"),
        pullRequestUrl: persistedDelivery?.url ?? null,
        ciStatus: persistedDelivery?.ciStatus ?? null,
        ciWaitExpired: delivery?.ciWaitExpired ?? false,
        ciWaitDetail: delivery?.ciWaitExpired ? delivery.message : null,
        failureReason: finalRun.failureReason,
      } satisfies RunOnceTaskResult;
    }));
    const reconciled = reconciliation.map((item): RunOnceTaskResult => {
      const execution = this.#runs.execution(item.runId);
      return {
        taskId: item.taskId,
        runId: item.runId,
        state: item.state,
        execution: item.execution,
        worker: execution?.workerName
          ? {
              name: execution.workerName,
              model: execution.workerModel,
              status: execution.workerStatus ?? "unknown",
            }
          : null,
        workspacePath: execution?.workspacePath ?? null,
        delivery: reconciliationDelivery(item.outcome),
        pullRequestUrl: item.pullRequestUrl,
        ciStatus: item.ciStatus,
        ciWaitExpired: item.ciWaitExpired,
        ciWaitDetail: item.ciWaitDetail,
        failureReason: item.failureReason,
      };
    });
    const taskSucceeded = (task: RunOnceTaskResult): boolean =>
      task.failureReason === null &&
      task.execution !== "failed" &&
      task.execution !== "lease-lost" &&
      task.delivery !== "failed" &&
      task.delivery !== "retryable-failure";
    const reconciliationSucceeded = reconciliation.every(
      (item) => !["failed", "retryable-failure"].includes(item.outcome),
    );
    const ok = claimed.every(taskSucceeded) && reconciled.every(taskSucceeded) && reconciliationSucceeded;
    return {
      ok,
      dryRun: false,
      targetTaskId: request.targetTaskId,
      project: project.id,
      baseSha,
      workerProfile: project.workerProfile,
      provider: plan.provider,
      dependencies: plan.dependencies,
      deliveryProvider: publisher?.name ?? null,
      ...graphFields(plan.graph),
      claimed,
      reconciled,
      reconciliation,
      duplicateTaskIds: plan.duplicateTaskIds,
      capacityReached: plan.capacityReached,
      limitReached: plan.limitReached,
      prerequisiteBlocks: gated.blocks,
    };
  }
}

function assertAutomaticWorkflowProtected(contract: ProjectContract): void {
  const protectedWorkflowDirectory = contract.verification.protectedPaths.some(
    (rule) => rule.pattern === ".github/workflows/**" && rule.gate === "human",
  );
  if (!protectedWorkflowDirectory) {
    throw new Error(
      "Automatic merge requires verification.protectedPaths to gate .github/workflows/** for human review",
    );
  }
}

async function gateExecutionPrerequisites(
  inspection: ProjectInspection,
  repositoryPath: string,
  timeoutMs: number,
  commands: CommandRunner,
): Promise<{
  inspection: ProjectInspection;
  blocks: Array<{ taskId: string; prerequisiteIds: string[] }>;
}> {
  const outcomes = new Map<string, Promise<boolean>>();
  const blocks: Array<{ taskId: string; prerequisiteIds: string[] }> = [];
  for (const task of inspection.graph.ready) {
    const failed: string[] = [];
    for (const prerequisite of task.executionPrerequisites ?? []) {
      let outcome = outcomes.get(prerequisite.verificationCommand);
      if (!outcome) {
        outcome = commands.run({
          command: prerequisite.verificationCommand,
          cwd: repositoryPath,
          timeoutMs,
        }).then((result) => result.passed, () => false);
        outcomes.set(prerequisite.verificationCommand, outcome);
      }
      if (!await outcome) failed.push(prerequisite.id);
    }
    if (failed.length > 0) {
      blocks.push({ taskId: task.id, prerequisiteIds: failed.sort() });
    }
  }
  if (blocks.length === 0) return { inspection, blocks };
  const blockedIds = new Set(blocks.map((block) => block.taskId));
  const newlyBlocked = inspection.graph.ready.filter((task) => blockedIds.has(task.id));
  const blocked = [...inspection.graph.blocked, ...newlyBlocked]
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    inspection: {
      ...inspection,
      graph: {
        ...inspection.graph,
        ready: inspection.graph.ready.filter((task) => !blockedIds.has(task.id)),
        blocked,
      },
    },
    blocks,
  };
}

function reconciliationDelivery(
  outcome: ReconciliationResult["outcome"],
): DeliveryResult["outcome"] | null {
  return ["waiting-ci", "completed", "failed", "waiting-human", "retryable-failure"].includes(outcome)
    ? outcome as DeliveryResult["outcome"]
    : null;
}

function graphFields(graph: {
  ready: Array<{ id: string; title: string }>;
  waiting: Array<{ id: string }>;
  blocked: Array<{ id: string }>;
  completed: Array<{ id: string }>;
}): Pick<RunOnceResult, "ready" | "waiting" | "blocked" | "completed"> {
  return {
    ready: graph.ready.map((task) => ({ id: task.id, title: task.title })),
    waiting: graph.waiting.map((task) => task.id),
    blocked: graph.blocked.map((task) => task.id),
    completed: graph.completed.map((task) => task.id),
  };
}

function validateRequest(request: RunOnceRequest): void {
  if (request.projectId.trim() === "" || request.controllerId.trim() === "") {
    throw new Error("projectId and controllerId must be non-empty");
  }
  if (!Number.isInteger(request.leaseDurationMs) || request.leaseDurationMs < 1) {
    throw new Error("leaseDurationMs must be a positive integer");
  }
  if (!Number.isInteger(request.maxClaims) || request.maxClaims < 0) {
    throw new Error("maxClaims must be a non-negative integer");
  }
  if (request.targetTaskId !== null && request.targetTaskId.trim() === "") {
    throw new Error("targetTaskId must be null or non-empty");
  }
}

function assertTargetReady(targetTaskId: string | null, readyTaskIds: string[]): void {
  if (targetTaskId !== null && !readyTaskIds.includes(targetTaskId)) {
    throw new Error(`Requested task is not ready: ${targetTaskId}`);
  }
}
