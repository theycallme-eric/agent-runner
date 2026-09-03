import { protectedPathGate } from "../core/policy.js";
import type { RunStore } from "../core/store.js";
import type { DeliveryCiStatus, RunDeliveryRecord, RunRecord } from "../core/types.js";
import type { ProjectContract } from "../project-contract.js";
import type { ProjectRegistration } from "../projects/types.js";
import type { TaskNode } from "../tasks/types.js";
import type { WorkspaceRepository } from "../workspaces/git-repository.js";
import type { BaseRevisionProvider } from "../workspaces/base-revision.js";
import type {
  CiCheck,
  CiCheckBucket,
  DraftPullRequestRequest,
  PullRequestPublisher,
  PullRequestSnapshot,
} from "./types.js";

export const DEFAULT_MAX_CI_WAIT_MINUTES = 30;

export interface DeliverTaskRequest {
  runId: string;
  task: TaskNode;
  project: ProjectRegistration;
  contract: ProjectContract;
  maxCiWaitMinutes?: number;
}

export interface DeliveryResult {
  outcome: "waiting-ci" | "completed" | "failed" | "waiting-human" | "retryable-failure";
  run: RunRecord;
  delivery: RunDeliveryRecord | null;
  message: string | null;
  ciWaitExpired: boolean;
}

export interface DeliveryCoordinatorOptions {
  now?: () => number;
  baseRevisions?: BaseRevisionProvider;
}

export class DeliveryCoordinator {
  readonly #runs: RunStore;
  readonly #repository: WorkspaceRepository;
  readonly #publisher: PullRequestPublisher;
  readonly #now: () => number;
  readonly #baseRevisions: BaseRevisionProvider;

