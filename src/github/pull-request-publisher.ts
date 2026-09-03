import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  AutomaticMergeResult,
  AutomaticMergeValidation,
  CiCheck,
  CiCheckBucket,
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

interface RawApiPullRequest {
  number?: unknown;
  html_url?: unknown;
  draft?: unknown;
  state?: unknown;
  merged_at?: unknown;
  head?: unknown;
  base?: unknown;
}

interface RawCheck {
  name?: unknown;
  bucket?: unknown;
  link?: unknown;
}

interface RawBranchProtection {
  required_status_checks?: unknown;
  enforce_admins?: unknown;
}

interface RawIssue {
  number?: unknown;
  state?: unknown;
  state_reason?: unknown;
  pull_request?: unknown;
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
      return pullRequest;
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

  async inspectPullRequest(
    repository: string,
    externalId: string,
  ): Promise<PullRequestSnapshot | null> {
    validateIdentity(repository, externalId);
    let output: string;
    try {
      output = await this.#gh([
        "api",
        `repos/${repository}/pulls/${externalId}`,
        "--header",
        "X-GitHub-Api-Version: 2026-03-10",
      ]);
    } catch (error) {
      if (isGitHubNotFound(error)) {
        return null;
      }
      throw error;
    }
    return parsePullRequest(output);
  }

  async updateDraft(
    request: DraftPullRequestRequest,
    expected: PullRequestSnapshot,
  ): Promise<PullRequestSnapshot> {
    validateRequest(request);
    const before = await this.inspectPullRequest(request.repository, expected.externalId);
    if (!before || !samePullRequest(before, expected)) {
      throw new Error(`Pull request ${expected.externalId} changed before draft update`);
    }
    if (before.state !== "open" || !before.draft) {
      throw new Error(`Pull request ${expected.externalId} is not an open draft`);
    }
    const localHead = await this.#git(request.workspacePath, ["rev-parse", "HEAD"]);
    if (localHead !== request.headSha) {
      throw new Error(`Workspace HEAD ${localHead} does not match verified head ${request.headSha}`);
    }
    await this.#git(request.workspacePath, [
      "push",
      "origin",
      `HEAD:refs/heads/${request.branchName}`,
    ]);
    await this.#gh([
      "pr",
      "edit",
      expected.externalId,
      "--repo",
      request.repository,
      "--title",
      request.title,
      "--body",
      request.body,
    ]);
    const refreshed = await this.inspectPullRequest(request.repository, expected.externalId);
    if (!refreshed) {
      throw new Error(`Pull request ${expected.externalId} disappeared after draft update`);
    }
    return refreshed;
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

  async validateAutomaticMerge(
    repository: string,
    baseBranch: string,
  ): Promise<AutomaticMergeValidation> {
    validateRepository(repository);
    validateBranch(baseBranch, "baseBranch");
    const output = await this.#gh([
      "api",
      `repos/${repository}/branches/${encodeURIComponent(baseBranch)}/protection`,
      "--header",
      "X-GitHub-Api-Version: 2026-03-10",
    ]);
    const protection = parseBranchProtection(output);
    if (!protection.strict || protection.requiredChecks.length === 0) {
      throw new Error(
        `Automatic merge requires strict branch protection and at least one required check on ${baseBranch}`,
      );
    }
    if (!protection.enforceAdmins) {
      throw new Error(
        `Automatic merge requires enforce_admins on ${baseBranch}: enable "Do not allow bypassing the above settings" so branch protection binds every token, including administrators`,
      );
    }
    return {
      evidence: [
        `Protected base branch: ${baseBranch}`,
        `Required checks: ${protection.requiredChecks.join(", ")}`,
        "Administrators cannot bypass required checks",
      ],
      requiredChecks: protection.requiredChecks,
    };
  }

  async mergeVerified(
    request: DraftPullRequestRequest,
    pullRequest: PullRequestSnapshot,
  ): Promise<AutomaticMergeResult> {
    validateRequest(request);
    assertPullRequestIdentity(request, pullRequest);
    const validation = await this.validateAutomaticMerge(request.repository, request.baseBranch);
    const evidence = [...validation.evidence];
    let observed = await this.inspectPullRequest(request.repository, pullRequest.externalId);
    if (!observed) {
      throw new Error(`Pull request ${pullRequest.externalId} disappeared before automatic merge`);
    }
    assertPullRequestIdentity(request, observed);

    if (observed.state === "open") {
      if (observed.draft) {
        await this.#gh([
          "pr",
          "ready",
          observed.externalId,
          "--repo",
          request.repository,
        ]);
        const ready = await this.inspectPullRequest(request.repository, observed.externalId);
        if (!ready) {
          throw new Error(`Pull request ${observed.externalId} disappeared after becoming ready`);
        }
        assertPullRequestIdentity(request, ready);
        if (ready.state !== "open" || ready.draft) {
          throw new Error(`Pull request ${ready.externalId} did not become merge-ready`);
        }
        observed = ready;
      }
      const observedChecks = await this.checkCi(request, observed);
      const unsatisfied = unsatisfiedRequiredChecks(
        validation.requiredChecks,
        observedChecks.checks ?? [],
      );
      if (unsatisfied.length > 0) {
        throw new Error(
          `Automatic merge requires a passing check for every required context on ${request.baseBranch}; ` +
            `unsatisfied after the pull request became ready: ${unsatisfied.join(", ")}`,
        );
      }
      evidence.push(
        `Required checks re-observed as passing before merge: ${validation.requiredChecks.join(", ")}`,
      );
      await this.#gh([
        "pr",
        "merge",
        observed.externalId,
        "--repo",
        request.repository,
        "--squash",
        "--match-head-commit",
        request.headSha,
      ]);
      const merged = await this.inspectPullRequest(request.repository, observed.externalId);
      if (!merged) {
        throw new Error(`Pull request ${observed.externalId} disappeared after automatic merge`);
      }
      assertPullRequestIdentity(request, merged);
      observed = merged;
    }
    if (observed.state !== "merged" || observed.draft) {
      throw new Error(`Pull request ${observed.externalId} was not merged exactly as verified`);
    }

    const taskCompleted = await this.#completeIssue(request.repository, request.sourceId);
    return {
      pullRequest: observed,
      taskCompleted,
      evidence: [
        ...evidence,
        `Merged pull request ${observed.externalId} at verified head ${observed.headSha}`,
        `Completed task issue #${request.sourceId}`,
      ],
    };
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

  async #completeIssue(repository: string, sourceId: string): Promise<boolean> {
    if (!/^[1-9][0-9]*$/.test(sourceId)) {
      throw new Error(`GitHub automatic merge requires a numeric issue source id: ${sourceId}`);
    }
    const endpoint = `repos/${repository}/issues/${sourceId}`;
    const current = parseIssue(await this.#gh([
      "api",
      endpoint,
      "--header",
      "X-GitHub-Api-Version: 2026-03-10",
    ]));
    if (current.number !== Number(sourceId)) {
      throw new Error(`GitHub returned a different task issue for #${sourceId}`);
    }
    if (current.state === "closed" && current.stateReason === "completed") {
      return true;
    }
    if (current.state === "closed") {
      throw new Error(`Task issue #${sourceId} is closed as ${current.stateReason ?? "unknown"}`);
    }
    const completed = parseIssue(await this.#gh([
      "api",
      "--method",
      "PATCH",
      endpoint,
      "-f",
      "state=closed",
      "-f",
      "state_reason=completed",
      "--header",
      "X-GitHub-Api-Version: 2026-03-10",
    ]));
    return completed.number === Number(sourceId) &&
      completed.state === "closed" &&
      completed.stateReason === "completed";
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

