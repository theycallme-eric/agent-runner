import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { reconcileRequiredChecks } from "../delivery/required-checks.js";
import type {
  AutomaticMergeResult,
  AutomaticMergeValidation,
  CiCheck,
  CiCheckBucket,
  CiSnapshot,
  DraftPullRequestRequest,
  PullRequestPublisher,
  PullRequestSnapshot,
  RequiredCheck,
} from "../delivery/types.js";

const execFileAsync = promisify(execFile);
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_OUTPUT_BYTES = 5_000_000;
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;
const CHECK_RUN_PAGE_SIZE = 100;

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

interface RawCheckRun {
  name?: unknown;
  head_sha?: unknown;
  status?: unknown;
  conclusion?: unknown;
  app?: unknown;
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
        `Automatic merge requires enforce_admins on ${baseBranch}: enable ` +
          `"Do not allow bypassing the above settings" so branch protection binds ` +
          "every token that can merge, including administrators",
      );
    }
    const unpinned = protection.requiredChecks
      .filter((check) => check.appId === null)
      .map((check) => check.context);
    if (unpinned.length > 0) {
      throw new Error(
        `Automatic merge requires every required check on ${baseBranch} to be provided by a ` +
          "specific GitHub App, because an unpinned context accepts a result from any source. " +
          `Configure a reporting application for: ${unpinned.join(", ")}`,
      );
    }
    return {
      evidence: [
        `Protected base branch: ${baseBranch}`,
        `Required checks: ${describeRequiredChecks(protection.requiredChecks)}`,
        "Administrators cannot bypass required checks",
      ],
      requiredChecks: protection.requiredChecks,
    };
  }

  async observeRequiredChecks(
    request: DraftPullRequestRequest,
    requiredChecks: RequiredCheck[],
  ): Promise<CiSnapshot> {
    return (await this.#observeRequired(request, requiredChecks)).snapshot;
  }

  async #observeRequired(
    request: DraftPullRequestRequest,
    requiredChecks: RequiredCheck[],
  ): Promise<{ snapshot: CiSnapshot; unproven: string[] }> {
    validateRequest(request);
    if (!COMMIT_SHA.test(request.headSha)) {
      throw new Error(`Required checks need a commit head, received ${request.headSha}`);
    }
    const output = await this.#gh([
      "api",
      `repos/${request.repository}/commits/${request.headSha}/check-runs` +
        `?filter=latest&per_page=${CHECK_RUN_PAGE_SIZE}`,
      "--header",
      "X-GitHub-Api-Version: 2026-03-10",
    ]);
    const parsed = parseCheckRuns(output);
    return {
      snapshot: checkRunSnapshot(parsed, requiredChecks, request.headSha),
      unproven: unprovenRequiredChecks(parsed, requiredChecks, request.headSha),
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
        return {
          outcome: "waiting",
          pullRequest: ready,
          reason:
            "The pull request was marked ready for review during this pass. GitHub does not " +
            "guarantee that a ready_for_review workflow has registered when that request " +
            "returns, so required checks are re-observed on a later pass and no result read " +
            "before the transition can authorize the merge.",
          evidence: [
            ...evidence,
            `Marked pull request ${ready.externalId} ready for review at verified head ` +
              request.headSha,
          ],
        };
      }
      const observed_checks = await this.#observeRequired(request, validation.requiredChecks);
      const unsatisfied = observed_checks.unproven;
      if (unsatisfied.length > 0) {
        throw new Error(
          "Automatic merge requires a passing check from the configured application on the exact " +
            `verified head for every required context on ${request.baseBranch}; unsatisfied after ` +
            `the pull request became ready: ${unsatisfied.join(", ")}`,
        );
      }
      evidence.push(
        `Required checks proved on head ${request.headSha} before merge: ` +
          describeRequiredChecks(validation.requiredChecks),
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
      outcome: "merged",
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

export function describeRequiredChecks(requiredChecks: RequiredCheck[]): string {
  return requiredChecks
    .map((check) => `${check.context} (app ${check.appId ?? "unpinned"})`)
    .join(", ");
}

export function parseCheckRuns(source: string): { rows: CiCheck[]; complete: boolean } {
  const value = JSON.parse(source) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub check-run response must be an object");
  }
  const raw = value as { total_count?: unknown; check_runs?: unknown };
  if (!Array.isArray(raw.check_runs)) {
    throw new Error("GitHub check-run response must carry a check_runs array");
  }
  const rows = raw.check_runs.map((entry, index): CiCheck => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`check_runs[${index}] must be an object`);
    }
    const run = entry as RawCheckRun;
    return {
      name: stringValue(run.name, `check_runs[${index}].name`),
      bucket: checkRunBucket(run, index),
      appId: checkRunApplication(run.app, `check_runs[${index}].app`),
      headSha: stringValue(run.head_sha, `check_runs[${index}].head_sha`),
    };
  });
  const total = raw.total_count === undefined
    ? rows.length
    : positiveIntegerOrZero(raw.total_count, "total_count");
  return { rows, complete: total <= rows.length };
}

