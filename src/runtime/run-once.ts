import type { RunStore } from "../core/store.js";
import { DeliveryCoordinator, type DeliveryResult } from "../delivery/coordinator.js";
import type { PullRequestPublisherRegistry } from "../delivery/registry.js";
import type { CommandRunner } from "../execution/command-runner.js";
import { TaskExecutor, type TaskExecutionResult } from "../execution/task-executor.js";
import type { ProjectPlanner } from "../planning/project-planner.js";
import { loadProjectContract } from "../project-contract.js";
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
  duplicateTaskIds: string[];
  capacityReached: boolean;
  limitReached: boolean;
}

export interface RunOnceControllerOptions {
  now?: () => number;
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
    const baseSha = request.dryRun
      ? await this.#baseRevisions.inspect(project.rootPath, contract.project.baseBranch)
      : await this.#baseRevisions.refresh(project.rootPath, contract.project.baseBranch);
    if (request.dryRun) {
      const inspected = await this.#planner.inspect(project, contract);
      assertTargetReady(request.targetTaskId, inspected.graph.ready.map((task) => task.id));
      return {
        ok: true,
        dryRun: true,
        targetTaskId: request.targetTaskId,
        project: project.id,
        baseSha,
        workerProfile: project.workerProfile,
        provider: inspected.provider,
        dependencies: inspected.dependencies,
        deliveryProvider: publisher?.name ?? null,
        ...graphFields(inspected.graph),
        claimed: [],
        reconciled: [],
        duplicateTaskIds: [],
        capacityReached: false,
        limitReached: (request.targetTaskId ? 1 : inspected.graph.ready.length) > request.maxClaims,
      };
    }

    const plan = await this.#planner.claimReady({
      project,
      contract,
      baseSha,
      controllerId: request.controllerId,
      now: this.#now(),
      leaseDurationMs: request.leaseDurationMs,
      maxClaims: request.maxClaims,
      ...(request.targetTaskId ? { taskIds: [request.targetTaskId] } : {}),
    });
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
        failureReason: finalRun.failureReason,
      } satisfies RunOnceTaskResult;
    }));
    const tasksById = new Map(
      [
        ...plan.graph.ready,
        ...plan.graph.waiting,
        ...plan.graph.blocked,
        ...plan.graph.completed,
      ].map((task) => [task.id, task]),
    );
    const reconciled: RunOnceTaskResult[] = publisher
      ? await Promise.all(plan.duplicateTaskIds.map(async (taskId): Promise<RunOnceTaskResult | null> => {
          const task = tasksById.get(taskId);
          if (!task) {
            throw new Error(`Duplicate task disappeared from graph: ${taskId}`);
          }
          const run = this.#runs.findTask(project.id, task.id, task.revision);
          if (!run || !["verified", "pr-open", "ci"].includes(run.state)) {
            return null;
          }
          const coordinator = new DeliveryCoordinator(
            this.#runs,
            this.#repository,
            publisher,
            { now: this.#now, baseRevisions: this.#baseRevisions },
          );
          const delivery = await coordinator.deliver({ runId: run.id, task, project, contract });
          const finalRun = this.#runs.get(run.id) ?? run;
          const execution = this.#runs.execution(run.id);
          const persistedDelivery = this.#runs.delivery(run.id);
          return {
            taskId: task.id,
            runId: run.id,
            state: finalRun.state,
            execution: "not-run",
            worker: execution?.workerName
              ? {
                  name: execution.workerName,
                  model: execution.workerModel,
                  status: execution.workerStatus ?? "unknown",
                }
              : null,
            workspacePath: execution?.workspacePath ?? null,
            delivery: delivery.outcome,
            pullRequestUrl: persistedDelivery?.url ?? null,
            ciStatus: persistedDelivery?.ciStatus ?? null,
            failureReason: finalRun.failureReason,
          };
        })).then((results) => results.filter(isPresent))
      : [];
    const taskSucceeded = (task: RunOnceTaskResult): boolean =>
      task.failureReason === null &&
      task.execution !== "failed" &&
      task.execution !== "lease-lost" &&
      task.delivery !== "failed" &&
      task.delivery !== "retryable-failure";
    const ok = claimed.every(taskSucceeded) && reconciled.every(taskSucceeded);
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
      duplicateTaskIds: plan.duplicateTaskIds,
      capacityReached: plan.capacityReached,
      limitReached: plan.limitReached,
    };
  }
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
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
  if (!Number.isInteger(request.maxClaims) || request.maxClaims < 1) {
    throw new Error("maxClaims must be a positive integer");
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