export function unsatisfiedRequiredChecks(
  requiredChecks: string[],
  observed: CiCheck[],
): string[] {
  const buckets = new Map<string, CiCheckBucket>();
  for (const check of observed) {
    const existing = buckets.get(check.name);
    if (existing === undefined || existing === "pass") {
      buckets.set(check.name, check.bucket);
    }
  }
  return requiredChecks
    .filter((context) => buckets.get(context) !== "pass")
    .map((context) => `${context} (${buckets.get(context) ?? "not reported"})`);
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
      state: "open" as const,
    };
  });
}

export function parsePullRequest(source: string): PullRequestSnapshot {
  const value = JSON.parse(source) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub pull-request response must be an object");
  }
  const raw = value as RawApiPullRequest;
  const head = nestedRef(raw.head, "pullRequest.head");
  const base = nestedRef(raw.base, "pullRequest.base");
  const state = stringValue(raw.state, "pullRequest.state");
  const merged = typeof raw.merged_at === "string" && raw.merged_at.trim() !== "";
  if (!merged && state !== "open" && state !== "closed") {
    throw new Error(`Unsupported GitHub pull-request state: ${state}`);
  }
  const normalizedState: PullRequestSnapshot["state"] = merged
    ? "merged"
    : state as "open" | "closed";
  return {
    externalId: String(positiveInteger(raw.number, "pullRequest.number")),
    url: stringValue(raw.html_url, "pullRequest.html_url"),
    draft: booleanValue(raw.draft, "pullRequest.draft"),
    branchName: head.ref,
    baseBranch: base.ref,
    headSha: head.sha,
    state: normalizedState,
  };
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
      bucket: bucket as CiCheckBucket,
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
    checks: checks.map((check): CiCheck => ({ name: check.name, bucket: check.bucket })),
  };
}