  constructor(
    runs: RunStore,
    repository: WorkspaceRepository,
    publisher: PullRequestPublisher,
    options: DeliveryCoordinatorOptions = {},
  ) {
    this.#runs = runs;
    this.#repository = repository;
    this.#publisher = publisher;
    this.#now = options.now ?? Date.now;
    this.#baseRevisions = options.baseRevisions ?? {
      inspect: (repositoryPath, baseBranch) => this.#repository.resolveRef(repositoryPath, baseBranch),
      refresh: (repositoryPath, baseBranch) => this.#repository.resolveRef(repositoryPath, baseBranch),
    };
  }

  async deliver(request: DeliverTaskRequest): Promise<DeliveryResult> {
    const initial = requireRun(this.#runs, request.runId);
    validateRequest(initial, request);
    let lastTimestamp = initial.updatedAt;
    const at = (): number => {
      lastTimestamp = Math.max(lastTimestamp + 1, this.#now());
      return lastTimestamp;
    };

    if (initial.state === "completed") {
      return {
        outcome: "completed",
        run: initial,
        delivery: requireDelivery(this.#runs, initial.id),
        message: null,
        ciWaitExpired: false,
      };
    }

    const execution = this.#runs.execution(initial.id);
    if (
      !execution?.workspacePath ||
      !execution.branchName ||
      !initial.headSha
    ) {
      return this.#terminalFailure(initial, "missing-verified-workspace", at());
    }
    const snapshot = await this.#repository.snapshot(execution.workspacePath, initial.baseSha);
    if (
      snapshot.dirty ||
      snapshot.headSha !== initial.headSha ||
      snapshot.changedPaths.length === 0
    ) {
      return this.#terminalFailure(
        initial,
        "verified-workspace-drifted",
        at(),
        { expectedHeadSha: initial.headSha, snapshot },
      );
    }

    const gate = protectedPathGate(
      snapshot.changedPaths,
      request.contract.verification.protectedPaths,
    );
    if (gate.required) {
      if (initial.state !== "verified") {
        return this.#terminalFailure(initial, "protected-path-gate-bypassed", at(), gate);
      }
      const run = this.#runs.transition(initial.id, "waiting-human", at());
      this.#runs.recordEvidence(run.id, "human-gate-required", gate, at());
      return {
        outcome: "waiting-human",
        run: this.#runs.get(run.id) ?? run,
        delivery: null,
        message: "Protected paths require human approval before publication",
        ciWaitExpired: false,
      };
    }

    const publishRequest = draftRequest(
      request,
      execution.workspacePath,
      execution.branchName,
      initial,
    );
    const existingDelivery = this.#runs.delivery(initial.id);
    if (
      existingDelivery &&
      (
        existingDelivery.provider !== this.#publisher.name ||
        existingDelivery.branchName !== execution.branchName ||
        existingDelivery.baseBranch !== request.contract.project.baseBranch
      )
    ) {
      return this.#terminalFailure(
        initial,
        "delivery-identity-drift",
        at(),
        { existing: existingDelivery },
      );
    }

    let pullRequest: PullRequestSnapshot;
    if (existingDelivery) {
      let observed: PullRequestSnapshot | null;
      try {
        observed = await this.#publisher.inspectPullRequest(
          request.project.id,
          existingDelivery.externalId,
        );
      } catch (error) {
        return this.#retryableFailure(initial.id, "draft-observation-failed", error, at());
      }
      if (!observed) {
        return this.#terminalFailure(initial, "pull-request-missing", at(), existingDelivery);
      }
      const observationFailure = validateExistingPullRequest(
        existingDelivery,
        observed,
        request.contract.delivery.merge,
      );
      if (observationFailure) {
        return this.#terminalFailure(initial, observationFailure, at(), {
          existing: existingDelivery,
          observed,
        });
      }
      const identityAdvanced = existingDelivery.baseSha !== initial.baseSha ||
        existingDelivery.headSha !== initial.headSha;
      if (observed.state === "merged") {
        pullRequest = observed;
      } else if (identityAdvanced && observed.headSha === existingDelivery.headSha) {
        try {
          pullRequest = await this.#publisher.updateDraft(publishRequest, observed);
        } catch (error) {
          return this.#retryableFailure(initial.id, "draft-update-failed", error, at());
        }
      } else if (observed.headSha === initial.headSha) {
        pullRequest = observed;
      } else {
        return this.#terminalFailure(initial, "pull-request-head-changed", at(), {
          persistedHeadSha: existingDelivery.headSha,
          verifiedHeadSha: initial.headSha,
          observedHeadSha: observed.headSha,
        });
      }
    } else {
      try {
        pullRequest = await this.#publisher.publishDraft(publishRequest);
      } catch (error) {
        return this.#retryableFailure(initial.id, "draft-publication-failed", error, at());
      }
    }
    const currentBaseSha = await this.#baseRevisions.inspect(
      request.project.rootPath,
      request.contract.project.baseBranch,
    );
    if (currentBaseSha !== initial.baseSha && pullRequest.state !== "merged") {
      const detail = { verifiedBaseSha: initial.baseSha, currentBaseSha };
      return request.contract.delivery.merge === "after-required-checks"
        ? this.#retryableFailure(
            initial.id,
            "base-advanced-before-automatic-merge",
            new Error(JSON.stringify(detail)),
            at(),
          )
        : this.#terminalFailure(initial, "base-advanced-before-delivery", at(), detail);
    }
    try {
      validatePullRequest(
        publishRequest,
        pullRequest,
        existingDelivery !== null && request.contract.delivery.merge === "after-required-checks",
      );
    } catch (error) {
      return this.#terminalFailure(initial, "invalid-draft-pull-request", at(), error);
    }

    if (
      existingDelivery &&
      (
        existingDelivery.provider !== this.#publisher.name ||
        existingDelivery.externalId !== pullRequest.externalId ||
        existingDelivery.branchName !== pullRequest.branchName
      )
    ) {
      return this.#terminalFailure(
        initial,
        "delivery-identity-drift",
        at(),
        { existing: existingDelivery, observed: pullRequest },
      );
    }

    this.#runs.recordDelivery(
      initial.id,
      {
        provider: this.#publisher.name,
        externalId: pullRequest.externalId,
        url: pullRequest.url,
        branchName: pullRequest.branchName,
        baseBranch: pullRequest.baseBranch,
        baseSha: initial.baseSha,
        headSha: pullRequest.headSha,
        draft: pullRequest.draft,
        ciStatus: existingDelivery?.ciStatus ?? "none",
      },
      at(),
    );
    let run = requireRun(this.#runs, initial.id);
    if (run.state === "verified") {
      run = this.#runs.transition(run.id, "pr-open", at());
    }

    const automaticMerge = request.contract.delivery.merge === "after-required-checks";
    if (
      automaticMerge &&
      (!this.#publisher.validateAutomaticMerge || !this.#publisher.mergeVerified)
    ) {
      return this.#terminalFailure(run, "automatic-merge-unsupported", at());
    }
    let requiredChecks: string[] = [];
    if (automaticMerge && this.#publisher.validateAutomaticMerge) {
      try {
        const validation = await this.#publisher.validateAutomaticMerge(
          request.project.id,
          request.contract.project.baseBranch,
        );
        requiredChecks = validation.requiredChecks;
      } catch (error) {
        return this.#retryableFailure(run.id, "automatic-merge-policy-unconfirmed", error, at());
      }
    }

    let ci;
    try {
      ci = await this.#publisher.checkCi(publishRequest, pullRequest);
    } catch (error) {
      return this.#retryableFailure(run.id, "ci-observation-failed", error, at());
    }
    if (!["none", "pending", "passed", "failed"].includes(ci.status)) {
      return this.#terminalFailure(run, "invalid-ci-status", at(), ci);
    }
    this.#runs.recordEvidence(run.id, "ci-observed", ci, at());

    let waitingContexts: string[] = [];
    let failedContexts: string[] = [];
    if (automaticMerge) {
      if (ci.status === "passed" && ci.checks === undefined) {
        return this.#terminalFailure(run, "required-checks-unreported", at(), { requiredChecks });
      }
      const reconciled = reconcileRequiredChecks(requiredChecks, ci.checks ?? []);
      waitingContexts = reconciled.waiting;
      failedContexts = reconciled.failed;
    }
    const downgraded = ci.status === "passed" && waitingContexts.length > 0;
    const observedStatus: DeliveryCiStatus = failedContexts.length > 0
      ? "failed"
      : downgraded
        ? "pending"
        : ci.status;

    const delivery = this.#runs.updateDeliveryCi(run.id, observedStatus, at());
    if (run.state === "pr-open") {
      run = this.#runs.transition(run.id, "ci", at());
    }
    if (downgraded || failedContexts.length > 0) {
      this.#runs.recordEvidence(run.id, "required-checks-incomplete", {
        requiredChecks,
        unsatisfied: [...failedContexts, ...waitingContexts],
        observed: ci.checks ?? [],
      }, at());
    }
    if (observedStatus === "failed") {
      this.#runs.clearCiWait(run.id);
      run = this.#runs.transition(run.id, "failed", at(), { failureReason: "ci-failed" });
      return {
        outcome: "failed",
        run,
        delivery,
        message: failedContexts.length > 0
          ? `Required CI failed: ${failedContexts.join(", ")}`
          : "Required CI failed",
        ciWaitExpired: false,
      };
    }
    if (observedStatus === "passed") {
      if (automaticMerge) {
        if (!this.#publisher.mergeVerified) {
          return this.#terminalFailure(run, "automatic-merge-unsupported", at());
        }
        let merged;
        try {
          merged = await this.#publisher.mergeVerified(publishRequest, pullRequest);
          validateAutomaticMerge(publishRequest, merged);
        } catch (error) {
          return this.#retryableFailure(run.id, "automatic-merge-failed", error, at());
        }
        this.#runs.recordEvidence(run.id, "automatic-merge-completed", {
          pullRequest: merged.pullRequest,
          taskCompleted: merged.taskCompleted,
          evidence: merged.evidence,
        }, at());
        this.#runs.recordDelivery(run.id, {
          provider: this.#publisher.name,
          externalId: merged.pullRequest.externalId,
          url: merged.pullRequest.url,
          branchName: merged.pullRequest.branchName,
          baseBranch: merged.pullRequest.baseBranch,
          baseSha: initial.baseSha,
          headSha: merged.pullRequest.headSha,
          draft: merged.pullRequest.draft,
          ciStatus: "passed",
        }, at());
      }
      this.#runs.clearCiWait(run.id);
      run = this.#runs.transition(run.id, "completed", at());
      return {
        outcome: "completed",
        run,
        delivery: requireDelivery(this.#runs, run.id),
        message: null,
        ciWaitExpired: false,
      };
    }
    const wait = this.#runs.recordCiWait(run.id, pullRequest.headSha, at());
    const boundMs = ciWaitBoundMs(request);
    const ciWaitExpired = at() - wait.firstPendingAt > boundMs;
    this.#runs.recordEvidence(run.id, "ci-wait-observed", {
      headSha: wait.headSha,
      firstPendingAt: wait.firstPendingAt,
      boundMs,
      expired: ciWaitExpired,
      unsatisfied: waitingContexts,
    }, at());
    return {
      outcome: "waiting-ci",
      run,
      delivery,
      message: waitingContexts.length > 0
        ? `Required checks are not complete: ${waitingContexts.join(", ")}`
        : ci.status === "none"
          ? "No CI result is available"
          : "CI is still pending",
      ciWaitExpired,
    };
  }

  #retryableFailure(runId: string, reason: string, error: unknown, now: number): DeliveryResult {
    this.#runs.recordEvidence(runId, "delivery-retryable-failure", {
      reason,
      detail: errorDetail(error),
    }, now);
    const run = requireRun(this.#runs, runId);
    return {
      outcome: "retryable-failure",
      run,
      delivery: this.#runs.delivery(runId),
      message: error instanceof Error ? error.message : String(error),
      ciWaitExpired: false,
    };
  }

  #terminalFailure(
    run: RunRecord,
    reason: string,
    now: number,
    detail: unknown = null,
  ): DeliveryResult {
    this.#runs.recordEvidence(run.id, "delivery-failed", { reason, detail: errorDetail(detail) }, now);
    const failed = this.#runs.transition(run.id, "failed", now + 1, { failureReason: reason });
    return {
      outcome: "failed",
      run: failed,
      delivery: this.#runs.delivery(run.id),
      message: reason,
      ciWaitExpired: false,
    };
  }
}

