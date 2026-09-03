import type { RunStore } from "../core/store.js";
import type { ProjectRegistryStore } from "../projects/registry.js";
import type {
  RunOnceController,
  RunOnceRequest,
  RunOnceResult,
} from "../runtime/run-once.js";

export type AutopilotStopReason =
  | "deadline"
  | "max-new-claims"
  | "no-progress"
  | "human-gate"
  | "worker-unavailable"
  | "quota-unavailable"
  | "run-failure"
  | "no-enabled-projects";

export interface AutopilotRequest {
  enabled: boolean;
  controllerId: string;
  leaseDurationMs: number;
  deadlineAt: number;
  maxNewClaims: number;
  maxNoProgressPasses: number;
  pollIntervalMs: number;
  globalConcurrency: number;
}

export interface AutopilotPass {
  number: number;
  startedAt: number;
  projects: RunOnceResult[];
  newClaims: number;
  progress: boolean;
}

export interface MorningReportRun {
  projectId: string;
  taskId: string;
  runId: string;
  state: string;
  attempt: number;
  worker: string | null;
  model: string | null;
  sessionId: string | null;
  costUsd: number | null;
  durationMs: number | null;
  pullRequestUrl: string | null;
  ciStatus: string | null;
  failureReason: string | null;
}

export interface AutopilotResult {
  startedAt: number;
  finishedAt: number;
  stopReason: AutopilotStopReason;
  passes: AutopilotPass[];
  totalNewClaims: number;
  noProgressPasses: number;
  report: {
    totals: {
      runs: number;
      completed: number;
      waitingHuman: number;
      failed: number;
      estimatedCostUsd: number;
    };
    runs: MorningReportRun[];
    remaining: Array<{
      projectId: string;
      ready: string[];
      waiting: string[];
      blocked: string[];
    }>;
  };
}

export interface AutopilotControllerOptions {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class AutopilotController {
  readonly #projects: ProjectRegistryStore;
  readonly #runs: RunStore;
  readonly #runner: Pick<RunOnceController, "run">;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(
    projects: ProjectRegistryStore,
    runs: RunStore,
    runner: Pick<RunOnceController, "run">,
    options: AutopilotControllerOptions = {},
  ) {
    this.#projects = projects;
    this.#runs = runs;
    this.#runner = runner;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }));
  }

