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
    const provider = this.#providers.get(request.contract.tasks.provider);
    const dependencyResolver = this.#dependencies.get(request.contract.tasks.dependencies);
    const tasks = await provider.listTasks(request.project, request.contract);
    const graph = analyzeTaskGraph(
      await dependencyResolver.resolve(tasks, request.project, request.contract),
    );
    const claimed: ClaimedTask[] = [];
    const duplicateTaskIds: string[] = [];
    let capacityReached = false;

    for (const task of graph.ready) {
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
    };
  }
}

function validateRequest(request: PlanProjectRequest): void {
  if (!request.project.enabled) {
    throw new Error(`Project ${request.project.id} is disabled`);
  }
  if (request.project.id !== request.contract.project.id) {
    throw new Error(
      `Registration id ${request.project.id} does not match contract id ${request.contract.project.id}`,
    );
  }
  if (request.project.contractVersion !== request.contract.version) {
    throw new Error(
      `Registered contract version ${request.project.contractVersion} does not match ${request.contract.version}`,
    );
  }
  if (request.baseSha.trim() === "" || request.controllerId.trim() === "") {
    throw new Error("baseSha and controllerId must be non-empty");
  }
  if (!Number.isInteger(request.leaseDurationMs) || request.leaseDurationMs < 1) {
    throw new Error("leaseDurationMs must be a positive integer");
  }
}
