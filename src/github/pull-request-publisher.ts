import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  CiSnapshot,
  DraftPullRequestRequest,
  PullRequestPublisher,
  PullRequestSnapshot,
} from "../delivery/types.js";

const execFileAsync = promisify(execFile);
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_OUTPUT_BYTES = 5_000_000;

interface RawPullRequest {
  number?: unknown;
  url?: unknown;
  isDraft?: unknown;
  headRefName?: unknown;
  baseRefName?: unknown;
  headRefOid?: unknown;
}

interface RawCheck {
  name?: unknown;
  bucket?: unknown;
  link?: unknown;
}

export interface GitHubPullRequestPublisherOptions {
  ghExecutable?: string;
  gitExecutable?: string;
}

export class GitHubPullRequestPublisher implements PullRequestPublisher {
  readonly name = "github";
  readonly #ghExecutable: string;
  readonly #gitExecutable: string;

  constructor(options: GitHubPullRequestPublisherOptions = {}) {
    this.#ghExecutable = options.ghExecutable ?? "gh";
    this.#gitExecutable = options.gitExecutable ?? "git";
  }

  async publishDraft(request: DraftPullRequestRequest): Promise<PullRequestSnapshot> {
    validateRequest(request);
    const localHead = await this.#git(request.workspacePath, ["rev-parse", "HEAD"]);
    if (localHead !== request.headSha) {
      throw new Error(`Workspace HEAD ${localHead} does not match verified head ${request.headSha}`);
    }
    await this.#git(request.workspacePath, [
      "push",
      "origin",
      `HEAD:refs/heads/${request.branchName}`,
    ]);

    let pullRequests = await this.#list(request);
    if (pullRequests.length === 0) {
      try {
        await this.#gh([
          "pr",
          "create",
          "--repo",
          request.repository,
          "--draft",
          "--base",
          request.baseBranch,
          "--head",
          request.branchName,
          "--title",
          request.title,
          "--body",
          request.body,
        ]);
      } catch (error) {
        pullRequests = await this.#list(request);
        if (pullRequests.length === 0) {
          throw error;
        }
      }
    }

    pullRequests = await this.#list(request);
    if (pullRequests.length !== 1) {
      throw new Error(
        `Expected one open pull request for ${request.branchName}, found ${pullRequests.length}`,
      );
    }
    const pullRequest = pullRequests[0];
    if (!pullRequest) {
      throw new Error("Pull-request list changed unexpectedly");
    }
    if (!pullRequest.draft) {
      await this.#gh([
        "pr",
        "ready",
        pullRequest.externalId,
        "--repo",
        request.repository,
        "--undo",
      ]);
    }
    await this.#gh([
      "pr",
      "edit",
      pullRequest.externalId,
      "--repo",
      request.repository,
      "--title",
      request.title,
      "--body",
      request.body,
    ]);
    const refreshed = await this.#list(request);
    if (refreshed.length !== 1 || !refreshed[0]) {
      throw new Error(`Pull request for ${request.branchName} disappeared after reconciliation`);
    }
    return refreshed[0];
  }

  async checkCi(
    request: DraftPullRequestRequest,
    pullRequest: PullRequestSnapshot,
  ): Promise<CiSnapshot> {
    validateRequest(request);
    const output = await this.#ghAllowingCheckStatus([
      "pr",
      "checks",
      pullRequest.externalId,
      "--repo",
      request.repository,
      "--json",
      "name,bucket,link",
      "--required",
    ]);
    return parseChecks(output);
  }

  async #list(request: DraftPullRequestRequest): Promise<PullRequestSnapshot[]> {
    const output = await this.#gh([
      "pr",
      "list",
      "--repo",
      request.repository,
      "--state",
      "open",
      "--head",
      request.branchName,
      "--json",
      "number,url,isDraft,headRefName,baseRefName,headRefOid",
      "--limit",
      "2",
    ]);
    return parsePullRequests(output);
  }

  async #gh(argumentsList: string[]): Promise<string> {
    const result = await execFileAsync(this.#ghExecutable, argumentsList, {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return result.stdout;
  }

  async #ghAllowingCheckStatus(argumentsList: string[]): Promise<string> {
    try {
      return await this.#gh(argumentsList);
    } catch (error) {
      const recovered = recoverChecksOutput(error);
      if (recovered !== null) {
        return recovered;
      }
      throw error;
    }
  }

  async #git(cwd: string, argumentsList: string[]): Promise<string> {
    const result = await execFileAsync(this.#gitExecutable, argumentsList, {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return result.stdout.trim();
  }
}