  async run(request: AutopilotRequest): Promise<AutopilotResult> {
    validateRequest(request);
    if (!request.enabled) {
      throw new Error("Autopilot requires the explicit enable flag");
    }
    const startedAt = this.#now();
    const enabledProjects = this.#projects.list().filter((project) => project.enabled);
    const passes: AutopilotPass[] = [];
    const latest = new Map<string, RunOnceResult>();
    let totalNewClaims = 0;
    let noProgressPasses = 0;
    let stopReason: AutopilotStopReason | null = enabledProjects.length === 0
      ? "no-enabled-projects"
      : null;

    while (stopReason === null) {
      if (this.#now() >= request.deadlineAt) {
        stopReason = "deadline";
        break;
      }
      const passNumber = passes.length + 1;
      const projectResults: RunOnceResult[] = [];
      let passClaims = 0;
      let progress = false;
      for (const project of enabledProjects) {
        const remainingClaims = request.maxNewClaims - totalNewClaims;
        if (remainingClaims <= 0) {
          stopReason = "max-new-claims";
          break;
        }
        const runRequest: RunOnceRequest = {
          projectId: project.id,
          controllerId: `${request.controllerId}-p${passNumber}`,
          leaseDurationMs: request.leaseDurationMs,
          maxClaims: Math.min(request.globalConcurrency, remainingClaims),
          dryRun: false,
          targetTaskId: null,
        };
        const result = await this.#runner.run(runRequest);
        latest.set(project.id, result);
        projectResults.push(result);
        passClaims += result.claimed.length;
        totalNewClaims += result.claimed.length;
        progress ||= madeProgress(result);

        const stop = stopFor(result, this.#runs);
        if (stop) {
          stopReason = stop;
          break;
        }
        if (totalNewClaims >= request.maxNewClaims) {
          stopReason = "max-new-claims";
          break;
        }
      }
      passes.push({
        number: passNumber,
        startedAt: this.#now(),
        projects: projectResults,
        newClaims: passClaims,
        progress,
      });
      if (stopReason !== null) break;
      noProgressPasses = progress ? 0 : noProgressPasses + 1;
      if (noProgressPasses >= request.maxNoProgressPasses) {
        stopReason = "no-progress";
        break;
      }
      const remainingMs = request.deadlineAt - this.#now();
      if (remainingMs <= 0) {
        stopReason = "deadline";
        break;
      }
      await this.#sleep(Math.min(request.pollIntervalMs, remainingMs));
    }

    return {
      startedAt,
      finishedAt: this.#now(),
      stopReason: stopReason ?? "deadline",
      passes,
      totalNewClaims,
      noProgressPasses,
      report: this.#report(latest),
    };
  }

  #report(latest: Map<string, RunOnceResult>): AutopilotResult["report"] {
    const rows: MorningReportRun[] = [];
    for (const project of this.#projects.list().filter((entry) => entry.enabled)) {
      for (const run of this.#runs.listProject(project.id)) {
        const execution = this.#runs.execution(run.id);
        const delivery = this.#runs.delivery(run.id);
        rows.push({
          projectId: run.projectId,
          taskId: run.taskId,
          runId: run.id,
          state: run.state,
          attempt: run.attempt,
          worker: execution?.workerName ?? null,
          model: execution?.workerModel ?? null,
          sessionId: execution?.workerSessionId ?? null,
          costUsd: execution?.workerCostUsd ?? null,
          durationMs: execution?.workerDurationMs ?? null,
          pullRequestUrl: delivery?.url ?? null,
          ciStatus: delivery?.ciStatus ?? null,
          failureReason: run.failureReason,
        });
      }
    }
    return {
      totals: {
        runs: rows.length,
        completed: rows.filter((run) => run.state === "completed").length,
        waitingHuman: rows.filter((run) => run.state === "waiting-human").length,
        failed: rows.filter((run) => run.state === "failed").length,
        estimatedCostUsd: roundUsage(
          rows.reduce((total, run) => total + (run.costUsd ?? 0), 0),
        ),
      },
      runs: rows,
      remaining: [...latest.entries()].map(([projectId, result]) => ({
        projectId,
        ready: result.ready.map((task) => task.id),
        waiting: result.waiting,
        blocked: result.blocked,
      })),
    };
  }
}

function madeProgress(result: RunOnceResult): boolean {
  return result.claimed.length > 0 || result.reconciliation.some((item) =>
    item.initialState !== item.state ||
    item.base === "advanced" ||
    item.execution !== "not-run" ||
    ["completed", "failed", "waiting-human"].includes(item.outcome));
}

function stopFor(result: RunOnceResult, runs: RunStore): AutopilotStopReason | null {
  if (
    result.claimed.some((item) => item.state === "waiting-human") ||
    result.reconciliation.some((item) => item.outcome === "waiting-human")
  ) return "human-gate";
  if (result.ok) return null;
  const tasks = [...result.claimed, ...result.reconciled];
  const failed = tasks.find((item) => item.failureReason);
  if (failed?.failureReason === "worker-profile-unavailable") return "worker-unavailable";
  if (failed) {
    const summary = runs.execution(failed.runId)?.workerSummary ?? "";
    if (/quota|rate limit|usage limit|capacity/i.test(summary)) return "quota-unavailable";
  }
  const retryable = tasks.some((item) => item.delivery === "retryable-failure") ||
    result.reconciliation.some((item) => item.outcome === "retryable-failure");
  if (retryable) return null;
  return "run-failure";
}

function validateRequest(request: AutopilotRequest): void {
  for (const [name, value] of [
    ["leaseDurationMs", request.leaseDurationMs],
    ["deadlineAt", request.deadlineAt],
    ["maxNewClaims", request.maxNewClaims],
    ["maxNoProgressPasses", request.maxNoProgressPasses],
    ["pollIntervalMs", request.pollIntervalMs],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if (request.controllerId.trim() === "") {
    throw new Error("controllerId must be non-empty");
  }
  if (
    !Number.isInteger(request.globalConcurrency) ||
    request.globalConcurrency < 1 ||
    request.globalConcurrency > 16
  ) {
    throw new Error("globalConcurrency must be an integer from 1 to 16");
  }
}

function roundUsage(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
