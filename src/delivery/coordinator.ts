import { protectedPathGate } from "../core/policy.js";
import type { RunStore } from "../core/store.js";
import type { RunDeliveryRecord, RunRecord } from "../core/types.js";
import type { ProjectContract } from "../project-contract.js";
import type { ProjectRegistration } from "../projects/types.js";
import type { TaskNode } from "../tasks/types.js";
import type { WorkspaceRepository } from "../workspaces/git-repository.js";
import type { BaseRevisionProvider } from "../workspaces/base-revision.js";
import type {
  DraftPullRequestRequest,
  PullRequestPublisher,
  PullRequestSnapshot,
} from "./types.js";

export interface DeliverTaskRequest {
  runId: string;
  task: TaskNode;
  project: ProjectRegistration;
  contract: ProjectContract;
}

export interface DeliveryResult {
  outcome: "waiting-ci" | "completed" | "failed" | "waiting-human" | "retryable-failure";
  run: RunRecord;
  delivery: RunDeliveryRecord | null;
  message: string | null;
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
      };
    }

    const currentBaseSha = await this.#baseRevisions.inspect(
      request.project.rootPath,
      request.contract.project.baseBranch,
    );
    if (currentBaseSha !== initial.baseSha) {
      return this.#terminalFailure(
        initial,
        "base-advanced-before-delivery",
        at(),
        { verifiedBaseSha: initial.baseSha, currentBaseSha },
      );
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
      const observationFailure = validateExistingPullRequest(existingDelivery, observed);
      if (observationFailure) {
        return this.#terminalFailure(initial, observationFailure, at(), {
          existing: existingDelivery,
          observed,
        });
      }
      const identityAdvanced = existingDelivery.baseSha !== initial.baseSha ||
        existingDelivery.headSha !== initial.headSha;
      if (identityAdvanced && observed.headSha === existingDelivery.headSha) {
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
    try {
      validatePullRequest(publishRequest, pullRequest);
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
    const delivery = this.#runs.updateDeliveryCi(run.id, ci.status, at());
    if (run.state === "pr-open") {
      run = this.#runs.transition(run.id, "ci", at());
    }
    if (ci.status === "failed") {
      run = this.#runs.transition(run.id, "failed", at(), { failureReason: "ci-failed" });
      return { outcome: "failed", run, delivery, message: "Required CI failed" };
    }
    if (ci.status === "passed") {
      run = this.#runs.transition(run.id, "completed", at());
      return { outcome: "completed", run, delivery, message: null };
    }
    return {
      outcome: "waiting-ci",
      run,
      delivery,
      message: ci.status === "none" ? "No CI result is available" : "CI is still pending",
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
    };
  }
}

function validateRequest(run: RunRecord, request: DeliverTaskRequest): void {
  if (!["verified", "pr-open", "ci", "completed"].includes(run.state)) {
    throw new Error(`Delivery requires verified or published work, received ${run.state}`);
  }
  if (!request.contract.delivery.pullRequest || request.contract.delivery.merge !== "never") {
    throw new Error("Delivery requires draft pull requests with merge disabled");
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
      "Automatic merge: disabled",
    ].join("\n"),
  };
}

function validatePullRequest(
  request: DraftPullRequestRequest,
  pullRequest: PullRequestSnapshot,
): void {
  if (
    pullRequest.externalId.trim() === "" ||
    pullRequest.url.trim() === "" ||
    pullRequest.state !== "open" ||
    !pullRequest.draft ||
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
): string | null {
  if (observed.state === "merged") {
    return "pull-request-merged";
  }
  if (observed.state === "closed") {
    return "pull-request-closed";
  }
  if (!observed.draft) {
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
