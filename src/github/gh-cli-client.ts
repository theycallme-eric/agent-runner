import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GitHubClient, GitHubIssue, GitHubIssueReference } from "./types.js";

const execFileAsync = promisify(execFile);
const API_VERSION = "2026-03-10";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface RawIssue {
  number?: unknown;
  id?: unknown;
  node_id?: unknown;
  repository_url?: unknown;
  title?: unknown;
  body?: unknown;
  state?: unknown;
  state_reason?: unknown;
  updated_at?: unknown;
  labels?: unknown;
  html_url?: unknown;
  pull_request?: unknown;
}

export class GhCliGitHubClient implements GitHubClient {
  readonly #executable: string;

  constructor(executable = "gh") {
    this.#executable = executable;
  }

  async listIssues(repository: string): Promise<GitHubIssue[]> {
    validateRepository(repository);
    const output = await this.#api(`repos/${repository}/issues`, ["state=all", "per_page=100"]);
    return parsePaginatedIssues(output, repository);
  }

  async listBlockedBy(repository: string, issueNumber: number): Promise<GitHubIssueReference[]> {
    validateRepository(repository);
    if (!Number.isInteger(issueNumber) || issueNumber < 1) {
      throw new Error("GitHub issue number must be a positive integer");
    }
    const output = await this.#api(
      `repos/${repository}/issues/${issueNumber}/dependencies/blocked_by`,
      ["per_page=100"],
    );
    return parsePaginatedReferences(output);
  }

  async #api(endpoint: string, fields: string[]): Promise<string> {
    const argumentsList = [
      "api",
      endpoint,
      "--method",
      "GET",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      `X-GitHub-Api-Version: ${API_VERSION}`,
      "--paginate",
      "--slurp",
    ];
    for (const field of fields) {
      argumentsList.push("-f", field);
    }
    const result = await execFileAsync(this.#executable, argumentsList, {
      encoding: "utf8",
      maxBuffer: 20_000_000,
    });
    return result.stdout;
  }
}

export function parsePaginatedIssues(source: string, repository: string): GitHubIssue[] {
  validateRepository(repository);
  return pages(source)
    .filter((raw) => raw.pull_request === undefined)
    .map((raw) => parseIssue(raw, repository))
    .sort((left, right) => left.number - right.number);
}

export function parsePaginatedReferences(source: string): GitHubIssueReference[] {
  return pages(source)
    .map((raw) => ({
      number: positiveInteger(raw.number, "issue.number"),
      repository: repositoryFromApiUrl(stringValue(raw.repository_url, "issue.repository_url")),
    }))
    .sort((left, right) =>
      left.repository === right.repository
        ? left.number - right.number
        : left.repository.localeCompare(right.repository),
    );
}

function parseIssue(raw: RawIssue, repository: string): GitHubIssue {
  const state = stringValue(raw.state, "issue.state");
  if (state !== "open" && state !== "closed") {
    throw new Error(`Unsupported GitHub issue state: ${state}`);
  }
  const stateReason = nullableString(raw.state_reason, "issue.state_reason");
  if (
    stateReason !== null &&
    stateReason !== "completed" &&
    stateReason !== "not_planned" &&
    stateReason !== "reopened"
  ) {
    throw new Error(`Unsupported GitHub issue state reason: ${stateReason}`);
  }
  if (!Array.isArray(raw.labels)) {
    throw new Error("issue.labels must be an array");
  }
  return {
    number: positiveInteger(raw.number, "issue.number"),
    databaseId: positiveInteger(raw.id, "issue.id"),
    nodeId: stringValue(raw.node_id, "issue.node_id"),
    repository,
    title: stringValue(raw.title, "issue.title"),
    body: nullableString(raw.body, "issue.body") ?? "",
    state,
    stateReason,
    updatedAt: stringValue(raw.updated_at, "issue.updated_at"),
    labels: raw.labels.map((label, index) => {
      if (typeof label === "string") {
        return label;
      }
      if (typeof label === "object" && label !== null && "name" in label) {
        return stringValue((label as { name: unknown }).name, `issue.labels[${index}].name`);
      }
      throw new Error(`issue.labels[${index}] must contain a name`);
    }),
    url: stringValue(raw.html_url, "issue.html_url"),
  };
}

function pages(source: string): RawIssue[] {
  const value = JSON.parse(source) as unknown;
  if (!Array.isArray(value) || !value.every(Array.isArray)) {
    throw new Error("GitHub paginated response must be an array of pages");
  }
  return value.flat() as RawIssue[];
}

function repositoryFromApiUrl(url: string): string {
  const match = /\/repos\/([^/]+\/[^/]+)$/.exec(url);
  if (!match?.[1]) {
    throw new Error(`Cannot read repository from GitHub API URL: ${url}`);
  }
  return match[1];
}

function validateRepository(repository: string): void {
  if (!REPOSITORY.test(repository)) {
    throw new Error(`GitHub repository must be owner/name: ${repository}`);
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return stringValue(value, path);
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${path} must be a positive integer`);
  }
  return value as number;
}
