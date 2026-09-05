import type { ProjectContract } from "../project-contract.js";
import type { ProjectRegistration } from "../projects/types.js";

export type TaskStatus = "pending" | "completed" | "blocked";

export interface TaskNode {
  id: string;
  sourceId: string;
  revision: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  dependencies: string[];
  requirementIds?: string[];
  sourceRefs?: string[];
  /** Runtime-only location of the approved external evidence set. Never persisted to GitHub. */
  evidenceRootPath?: string;
  acceptanceCriteria?: string[];
  verificationExpectations?: string[];
  executionPrerequisites?: Array<{
    id: string;
    verificationCommand: string;
  }>;
}

export interface TaskProvider {
  readonly name: string;
  listTasks(project: ProjectRegistration, contract: ProjectContract): Promise<TaskNode[]>;
}

export interface DependencyResolver {
  readonly name: string;
  resolve(
    tasks: TaskNode[],
    project: ProjectRegistration,
    contract: ProjectContract,
  ): Promise<TaskNode[]>;
}

export interface TaskGraphSnapshot {
  ready: TaskNode[];
  waiting: TaskNode[];
  blocked: TaskNode[];
  completed: TaskNode[];
  edgeCount: number;
}
