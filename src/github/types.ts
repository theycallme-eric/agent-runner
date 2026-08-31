export interface GitHubIssue {
  number: number;
  databaseId: number;
  nodeId: string;
  repository: string;
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason: "completed" | "not_planned" | "reopened" | null;
  updatedAt: string;
  labels: string[];
  url: string;
}

export interface GitHubIssueReference {
  number: number;
  repository: string;
}

export interface GitHubClient {
  listIssues(repository: string): Promise<GitHubIssue[]>;
  listBlockedBy(repository: string, issueNumber: number): Promise<GitHubIssueReference[]>;
}
