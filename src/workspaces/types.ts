export interface WorkspaceRequest {
  repositoryPath: string;
  runId: string;
  baseRef: string;
  branchName: string;
}

export interface WorkspaceRecord {
  path: string;
  branchName: string;
  baseSha: string;
}

export interface WorkspaceManager {
  create(request: WorkspaceRequest): Promise<WorkspaceRecord>;
}