function ciWaitBoundMs(request: DeliverTaskRequest): number {
  const minutes = request.contract.delivery.maxCiWaitMinutes ??
    request.maxCiWaitMinutes ??
    DEFAULT_MAX_CI_WAIT_MINUTES;
  return minutes * 60_000;
}

function reconcileRequiredChecks(
  requiredChecks: string[],
  observed: CiCheck[],
): { waiting: string[]; failed: string[] } {
  const buckets = new Map<string, CiCheckBucket>();
  for (const check of observed) {
    const existing = buckets.get(check.name);
    if (existing === undefined || existing === "pass") {
      buckets.set(check.name, check.bucket);
    }
  }
  const waiting: string[] = [];
  const failed: string[] = [];
  for (const context of requiredChecks) {
    const bucket = buckets.get(context);
    if (bucket === "pass") {
      continue;
    }
    if (bucket === "fail" || bucket === "cancel") {
      failed.push(`${context} (${bucket})`);
    } else {
      waiting.push(`${context} (${bucket ?? "not reported"})`);
    }
  }
  return { waiting, failed };
}

function validateRequest(run: RunRecord, request: DeliverTaskRequest): void {
  if (!["verified", "pr-open", "ci", "completed"].includes(run.state)) {
    throw new Error(`Delivery requires verified or published work, received ${run.state}`);
  }
  if (!request.contract.delivery.pullRequest) {
    throw new Error("Delivery requires pull requests");
  }
  if (
    request.contract.delivery.merge === "after-required-checks" &&
    (!request.contract.delivery.provider || !request.task.sourceId)
  ) {
    throw new Error("Automatic merge requires delivery and task-source identities");
  }
  if (
    run.projectId !== request.project.id ||
    run.projectId !== request.contract.project.id ||
    run.taskId !== request.task.id ||
    run.revision !== request.task.revision
  ) {
    throw new Error("Run, task, registration, and contract identities do not match");
  }
}