export function recoverChecksOutput(error: unknown): string | null {
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return null;
  }
  const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
  if (
    (failure.code === 1 || failure.code === 8) &&
    typeof failure.stdout === "string" &&
    failure.stdout.trim() !== ""
  ) {
    return failure.stdout;
  }
  if (
    failure.code === 1 &&
    (failure.stdout === undefined || failure.stdout === "") &&
    typeof failure.stderr === "string" &&
    /^no checks reported on the '.+' branch$/u.test(failure.stderr.trim())
  ) {
    return "[]";
  }
  return null;
}

export function parsePullRequests(source: string): PullRequestSnapshot[] {
  const value = JSON.parse(source) as unknown;
  if (!Array.isArray(value)) {
    throw new Error("GitHub pull-request response must be an array");
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`pullRequests[${index}] must be an object`);
    }
    const raw = entry as RawPullRequest;
    return {
      externalId: String(positiveInteger(raw.number, `pullRequests[${index}].number`)),
      url: stringValue(raw.url, `pullRequests[${index}].url`),
      draft: booleanValue(raw.isDraft, `pullRequests[${index}].isDraft`),
      branchName: stringValue(raw.headRefName, `pullRequests[${index}].headRefName`),
      baseBranch: stringValue(raw.baseRefName, `pullRequests[${index}].baseRefName`),
      headSha: stringValue(raw.headRefOid, `pullRequests[${index}].headRefOid`),
    };
  });
}

export function parseChecks(source: string): CiSnapshot {
  const value = JSON.parse(source) as unknown;
  if (!Array.isArray(value)) {
    throw new Error("GitHub checks response must be an array");
  }
  const checks = value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`checks[${index}] must be an object`);
    }
    const raw = entry as RawCheck;
    const bucket = stringValue(raw.bucket, `checks[${index}].bucket`);
    if (!["pass", "fail", "pending", "skipping", "cancel"].includes(bucket)) {
      throw new Error(`Unsupported GitHub check bucket: ${bucket}`);
    }
    return {
      name: stringValue(raw.name, `checks[${index}].name`),
      bucket,
      link: raw.link === "" || raw.link === null ? null : stringValue(raw.link, `checks[${index}].link`),
    };
  });
  const status = checks.length === 0
    ? "none"
    : checks.some((check) => check.bucket === "fail" || check.bucket === "cancel")
      ? "failed"
      : checks.some((check) => check.bucket === "pending")
        ? "pending"
        : "passed";
  return {
    status,
    evidence: checks.map((check) => `${check.name}: ${check.bucket}${check.link ? ` (${check.link})` : ""}`),
  };
}

function validateRequest(request: DraftPullRequestRequest): void {
  if (!REPOSITORY.test(request.repository)) {
    throw new Error(`GitHub repository must be owner/name: ${request.repository}`);
  }
  if (
    !BRANCH.test(request.branchName) ||
    request.branchName.includes("..") ||
    request.branchName.startsWith("-")
  ) {
    throw new Error(`Unsafe GitHub branch name: ${request.branchName}`);
  }
  for (const [path, value] of [
    ["repositoryPath", request.repositoryPath],
    ["workspacePath", request.workspacePath],
    ["baseBranch", request.baseBranch],
    ["headSha", request.headSha],
    ["title", request.title],
    ["body", request.body],
  ] as const) {
    if (value.trim() === "") {
      throw new Error(`${path} must be non-empty`);
    }
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${path} must be a positive integer`);
  }
  return value as number;
}
