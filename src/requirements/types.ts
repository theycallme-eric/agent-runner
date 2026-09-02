import type { WorkerOutcome } from "../workers/types.js";

export interface RequirementsPlan {
  version: 1;
  project: {
    name: string;
    summary: string;
  };
  assumptions: string[];
  openQuestions: Array<{
    id: string;
    question: string;
    blocking: boolean;
  }>;
  requirements: Array<{
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    sourceRefs: string[];
  }>;
  tasks: Array<{
    id: string;
    title: string;
    objective: string;
    requirementIds: string[];
    dependencies: string[];
    acceptanceCriteria: string[];
    verification: string[];
  }>;
}

export interface RequirementsAnalysis {
  readyForPublishing: boolean;
  blockingQuestionIds: string[];
  rootTaskIds: string[];
  waitingTaskIds: string[];
  edgeCount: number;
}

export interface SourceManifest {
  version: 1;
  createdAt: string;
  inputs: Array<{
    name: string;
    kind: "file" | "directory" | "zip";
    storedPath: string;
  }>;
  files: Array<{
    path: string;
    sizeBytes: number;
    sha256: string;
  }>;
}

export interface GitHubIssueDraft {
  taskId: string;
  title: string;
  body: string;
  blockedBy: string[];
}

export interface RequirementsBuildResult {
  workspacePath: string;
  planPath: string;
  previewPath: string;
  issueDraftsPath: string;
  readyForPublishing: boolean;
  blockingQuestionIds: string[];
  rootTaskIds: string[];
  taskCount: number;
  requirementCount: number;
  worker: WorkerOutcome;
}
