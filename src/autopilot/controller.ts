import type { RunStore } from "../core/store.js";
import type { ProjectRegistryStore } from "../projects/registry.js";
import type {
  RunOnceController,
  RunOnceRequest,
  RunOnceResult,
} from "../runtime/run-once.js";

export type AutopilotStopReason =
  | "completed"
  | "deadline"
  | "max-new-claims"
  | "no-progress"
  | "human-gate"
  | "worker-unavailable"
  | "quota-unavailable"
  | "run-failure"
  | "failure-budget"
  | "ci-wait-timeout"
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
  /** Distinct task revisions quarantined before the whole execution stops. Defaults to three. */
  maxTaskFailures?: number;
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
  executionId: string;
  resumedAfterInterruption: boolean;
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
    ciWaitTimeouts: Array<{
      projectId: string;
      taskId: string;
      runId: string;
      pullRequestUrl: string | null;
      detail: string | null;
    }>;
    quarantined: Array<{
      projectId: string;
      taskId: string;
      revision: string;
      runId: string;
      reason: string;
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
    const invocationStartedAt = this.#now();
    const executionState = this.#runs.startOrResumeAutopilot(invocationStartedAt);
    const executionId = executionState.execution.id;
    const startedAt = executionState.execution.startedAt;
    const maxTaskFailures = request.maxTaskFailures ?? 3;
    const enabledProjects = this.#projects.list().filter((project) => project.enabled);
    const passes: AutopilotPass[] = [];
    const latest = new Map<string, RunOnceResult>();
    let totalNewClaims = 0;
    let noProgressPasses = 0;
    let stopReason: AutopilotStopReason | null = enabledProjects.length === 0
      ? "no-enabled-projects"
      : this.#runs.autopilotQuarantines(executionId).length >= maxTaskFailures
        ? "failure-budget"
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
      let materialProgress = false;
      for (const project of enabledProjects) {
        const remainingClaims = Math.max(0, request.maxNewClaims - totalNewClaims);
        const runRequest: RunOnceRequest = {
          projectId: project.id,
          controllerId: request.controllerId,
          leaseDurationMs: request.leaseDurationMs,
          maxClaims: Math.min(request.globalConcurrency, remainingClaims),
          dryRun: false,
          targetTaskId: null,
        };
        let result: RunOnceResult;
        try {
          result = await this.#runner.run(runRequest);
        } catch (error) {
          stopReason = stopForThrownError(error);
          break;
        }
        latest.set(project.id, result);
        projectResults.push(result);
        passClaims += result.claimed.length;
        totalNewClaims += result.claimed.length;
        const changed = madeMaterialProgress(result);
        materialProgress ||= changed;
        progress ||= changed || waitingOnRequiredCi(result);
        recordQuarantines(result, this.#runs, executionId, this.#now());

        const stop = globalStopFor(result, this.#runs);
        if (stop) {
          stopReason = stop;
          break;
        }
        if (this.#runs.autopilotQuarantines(executionId).length >= maxTaskFailures) {
          stopReason = "failure-budget";
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
      const inFlight = enabledProjects.some((project) => this.#runs.listProject(project.id).some((run) =>
        !["completed", "failed", "waiting-human"].includes(run.state)
      ));
      if (
        projectResults.length === enabledProjects.length &&
        projectResults.every((result) => hasNoRemainingWork(result)) &&
        !inFlight
      ) {
        stopReason = "completed";
        break;
      }
      if (
        totalNewClaims >= request.maxNewClaims &&
        !inFlight
      ) {
        stopReason = "max-new-claims";
        break;
      }
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
      if (!materialProgress) {
        await this.#sleep(Math.min(request.pollIntervalMs, remainingMs));
      }
    }

    const finishedAt = this.#now();
    const finalStopReason = stopReason ?? "deadline";
    const result: AutopilotResult = {
      executionId,
      resumedAfterInterruption: executionState.resumed,
      startedAt,
      finishedAt,
      stopReason: finalStopReason,
      passes,
      totalNewClaims,
      noProgressPasses,
      report: this.#report(latest, executionId),
    };
    this.#runs.finishAutopilot(executionId, finishedAt, finalStopReason);
    return result;
  }

  #report(latest: Map<string, RunOnceResult>, executionId: string): AutopilotResult["report"] {
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
        ...remainingWork(result),
      })),
      ciWaitTimeouts: uniqueCiWaitTimeouts([...latest.entries()].flatMap(([projectId, result]) =>
        [...result.claimed, ...result.reconciled]
          .filter((item) => item.ciWaitExpired)
          .map((item) => ({
            projectId,
            taskId: item.taskId,
            runId: item.runId,
            pullRequestUrl: item.pullRequestUrl,
            detail: item.ciWaitDetail,
          }))
      )),
      quarantined: this.#runs.autopilotQuarantines(executionId).map((entry) => ({
        projectId: entry.projectId,
        taskId: entry.taskId,
        revision: entry.revision,
        runId: entry.runId,
        reason: entry.reason,
      })),
    };
  }
}

