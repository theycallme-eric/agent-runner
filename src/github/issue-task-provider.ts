import type { TaskProvider, TaskStatus } from "../tasks/types.js";
import type { ProjectContract } from "../project-contract.js";
import type { ProjectRegistration } from "../projects/types.js";
import type { GitHubClient, GitHubIssue } from "./types.js";
import { handoffSetting, loadApprovedHandoff, type ApprovedHandoff } from "./approved-handoff.js";

export class GitHubIssueTaskProvider implements TaskProvider {
  readonly name = "github";
  readonly #client: GitHubClient;

  constructor(client: GitHubClient) {
    this.#client = client;
  }

  async listTasks(project: ProjectRegistration, contract: ProjectContract) {
    const options = githubTaskOptions(contract.tasks.config);
    const issues = await this.#client.listIssues(project.id);
    const handoff = await loadApprovedHandoff(project, contract);
    if (handoff !== null) {
      return approvedTasks(issues, handoff, options.includeLabels);
    }
    return issues
      .filter((issue) => includesIssue(issue, options.includeLabels))
      .map((issue) => ({
        id: taskId(issue.number),
        sourceId: String(issue.number),
        revision: `${issue.nodeId}:${issue.updatedAt}`,
        title: issue.title,
        prompt: promptFor(issue),
        status: statusFor(issue),
        dependencies: [],
      }));
  }
}

interface GitHubTaskOptions {
  includeLabels: string[];
}

function githubTaskOptions(config: Record<string, unknown>): GitHubTaskOptions {
  handoffSetting(config);
  const rawLabels = config.includeLabels;
  if (rawLabels === undefined) {
    return { includeLabels: [] };
  }
  if (!Array.isArray(rawLabels)) {
    throw new Error("GitHub tasks.config.includeLabels must be an array");
  }
  const includeLabels = rawLabels.map((label, index) => {
    if (typeof label !== "string" || label.trim() === "") {
      throw new Error(`GitHub tasks.config.includeLabels[${index}] must be a non-empty string`);
    }
    return label.toLowerCase();
  });
  if (new Set(includeLabels).size !== includeLabels.length) {
    throw new Error("GitHub tasks.config.includeLabels contains duplicates");
  }
  return { includeLabels };
}

function approvedTasks(
  issues: GitHubIssue[],
  handoff: ApprovedHandoff,
  includeLabels: string[],
) {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const desiredTasks = new Set(handoff.tasks.map(({ taskId }) => taskId));
  const remoteTaskIds = new Map<string, number>();
  for (const issue of issues) {
    for (const managedId of managedTaskIds(issue.body, handoff.requirementsSetId)) {
      const previous = remoteTaskIds.get(managedId);
      if (previous !== undefined) {
        throw new Error(
          `GitHub contains duplicate approved task ${managedId} in #${previous} and #${issue.number}`,
        );
      }
      remoteTaskIds.set(managedId, issue.number);
      if (issue.state === "open" && !desiredTasks.has(managedId)) {
        throw new Error(`GitHub contains unexpected open managed task ${managedId}`);
      }
    }
  }
  return handoff.tasks.map((task) => {
    const issue = byNumber.get(task.issueNumber);
    if (!issue || issue.databaseId !== task.databaseId) {
      throw new Error(`Approved task ${task.taskId} is missing or has a different GitHub identity`);
    }
    if (remoteTaskIds.get(task.taskId) !== issue.number) {
      throw new Error(`GitHub issue #${issue.number} is missing approved task marker ${task.taskId}`);
    }
    if (
      issue.title !== task.title ||
      issue.body !== task.prompt ||
      !sameLabels(issue.labels, task.labels)
    ) {
      throw new Error(`GitHub issue #${issue.number} drifted from approved task ${task.taskId}`);
    }
    if (!includesIssue(issue, includeLabels)) {
      throw new Error(`Approved task ${task.taskId} no longer matches configured include labels`);
    }
    return {
      id: task.taskId,
      sourceId: String(issue.number),
      revision: `${handoff.graphSha256}:${task.taskId}`,
      title: issue.title,
      prompt: approvedPrompt(issue, task),
      status: statusFor(issue),
      dependencies: [],
      requirementIds: [...task.requirementIds],
      sourceRefs: [...task.sourceRefs],
      acceptanceCriteria: [...task.acceptanceCriteria],
      verificationExpectations: [...task.verificationExpectations],
    };
  });
}

function managedTaskIds(body: string, setId: string): string[] {
  return [...body.matchAll(
    /<!-- requirements-builder:managed set=([a-f0-9]{64}) task=([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*) -->/g,
  )]
    .filter((match) => match[1] === setId)
    .flatMap((match) => match[2] ? [match[2]] : []);
}

function approvedPrompt(issue: GitHubIssue, task: ApprovedHandoff["tasks"][number]): string {
  return [
    `Implement approved requirements task ${task.taskId} from GitHub issue #${issue.number}.`,
    `Source: ${issue.url}`,
    `Requirements: ${task.requirementIds.join(", ")}`,
    `Evidence: ${task.sourceRefs.join(", ")}`,
    "",
    "The acceptance criteria and task-specific verification expectations below are mandatory.",
    "Agent Runner will also run the project-level verification commands independently.",
    "",
    issue.body,
  ].join("\n");
}

function sameLabels(left: string[], right: string[]): boolean {
  const a = left.map((label) => label.toLowerCase()).sort();
  const b = right.map((label) => label.toLowerCase()).sort();
  return a.length === b.length && a.every((label, index) => label === b[index]);
}

function includesIssue(issue: GitHubIssue, includeLabels: string[]): boolean {
  if (includeLabels.length === 0) {
    return true;
  }
  const issueLabels = new Set(issue.labels.map((label) => label.toLowerCase()));
  return includeLabels.every((label) => issueLabels.has(label));
}

export function taskId(issueNumber: number): string {
  return `issue-${issueNumber}`;
}

function statusFor(issue: GitHubIssue): TaskStatus {
  if (issue.state === "closed") {
    return issue.stateReason === "not_planned" ? "blocked" : "completed";
  }
  return issue.labels.some((label) => label.toLowerCase() === "agent:blocked")
    ? "blocked"
    : "pending";
}

function promptFor(issue: GitHubIssue): string {
  return [
    `Implement GitHub issue #${issue.number}: ${issue.title}`,
    `Source: ${issue.url}`,
    "",
    issue.body || "No issue description was provided.",
  ].join("\n");
}