/**
 * Every required context this reading cannot prove, with the reason. An incomplete listing cannot
 * prove anything, because the check run that would contradict a pass may be on a page we never saw.
 */
export function unprovenRequiredChecks(
  parsed: { rows: CiCheck[]; complete: boolean },
  requiredChecks: RequiredCheck[],
  headSha: string,
): string[] {
  const reconciled = reconcileRequiredChecks(requiredChecks, parsed.rows, headSha);
  const unverifiable = parsed.complete
    ? []
    : reconciled.satisfied.map((context) =>
      `${context} (unverifiable: only ${parsed.rows.length} check runs were listed for ${headSha})`
    );
  return [...reconciled.failed, ...reconciled.waiting, ...unverifiable];
}

export function checkRunSnapshot(
  parsed: { rows: CiCheck[]; complete: boolean },
  requiredChecks: RequiredCheck[],
  headSha: string,
): CiSnapshot {
  const reconciled = reconcileRequiredChecks(requiredChecks, parsed.rows, headSha);
  const unproven = unprovenRequiredChecks(parsed, requiredChecks, headSha);
  const status: CiSnapshot["status"] = reconciled.failed.length > 0
    ? "failed"
    : unproven.length === 0
      ? "passed"
      : parsed.rows.length === 0
        ? "none"
        : "pending";
  return {
    status,
    evidence: [
      ...parsed.rows.map((row) =>
        `${row.name}: ${row.bucket} (app ${row.appId ?? "unidentified"}, head ${row.headSha ?? "unidentified"})`
      ),
      ...reconciled.satisfied
        .filter((context) => !unproven.some((entry) => entry.startsWith(`${context} (`)))
        .map((context) => `required ${context}: proved`),
      ...unproven.map((entry) => `required ${entry}: unproven`),
    ],
    checks: parsed.rows,
  };
}

function checkRunBucket(run: RawCheckRun, index: number): CiCheckBucket {
  const status = stringValue(run.status, `check_runs[${index}].status`);
  if (!["queued", "in_progress", "completed", "waiting", "requested", "pending"].includes(status)) {
    throw new Error(`Unsupported GitHub check-run status: ${status}`);
  }
  if (status !== "completed") {
    return "pending";
  }
  const conclusion = run.conclusion === null || run.conclusion === undefined
    ? "none"
    : stringValue(run.conclusion, `check_runs[${index}].conclusion`);
  switch (conclusion) {
    case "success":
      return "pass";
    case "cancelled":
      return "cancel";
    case "skipped":
    case "neutral":
      return "skipping";
    default:
      return "fail";
  }
}

function checkRunApplication(value: unknown, path: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const id = (value as { id?: unknown }).id;
  if (id === undefined || id === null) {
    return null;
  }
  if (!Number.isInteger(id) || (id as number) < 1) {
    throw new Error(`${path}.id must be a positive integer`);
  }
  return id as number;
}

function positiveIntegerOrZero(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  return value as number;
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
    checks: checks.map((check): CiCheck => ({
      name: check.name,
      bucket: check.bucket,
      appId: null,
      headSha: null,
    })),
  };
}

export function parseBranchProtection(source: string): {
  strict: boolean;
  requiredChecks: RequiredCheck[];
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
  const contexts = new Map<string, number | null>();
  if (Array.isArray(required.checks)) {
    for (const [index, entry] of required.checks.entries()) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error(`required_status_checks.checks[${index}] must be an object`);
      }
      const check = entry as { context?: unknown; app_id?: unknown };
      const context = stringValue(check.context, `required_status_checks.checks[${index}].context`);
      contexts.set(
        context,
        applicationId(check.app_id, `required_status_checks.checks[${index}].app_id`),
      );
    }
  } else if (Array.isArray(required.contexts)) {
    // The legacy contexts array names a context without pinning it to a reporting application.
    for (const [index, entry] of required.contexts.entries()) {
      contexts.set(stringValue(entry, `required_status_checks.contexts[${index}]`), null);
    }
  }
  return {
    strict: booleanValue(required.strict, "required_status_checks.strict"),
    requiredChecks: [...contexts.entries()]
      .map(([context, appId]) => ({ context, appId }))
      .sort((left, right) => left.context.localeCompare(right.context)),
    enforceAdmins: parseEnforceAdmins(raw.enforce_admins),
  };
}

function applicationId(value: unknown, path: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${path} must be a positive integer or null`);
  }
  return value as number;
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