function hasNoRemainingWork(result: RunOnceResult): boolean {
  const remaining = remainingWork(result);
  return remaining.ready.length === 0 && remaining.waiting.length === 0 && remaining.blocked.length === 0;
}

function remainingWork(result: RunOnceResult): {
  ready: string[];
  waiting: string[];
  blocked: string[];
} {
  const completedDuringPass = new Set(
    [...result.claimed, ...result.reconciled]
      .filter((item) => item.state === "completed" || item.delivery === "completed")
      .map((item) => item.taskId),
  );
  return {
    ready: result.ready.map((task) => task.id).filter((taskId) => !completedDuringPass.has(taskId)),
    waiting: result.waiting.filter((taskId) => !completedDuringPass.has(taskId)),
    blocked: result.blocked.filter((taskId) => !completedDuringPass.has(taskId)),
  };
}

function madeMaterialProgress(result: RunOnceResult): boolean {
  return result.claimed.length > 0 ||
    result.reconciliation.some((item) =>
      item.initialState !== item.state ||
      item.base === "advanced" ||
      item.execution !== "not-run");
}

function waitingOnRequiredCi(result: RunOnceResult): boolean {
  return [...result.claimed, ...result.reconciled].some((item) =>
    item.delivery === "waiting-ci" && !item.ciWaitExpired) ||
    result.reconciliation.some((item) =>
      item.outcome === "waiting-ci" && !item.ciWaitExpired);
}

function globalStopFor(result: RunOnceResult, runs: RunStore): AutopilotStopReason | null {
  if (!result.ok) {
    const tasks = [...result.claimed, ...result.reconciled];
    const failed = tasks.find((item) => item.failureReason);
    if (failed?.failureReason === "worker-profile-unavailable") return "worker-unavailable";
    if (failed) {
      const summary = runs.execution(failed.runId)?.workerSummary ?? "";
      if (/quota|rate limit|usage limit|capacity/i.test(summary)) return "quota-unavailable";
    }
  }
  return null;
}

function recordQuarantines(
  result: RunOnceResult,
  runs: RunStore,
  executionId: string,
  now: number,
): void {
  const items = [...result.claimed, ...result.reconciled];
  for (const item of items) {
    const reason = item.ciWaitExpired
      ? "ci-wait-timeout"
      : item.state === "failed" || item.delivery === "failed" || item.execution === "failed"
        ? item.failureReason ?? "task-run-failed"
        : null;
    if (reason && runs.get(item.runId)) {
      runs.recordAutopilotQuarantine(executionId, item.runId, reason, now);
    }
  }
}

function stopForThrownError(error: unknown): AutopilotStopReason {
  const message = error instanceof Error ? error.message : String(error);
  if (/worker profile|worker-profile-unavailable/i.test(message)) return "worker-unavailable";
  if (/quota|rate limit|usage limit|capacity/i.test(message)) return "quota-unavailable";
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
  if (
    request.maxTaskFailures !== undefined &&
    (!Number.isInteger(request.maxTaskFailures) || request.maxTaskFailures < 1)
  ) {
    throw new Error("maxTaskFailures must be a positive integer");
  }
}

function roundUsage(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function uniqueCiWaitTimeouts(
  entries: AutopilotResult["report"]["ciWaitTimeouts"],
): AutopilotResult["report"]["ciWaitTimeouts"] {
  const byRun = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    if (!byRun.has(entry.runId)) byRun.set(entry.runId, entry);
  }
  return [...byRun.values()];
}