export function parseBranchProtection(source: string): {
  strict: boolean;
  requiredChecks: string[];
  enforceAdmins: boolean;
} {
  const value = JSON.parse(source) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub branch-protection response must be an object");
  }
  const raw = value as RawBranchProtection;
  if (
    typeof raw.required_status_checks !== "object" ||
    raw.required_status_checks === null ||
    Array.isArray(raw.required_status_checks)
  ) {
    throw new Error("GitHub branch protection has no required status checks");
  }
  const required = raw.required_status_checks as {
    strict?: unknown;
    checks?: unknown;
    contexts?: unknown;
  };
  const names: string[] = [];
  if (Array.isArray(required.checks)) {
    for (const [index, entry] of required.checks.entries()) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error(`required_status_checks.checks[${index}] must be an object`);
      }
      const context = (entry as { context?: unknown }).context;
      names.push(stringValue(context, `required_status_checks.checks[${index}].context`));
    }
  } else if (Array.isArray(required.contexts)) {
    names.push(...required.contexts.map((entry, index) =>
      stringValue(entry, `required_status_checks.contexts[${index}]`)
    ));
  }
  return {
    strict: booleanValue(required.strict, "required_status_checks.strict"),
    requiredChecks: [...new Set(names)].sort(),
    enforceAdmins: parseEnforceAdmins(raw.enforce_admins),
  };
}

function parseEnforceAdmins(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub branch protection enforce_admins must be an object");
  }
  return booleanValue((value as { enabled?: unknown }).enabled, "enforce_admins.enabled");
}

export function parseIssue(source: string): {
  number: number;
  state: "open" | "closed";
  stateReason: string | null;
} {
  const value = JSON.parse(source) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub issue response must be an object");
  }
  const raw = value as RawIssue;
  if (raw.pull_request !== undefined) {
    throw new Error("GitHub task source points to a pull request, not an issue");
  }
  const state = stringValue(raw.state, "issue.state");
  if (state !== "open" && state !== "closed") {
    throw new Error(`Unsupported GitHub issue state: ${state}`);
  }
  return {
    number: positiveInteger(raw.number, "issue.number"),
    state,
    stateReason: raw.state_reason === null || raw.state_reason === undefined
      ? null
      : stringValue(raw.state_reason, "issue.state_reason"),
  };
}

function validateRequest(request: DraftPullRequestRequest): void {
  validateRepository(request.repository);
  validateBranch(request.branchName, "branchName");
  validateBranch(request.baseBranch, "baseBranch");
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

function validateBranch(branch: string, path: string): void {
  if (!BRANCH.test(branch) || branch.includes("..") || branch.startsWith("-")) {
    throw new Error(`Unsafe GitHub ${path}: ${branch}`);
  }
}

function assertPullRequestIdentity(
  request: DraftPullRequestRequest,
  pullRequest: PullRequestSnapshot,
): void {
  if (
    pullRequest.externalId.trim() === "" ||
    pullRequest.url.trim() === "" ||
    pullRequest.branchName !== request.branchName ||
    pullRequest.baseBranch !== request.baseBranch ||
    pullRequest.headSha !== request.headSha
  ) {
    throw new Error("Pull request identity or head changed before automatic merge");
  }
}

function validateIdentity(repository: string, externalId: string): void {
  validateRepository(repository);
  if (!/^[1-9][0-9]*$/.test(externalId)) {
    throw new Error(`GitHub pull-request id must be a positive integer: ${externalId}`);
  }
}

function validateRepository(repository: string): void {
  if (!REPOSITORY.test(repository)) {
    throw new Error(`GitHub repository must be owner/name: ${repository}`);
  }
}

function nestedRef(value: unknown, path: string): { ref: string; sha: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const record = value as { ref?: unknown; sha?: unknown };
  return {
    ref: stringValue(record.ref, `${path}.ref`),
    sha: stringValue(record.sha, `${path}.sha`),
  };
}

function samePullRequest(left: PullRequestSnapshot, right: PullRequestSnapshot): boolean {
  return left.externalId === right.externalId &&
    left.url === right.url &&
    left.branchName === right.branchName &&
    left.baseBranch === right.baseBranch &&
    left.headSha === right.headSha &&
    left.draft === right.draft &&
    left.state === right.state;
}

function isGitHubNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return false;
  }
  const failure = error as { code?: unknown; stderr?: unknown };
  return failure.code === 1 &&
    typeof failure.stderr === "string" &&
    /\(HTTP 404\)\s*$/u.test(failure.stderr);
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
