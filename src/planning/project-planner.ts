import type { ProjectContract } from "../project-contract.js";
import type { ProjectRegistration } from "../projects/types.js";
import type { RunStore } from "../core/store.js";
import type { RunRecord } from "../core/types.js";
import { analyzeTaskGraph } from "../tasks/graph.js";
import type { TaskGraphSnapshot, TaskNode } from "../tasks/types.js";
import type { TaskProviderRegistry } from "../tasks/provider-registry.js";
import type { DependencyResolverRegistry } from "../tasks/dependency-registry.js";

export interface PlanProjectRequest {
  project: ProjectRegistration;
  contract: ProjectContract;
  baseSha: string;
  controllerId: string;
  now: number;
  leaseDurationMs: number;
  maxClaims?: number;
}

export interface ClaimedTask {
  task: TaskNode;
  run: RunRecord;
  workerProfile: string;
}

export interface ProjectPlan {
  projectId: string;
  provider: string;
  dependencies: string;
  graph: TaskGraphSnapshot;
  claimed: ClaimedTask[];
  duplicateTaskIds: string[];
  capacityReached: boolean;
  limitReached: boolean;
}

export class ProjectPlanner {
  readonly #runs: RunStore;
  readonly #providers: TaskProviderRegistry;
  readonly #dependencies: DependencyResolverRegistry;

  constructor(
    runs: RunStore,
    providers: TaskProviderRegistry,
    dependencies: DependencyResolverRegistry,
  ) {
    this.#runs = runs;
    this.#providers = providers;
    this.#dependencies = dependencies;
  }

  async claimReady(request: PlanProjectRequest): Promise<ProjectPlan> {
    validateRequest(request);
    const inspected = await this.inspect(request.project, request.contract);
    const provider = this.#providers.get(request.contract.tasks.provider);
    const dependencyResolver = this.#dependencies.get(request.contract.tasks.dependencies);
    const graph = inspected.graph;
    const maxClaims = request.maxClaims ?? Number.POSITIVE_INFINITY;
    const claimed: ClaimedTask[] = [];
    const duplicateTaskIds: string[] = [];
    let capacityReached = false;
    let limitReached = false;

    for (const task of graph.ready) {
      if (claimed.length >= maxClaims) {
        limitReached = true;
        break;
      }
      const result = this.#runs.claimWithinCapacity(
        {
          projectId: request.project.id,
          taskId: task.id,
          revision: task.revision,
          baseSha: request.baseSha,
          workerId: request.controllerId,
          now: request.now,
          leaseDurationMs: request.leaseDurationMs,
          maxAttempts: request.contract.execution.attempts,
        },
        request.contract.execution.concurrency,
      );
      if (result.outcome === "capacity") {
        capacityReached = true;
        break;
      }
      if (result.outcome === "duplicate") {
        duplicateTaskIds.push(task.id);
        continue;
      }
      claimed.push({ task, run: result.run, workerProfile: request.project.workerProfile });
    }

    return {
      projectId: request.project.id,
      provider: provider.name,
      dependencies: dependencyResolver.name,
      graph,
      claimed,
      duplicateTaskIds,
      capacityReached,
      limitReached,
    };
  }

  async inspect(
    project: ProjectRegistration,
    contract: ProjectContract,
  ): Promise<Pick<ProjectPlan, "projectId" | "provider" | "dependencies" | "graph">> {
    validateProject(project, contract);
    const provider = this.#providers.get(contract.tasks.provider);
    const dependencyResolver = this.#dependencies.get(contract.tasks.dependencies);
    const tasks = await provider.listTasks(project, contract);
    const graph = analyzeTaskGraph(
      await dependencyResolver.resolve(tasks, project, contract),
    );
    return {
      projectId: project.id,
      provider: provider.name,
      dependencies: dependencyResolver.name,
      graph,
    };
  }
}

function validateRequest(request: PlanProjectRequest): void {
  validateProject(request.project, request.contract);
  if (request.baseSha.trim() === "" || request.controllerId.trim() === "") {
    throw new Error("baseSha and controllerId must be non-empty");
  }
  if (!Number.isInteger(request.leaseDurationMs) || request.leaseDurationMs < 1) {
    throw new Error("leaseDurationMs must be a positive integer");
  }
  if (request.maxClaims !== undefined && (!Number.isInteger(request.maxClaims) || request.maxClaims < 1)) {
    throw new Error("maxClaims must be a positive integer");
  }
}

function validateProject(project: ProjectRegistration, contract: ProjectContract): void {
  if (!project.enabled) {
    throw new Error(`Project ${project.id} is disabled`);
  }
  if (project.id !== contract.project.id) {
    throw new Error(
      `Registration id ${project.id} does not match contract id ${contract.project.id}`,
    );
  }
  if (project.contractVersion !== contract.version) {
    throw new Error(
      `Registered contract version ${project.contractVersion} does not match ${contract.version}`,
    );
  }
}
