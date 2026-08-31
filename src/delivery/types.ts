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

export interface CiSnapshot {
  status: DeliveryCiStatus;
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
}
