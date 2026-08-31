import type { SimulatorController } from "../core/controller.js";
import type { RunStore } from "../core/store.js";
import type { ClaimRequest, RunRecord } from "../core/types.js";
import type { WorkerAdapter, WorkerOutcome, WorkerRequest } from "../workers/types.js";
import type { WorkspaceManager, WorkspaceRecord } from "../workspaces/types.js";

export interface FixtureRunRequest {
  claim: ClaimRequest;
  repositoryPath: string;
  baseRef: string;
  branchName: string;
  worker: Omit<WorkerRequest, "workspacePath">;
  changedPaths: string[];
  headSha: string;
  currentBaseSha: string;
}

export type FixtureRunResult =
  | { outcome: "duplicate"; run: RunRecord }
  | {
      outcome: "executed";
      run: RunRecord;
      workspace: WorkspaceRecord;
      worker: WorkerOutcome;
    };

export class FixtureRunner {
  readonly #store: RunStore;
  readonly #controller: SimulatorController;
  readonly #workspaces: WorkspaceManager;
  readonly #worker: WorkerAdapter;

  constructor(
    store: RunStore,
    controller: SimulatorController,
    workspaces: WorkspaceManager,
    worker: WorkerAdapter,
  ) {
    this.#store = store;
    this.#controller = controller;
    this.#workspaces = workspaces;
    this.#worker = worker;
  }

  async execute(request: FixtureRunRequest): Promise<FixtureRunResult> {
    const claim = this.#store.claim(request.claim);
    if (!claim.claimed) {
      return { outcome: "duplicate", run: claim.run };
    }

    let workspace: WorkspaceRecord;
    try {
      workspace = await this.#workspaces.create({
        repositoryPath: request.repositoryPath,
        runId: claim.run.id,
        baseRef: request.baseRef,
        branchName: request.branchName,
      });
    } catch {
      const failed = this.#store.transition(claim.run.id, "failed", request.claim.now + 1, {
        failureReason: "workspace-failed",
      });
      return {
        outcome: "executed",
        run: failed,
        workspace: { path: "", branchName: request.branchName, baseSha: request.claim.baseSha },
        worker: notStarted(this.#worker.name),
      };
    }

    const running = this.#controller.prepare(claim.run.id, request.claim.now + 1);
    let worker: WorkerOutcome;
    try {
      worker = await this.#worker.run({ ...request.worker, workspacePath: workspace.path });
    } catch (error) {
      worker = {
        status: "failed",
        worker: this.#worker.name,
        model: null,
        sessionId: null,
        summary: error instanceof Error ? error.message : String(error),
        costUsd: null,
        durationMs: 0,
      };
    }

    const run = this.#controller.finish({
      runId: running.id,
      workerResult: {
        reportedSuccess: worker.status === "succeeded",
        headSha: worker.status === "succeeded" ? request.headSha : null,
        changedPaths: request.changedPaths,
      },
      currentBaseSha: request.currentBaseSha,
      now: request.claim.now + 2,
    });
    return { outcome: "executed", run, workspace, worker };
  }
}

function notStarted(worker: string): WorkerOutcome {
  return {
    status: "failed",
    worker,
    model: null,
    sessionId: null,
    summary: "Worker was not started because workspace creation failed",
    costUsd: null,
    durationMs: 0,
  };
}
