import type { TaskProvider, TaskStatus } from "../tasks/types.js";
import type { ProjectContract } from "../project-contract.js";
import type { ProjectRegistration } from "../projects/types.js";
import type { GitHubClient, GitHubIssue } from "./types.js";

export class GitHubIssueTaskProvider implements TaskProvider {
  readonly name = "github";
  readonly #client: GitHubClient;

  constructor(client: GitHubClient) {
    this.#client = client;
  }

  async listTasks(project: ProjectRegistration, contract: ProjectContract) {
    const options = githubTaskOptions(contract.tasks.config);
    const issues = await this.#client.listIssues(project.id);
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
  const unknown = Object.keys(config).filter((key) => key !== "includeLabels");
  if (unknown.length > 0) {
    throw new Error(`GitHub task config has unknown fields: ${unknown.join(", ")}`);
  }
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