function draftRequest(
  request: DeliverTaskRequest,
  workspacePath: string,
  branchName: string,
  run: RunRecord,
): DraftPullRequestRequest {
  return {
    repository: request.project.id,
    repositoryPath: request.project.rootPath,
    workspacePath,
    runId: run.id,
    taskId: request.task.id,
    sourceId: request.task.sourceId,
    branchName,
    baseBranch: request.contract.project.baseBranch,
    baseSha: run.baseSha,
    headSha: run.headSha ?? "",
    title: request.task.title,
    body: [
      request.task.prompt,
      "",
      "---",
      `Agent Runner task: ${request.task.id}`,
      `Agent Runner run: ${run.id}`,
      request.contract.delivery.merge === "after-required-checks"
        ? "Automatic merge: enabled after required checks"
        : "Automatic merge: disabled",
    ].join("\n"),
  };
}

function validatePullRequest(
  request: DraftPullRequestRequest,
  pullRequest: PullRequestSnapshot,
  allowReadyOrMerged = false,
): void {
  if (
    pullRequest.externalId.trim() === "" ||
    pullRequest.url.trim() === "" ||
    (pullRequest.state !== "open" && !(allowReadyOrMerged && pullRequest.state === "merged")) ||
    (!pullRequest.draft && !allowReadyOrMerged) ||
    pullRequest.branchName !== request.branchName ||
    pullRequest.baseBranch !== request.baseBranch ||
    pullRequest.headSha !== request.headSha
  ) {
    throw new Error("Publisher returned a pull request that does not match the verified run");
  }
}

