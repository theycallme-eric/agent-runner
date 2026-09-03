import type { DeliveryCiStatus } from "../core/types.js";

export interface DraftPullRequestRequest {
  repository: string;
  repositoryPath: string;
  workspacePath: string;
  runId: string;
  taskId: string;
  sourceId: string;
  branchName: string;
  baseBranch: string;
  baseSha: string;
  headSha: string;
  title: string;
  body: string;
}

export interface PullRequestSnapshot {
  externalId: string;
  url: string;
  branchName: string;
  baseBranch: string;
  headSha: string;
  draft: boolean;
  state: "open" | "closed" | "merged";
}

export type CiCheckBucket = "pass" | "fail" | "pending" | "skipping" | "cancel";

export interface CiCheck {
  name: string;
  bucket: CiCheckBucket;
  /** Identifier of the GitHub App that reported the result, or null when the source is unproven. */
  appId: number | null;
  /** Commit the result was reported against, or null when the observation does not carry one. */
  headSha: string | null;
}

/** One context branch protection requires, with the reporting application it is pinned to. */
export interface RequiredCheck {
  context: string;
  appId: number | null;
}

export interface CiSnapshot {
  status: DeliveryCiStatus;
  evidence: string[];
  checks?: CiCheck[];
}

export interface AutomaticMergeValidation {
  evidence: string[];
  requiredChecks: RequiredCheck[];
}

export interface AutomaticMergeResult {
  pullRequest: PullRequestSnapshot;
  taskCompleted: boolean;
  evidence: string[];
}

export interface PullRequestPublisher {
  readonly name: string;
  publishDraft(request: DraftPullRequestRequest): Promise<PullRequestSnapshot>;
  inspectPullRequest(repository: string, externalId: string): Promise<PullRequestSnapshot | null>;
  updateDraft(
    request: DraftPullRequestRequest,
    expected: PullRequestSnapshot,
  ): Promise<PullRequestSnapshot>;
  checkCi(
    request: DraftPullRequestRequest,
    pullRequest: PullRequestSnapshot,
  ): Promise<CiSnapshot>;
  validateAutomaticMerge?(
    repository: string,
    baseBranch: string,
  ): Promise<AutomaticMergeValidation>;
  /**
   * Observe the required contexts with enough identity to prove the reporting source and the head
   * commit. Used instead of `checkCi` wherever automatic merging is enabled.
   */
  observeRequiredChecks?(
    request: DraftPullRequestRequest,
    requiredChecks: RequiredCheck[],
  ): Promise<CiSnapshot>;
  mergeVerified?(
    request: DraftPullRequestRequest,
    pullRequest: PullRequestSnapshot,
  ): Promise<AutomaticMergeResult>;
}
