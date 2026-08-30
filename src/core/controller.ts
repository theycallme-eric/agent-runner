import type { ProjectContract } from "../project-contract.js";
import { protectedPathGate } from "./policy.js";
import type { RunStore } from "./store.js";
import type { CiResult, RunRecord, VerificationResult, WorkerResult } from "./types.js";

export interface ControllerServices {
  verify(run: RunRecord): VerificationResult;
  checkCi(run: RunRecord): CiResult;
}

export interface FinishOptions {
  runId: string;
  workerResult: WorkerResult;
  currentBaseSha: string;
  now: number;
}

export class SimulatorController {
  readonly #store: RunStore;
  readonly #contract: ProjectContract;
  readonly #services: ControllerServices;

  constructor(store: RunStore, contract: ProjectContract, services: ControllerServices) {
    this.#store = store;
    this.#contract = contract;
    this.#services = services;
  }

  prepare(runId: string, now: number): RunRecord {
    this.#store.transition(runId, "workspace-ready", now);
    return this.#store.transition(runId, "running", now + 1);
  }

  finish(options: FinishOptions): RunRecord {
    const running = requireRun(this.#store, options.runId);
    if (running.state !== "running") {
      throw new Error(`Worker result requires a running run, received ${running.state}`);
    }
    if (!options.workerResult.reportedSuccess || options.workerResult.headSha === null) {
      return this.#store.transition(options.runId, "failed", options.now, {
        failureReason: "worker-failed",
      });
    }

    let run = this.#store.transition(options.runId, "verifying", options.now, {
      headSha: options.workerResult.headSha,
    });
    let verification = this.#services.verify(run);
    if (!verification.passed) {
      return this.#store.transition(options.runId, "failed", options.now + 1, {
        failureReason: "verification-failed",
      });
    }

    if (options.currentBaseSha !== run.baseSha) {
      run = this.#store.transition(options.runId, "synchronized", options.now + 1, {
        baseSha: options.currentBaseSha,
        requiresReverification: true,
      });
      run = this.#store.transition(options.runId, "verifying", options.now + 2);
      verification = this.#services.verify(run);
      if (!verification.passed) {
        return this.#store.transition(options.runId, "failed", options.now + 3, {
          failureReason: "post-sync-verification-failed",
        });
      }
      run = this.#store.transition(options.runId, "pr-open", options.now + 3, {
        requiresReverification: false,
      });
    } else {
      run = this.#store.transition(options.runId, "pr-open", options.now + 1);
    }

    const gate = protectedPathGate(
      options.workerResult.changedPaths,
      this.#contract.verification.protectedPaths,
    );
    if (gate.required) {
      return this.#store.transition(options.runId, "waiting-human", options.now + 4);
    }

    run = this.#store.transition(options.runId, "ci", options.now + 4);
    const ci = this.#services.checkCi(run);
    if (!ci.passed) {
      return this.#store.transition(options.runId, "failed", options.now + 5, {
        failureReason: "ci-failed",
      });
    }
    return this.#store.transition(options.runId, "completed", options.now + 5);
  }
}

function requireRun(store: RunStore, runId: string): RunRecord {
  const run = store.get(runId);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }
  return run;
}