function validateExistingPullRequest(
  persisted: RunDeliveryRecord,
  observed: PullRequestSnapshot,
  mergePolicy: ProjectContract["delivery"]["merge"],
): string | null {
  if (observed.state === "merged" && mergePolicy === "never") {
    return "pull-request-merged";
  }
  if (observed.state === "closed") {
    return "pull-request-closed";
  }
  if (!observed.draft && mergePolicy === "never") {
    return "pull-request-not-draft";
  }
  if (
    observed.externalId !== persisted.externalId ||
    observed.url !== persisted.url ||
    observed.branchName !== persisted.branchName ||
    observed.baseBranch !== persisted.baseBranch
  ) {
    return "delivery-identity-drift";
  }
  return null;
}

function validateAutomaticMerge(
  request: DraftPullRequestRequest,
  result: {
    pullRequest: PullRequestSnapshot;
    taskCompleted: boolean;
    evidence: string[];
  },
): void {
  if (
    result.pullRequest.state !== "merged" ||
    result.pullRequest.draft ||
    result.pullRequest.externalId.trim() === "" ||
    result.pullRequest.branchName !== request.branchName ||
    result.pullRequest.baseBranch !== request.baseBranch ||
    result.pullRequest.headSha !== request.headSha ||
    !result.taskCompleted ||
    !Array.isArray(result.evidence) ||
    result.evidence.length === 0 ||
    result.evidence.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw new Error("Publisher did not prove an exact verified merge and task completion");
  }
}

function requireRun(runs: RunStore, runId: string): RunRecord {
  const run = runs.get(runId);
  if (!run) {
    throw new Error(`Unknown run: ${runId}`);
  }
  return run;
}

function requireDelivery(runs: RunStore, runId: string): RunDeliveryRecord {
  const delivery = runs.delivery(runId);
  if (!delivery) {
    throw new Error(`Completed run ${runId} has no delivery record`);
  }
  return delivery;
}

function errorDetail(value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message } : value;
}
