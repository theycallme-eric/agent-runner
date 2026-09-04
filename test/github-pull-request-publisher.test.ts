import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DraftPullRequestRequest } from "../src/delivery/types.js";
import {
  GitHubPullRequestPublisher,
  parseBranchProtection,
  parseCheckRuns,
  parseChecks,
  parseIssue,
  parsePullRequest,
  parsePullRequests,
  recoverChecksOutput,
} from "../src/github/pull-request-publisher.js";

test("normalizes draft pull requests and required check buckets", () => {
  const pullRequests = parsePullRequests(JSON.stringify([
    {
      number: 42,
      url: "https://github.com/example/repo/pull/42",
      isDraft: true,
      headRefName: "agent-runner/task-42",
      baseRefName: "main",
      headRefOid: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    },
  ]));
  assert.deepEqual(pullRequests, [{
    externalId: "42",
    url: "https://github.com/example/repo/pull/42",
    draft: true,
    branchName: "agent-runner/task-42",
    baseBranch: "main",
    headSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    state: "open",
  }]);

  assert.equal(parsePullRequest(JSON.stringify({
    number: 42,
    html_url: "https://github.com/example/repo/pull/42",
    draft: true,
    state: "closed",
    merged_at: "2026-08-31T00:00:00Z",
    head: { ref: "agent-runner/task-42", sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" },
    base: { ref: "main", sha: "base-a" },
  })).state, "merged");

  assert.equal(parseChecks("[]").status, "none");
  assert.equal(parseChecks(JSON.stringify([{ name: "test", bucket: "pending", link: "" }])).status, "pending");
  assert.equal(parseChecks(JSON.stringify([{ name: "test", bucket: "pass", link: null }])).status, "passed");
  assert.equal(
    parseChecks(JSON.stringify([
      { name: "test", bucket: "pass", link: "" },
      { name: "lint", bucket: "fail", link: "https://example.invalid/check" },
    ])).status,
    "failed",
  );
});

test("distinguishes GitHub's no-checks response from other command failures", () => {
  assert.equal(
    recoverChecksOutput({
      code: 1,
      stdout: "",
      stderr: "no checks reported on the 'agent-runner/task-42' branch\n",
    }),
    "[]",
  );
  assert.equal(
    recoverChecksOutput({ code: 1, stdout: "", stderr: "authentication failed\n" }),
    null,
  );
  assert.equal(
    recoverChecksOutput({ code: 8, stdout: '[{"name":"test","bucket":"pending"}]', stderr: "" }),
    '[{"name":"test","bucket":"pending"}]',
  );
});

test("requires strict branch protection with named checks and a real issue source", () => {
  assert.deepEqual(parseBranchProtection(JSON.stringify({
    required_status_checks: {
      strict: true,
      checks: [{ context: "node-tests", app_id: 15368 }],
    },
  })), {
    strict: true,
    requiredChecks: [{ context: "node-tests", appId: 15368 }],
    enforceAdmins: false,
    requiredApprovingReviewCount: 0,
  });
  assert.deepEqual(parseBranchProtection(JSON.stringify({
    required_status_checks: { strict: true, contexts: ["node-tests"] },
  })).requiredChecks, [{ context: "node-tests", appId: null }]);
  assert.throws(
    () => parseBranchProtection(JSON.stringify({ required_status_checks: null })),
    /no required status checks/,
  );
  assert.deepEqual(parseIssue(JSON.stringify({
    number: 12,
    state: "closed",
    state_reason: "completed",
  })), { number: 12, state: "closed", stateReason: "completed" });
  assert.throws(
    () => parseIssue(JSON.stringify({
      number: 12,
      state: "open",
      state_reason: null,
      pull_request: { url: "https://api.github.com/pulls/12" },
    })),
    /not an issue/,
  );
});

test("pushes and reconciles the same GitHub draft pull request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-github-delivery-"));
  const gh = join(directory, "fake-gh");
  const git = join(directory, "fake-git");
  const pullRequestState = join(directory, "pull-request.json");
  const issueState = join(directory, "issue.json");
  const calls = join(directory, "calls.log");
  writeFileSync(gh, fakeGhScript(pullRequestState, issueState, calls));
  writeFileSync(git, fakeGitScript(calls));
  chmodSync(gh, 0o755);
  chmodSync(git, 0o755);
  const publisher = new GitHubPullRequestPublisher({ ghExecutable: gh, gitExecutable: git });
  const request = fixtureRequest(directory);

  try {
    const first = await publisher.publishDraft(request);
    const second = await publisher.publishDraft(request);
    const observed = await publisher.inspectPullRequest(request.repository, second.externalId);
    assert.ok(observed);
    const updated = await publisher.updateDraft(request, observed);
    const ci = await publisher.checkCi(request, second);
    const log = readFileSync(calls, "utf8");

    assert.equal(first.externalId, "7");
    assert.deepEqual(second, first);
    assert.deepEqual(updated, first);
    assert.equal(ci.status, "passed");
    assert.equal((log.match(/^gh create$/gm) ?? []).length, 1);
    assert.equal((log.match(/^gh edit$/gm) ?? []).length, 3);
    assert.equal((log.match(/^git push$/gm) ?? []).length, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("merges only the exact verified head on a protected branch and closes its task issue", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-github-auto-merge-"));
  const gh = join(directory, "fake-gh");
  const git = join(directory, "fake-git");
  const pullRequestState = join(directory, "pull-request.json");
  const issueState = join(directory, "issue.json");
  const calls = join(directory, "calls.log");
  writeFileSync(gh, fakeGhScript(pullRequestState, issueState, calls));
  writeFileSync(git, fakeGitScript(calls));
  chmodSync(gh, 0o755);
  chmodSync(git, 0o755);
  const publisher = new GitHubPullRequestPublisher({ ghExecutable: gh, gitExecutable: git });
  const request = fixtureRequest(directory, false);

  try {
    const draft = await publisher.publishDraft(request);
    const protection = await publisher.validateAutomaticMerge(
      request.repository,
      request.baseBranch,
    );
    const result = await publisher.mergeVerified(request, draft);
    assert.equal(result.outcome, "merged");
    if (result.outcome !== "merged") throw new Error("unreachable");
    const log = readFileSync(calls, "utf8");

    assert.deepEqual(protection.evidence, [
      "Protected base branch: main",
      "Required checks: node-tests (app 15368)",
      "Administrators cannot bypass required checks",
      "Required context node-tests has one static GitHub Actions producer in .github/workflows/project-verification.yml, triggered on pull_request opened and synchronize",
    ]);
    assert.deepEqual(protection.requiredChecks, [{ context: "node-tests", appId: NODE_TESTS_APP }]);
    assert.equal(result.pullRequest.state, "merged");
    assert.equal(result.pullRequest.draft, false);
    assert.equal(result.pullRequest.headSha, "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
    assert.equal(result.taskCompleted, true);
    assert.doesNotMatch(log, /^gh ready$/m);
    assert.match(log, /^gh merge a1b2c3d4e5f60718293a4b5c6d7e8f9012345678$/m);
    assert.match(log, /^gh close issue 1$/m);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("refuses automatic merge when strict required-check protection is absent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-github-unprotected-"));
  const gh = join(directory, "fake-gh");
  const git = join(directory, "fake-git");
  const calls = join(directory, "calls.log");
  writeFileSync(gh, fakeGhScript(
    join(directory, "pull-request.json"),
    join(directory, "issue.json"),
    calls,
    { strict: false },
  ));
  writeFileSync(git, fakeGitScript(calls));
  chmodSync(gh, 0o755);
  chmodSync(git, 0o755);
  const publisher = new GitHubPullRequestPublisher({ ghExecutable: gh, gitExecutable: git });

  try {
    await assert.rejects(
      publisher.validateAutomaticMerge("example/repo", "main"),
      /requires strict branch protection/,
    );
    assert.doesNotMatch(readFileSync(calls, "utf8"), /^gh merge/m);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("requires branch protection to bind administrators before automatic merge", async () => {
  const required = { strict: true, checks: [{ context: "node-tests", app_id: 15368 }] };
  assert.equal(
    parseBranchProtection(JSON.stringify({ required_status_checks: required })).enforceAdmins,
    false,
  );
  assert.equal(
    parseBranchProtection(JSON.stringify({
      required_status_checks: required,
      enforce_admins: { enabled: false },
    })).enforceAdmins,
    false,
  );
  assert.equal(
    parseBranchProtection(JSON.stringify({
      required_status_checks: required,
      enforce_admins: { enabled: true },
    })).enforceAdmins,
    true,
  );

  const absent = publisherFixture("agent-runner-github-admin-absent-", { enforceAdmins: null });
  const disabled = publisherFixture("agent-runner-github-admin-disabled-", { enforceAdmins: false });
  try {
    await assert.rejects(
      absent.publisher.validateAutomaticMerge("example/repo", "main"),
      /enforce_admins/,
    );
    await assert.rejects(
      disabled.publisher.validateAutomaticMerge("example/repo", "main"),
      /Do not allow bypassing the above settings/,
    );
    assert.doesNotMatch(absent.log(), /^gh merge/m);
    assert.doesNotMatch(disabled.log(), /^gh merge/m);
  } finally {
    absent.cleanup();
    disabled.cleanup();
  }
});

test("refuses required approving reviews in the unattended automatic lane", async () => {
  const fixture = publisherFixture("agent-runner-github-required-reviews-", {
    requiredApprovingReviewCount: 1,
  });
  try {
    await assert.rejects(
      fixture.publisher.validateAutomaticMerge("example/repo", "main"),
      /cannot satisfy 1 required approving review/,
    );
    assert.doesNotMatch(fixture.log(), /^gh merge/m);
  } finally {
    fixture.cleanup();
  }
});

test("refuses to merge unless every required context reported a passing check", async () => {
  const partial = publisherFixture("agent-runner-github-partial-checks-", {
    requiredChecks: [
      { context: "node-tests", appId: NODE_TESTS_APP },
      { context: "verify", appId: NODE_TESTS_APP },
    ],
    checkRuns: [checkRun({ name: "verify" })],
  });
  const skipped = publisherFixture("agent-runner-github-skipped-checks-", {
    checkRuns: [checkRun({ conclusion: "skipped" })],
  });
  const cancelled = publisherFixture("agent-runner-github-cancelled-checks-", {
    checkRuns: [checkRun({ conclusion: "cancelled" })],
  });
  try {
    const draft = await partial.publisher.publishDraft(partial.request);
    await assert.rejects(
      partial.publisher.mergeVerified(partial.request, draft),
      /node-tests/,
    );
    assert.doesNotMatch(partial.log(), /^gh merge/m);

    const skippedDraft = await skipped.publisher.publishDraft(skipped.request);
    await assert.rejects(
      skipped.publisher.mergeVerified(skipped.request, skippedDraft),
      /node-tests/,
    );
    assert.doesNotMatch(skipped.log(), /^gh merge/m);

    const cancelledDraft = await cancelled.publisher.publishDraft(cancelled.request);
    await assert.rejects(
      cancelled.publisher.mergeVerified(cancelled.request, cancelledDraft),
      /node-tests/,
    );
    assert.doesNotMatch(cancelled.log(), /^gh merge/m);
  } finally {
    partial.cleanup();
    skipped.cleanup();
    cancelled.cleanup();
  }
});

test("a conflicting exact-identity check row overrides a passing duplicate at final merge", async () => {
  const cases = [
    { bucket: "fail", status: "completed", conclusion: "failure" },
    { bucket: "cancel", status: "completed", conclusion: "cancelled" },
    { bucket: "pending", status: "in_progress", conclusion: null },
    { bucket: "skipping", status: "completed", conclusion: "skipped" },
  ] as const;
  for (const current of cases) {
    const fixture = publisherFixture(`agent-runner-github-conflicting-${current.bucket}-`, {
      checkRuns: [checkRun(), checkRun({ status: current.status, conclusion: current.conclusion })],
    });
    try {
      const readyPullRequest = await fixture.publisher.publishDraft(fixture.request);
      await assert.rejects(
        fixture.publisher.mergeVerified(fixture.request, readyPullRequest),
        new RegExp(`node-tests \\(${current.bucket}\\)`),
      );
      assert.doesNotMatch(fixture.log(), /^gh merge/m);
    } finally {
      fixture.cleanup();
    }
  }
});

test("observes exact required checks after creating a ready pull request and before merging", async () => {
  const fixture = publisherFixture("agent-runner-github-ready-checks-");
  try {
    const readyPullRequest = await fixture.publisher.publishDraft(fixture.request);
    assert.equal(readyPullRequest.draft, false);
    const result = await fixture.publisher.mergeVerified(fixture.request, readyPullRequest);
    if (result.outcome !== "merged") throw new Error("the merge pass did not merge");
    const lines = fixture.log().trimEnd().split("\n");
    const merge = lines.findIndex((line) => line.startsWith("gh merge"));
    const observed = lines.findIndex((line) => line === "gh check-runs");

    assert.equal(result.pullRequest.state, "merged");
    assert.doesNotMatch(fixture.log(), /^gh ready$/m);
    assert.ok(observed >= 0, "required checks were not observed");
    assert.ok(merge > observed, "the merge did not follow the post-ready check observation");
  } finally {
    fixture.cleanup();
  }
});

test("refuses to merge when required checks are still pending on a ready pull request", async () => {
  const fixture = publisherFixture("agent-runner-github-ready-pending-", {
    checkRuns: [checkRun({ status: "in_progress", conclusion: null })],
  });
  try {
    const draft = await fixture.publisher.publishDraft(fixture.request);
    await assert.rejects(
      fixture.publisher.mergeVerified(fixture.request, draft),
      /node-tests/,
    );
    assert.doesNotMatch(fixture.log(), /^gh merge/m);
  } finally {
    fixture.cleanup();
  }
});

test("reads the reporting application and head commit off every check run", () => {
  const parsed = parseCheckRuns(JSON.stringify({
    total_count: 2,
    check_runs: [
      {
        name: "node-tests",
        head_sha: VERIFIED_HEAD,
        status: "completed",
        conclusion: "success",
        app: { id: NODE_TESTS_APP },
      },
      { name: "lint", head_sha: VERIFIED_HEAD, status: "queued", conclusion: null, app: null },
    ],
  }));

  assert.equal(parsed.complete, true);
  assert.deepEqual(parsed.rows, [
    { name: "node-tests", bucket: "pass", appId: NODE_TESTS_APP, headSha: VERIFIED_HEAD },
    { name: "lint", bucket: "pending", appId: null, headSha: VERIFIED_HEAD },
  ]);
  assert.equal(
    parseCheckRuns(JSON.stringify({ total_count: 7, check_runs: [] })).complete,
    false,
  );
});

test("refuses automatic merge when a required context accepts a result from any application", async () => {
  const unpinned = publisherFixture("agent-runner-github-unpinned-context-", {
    requiredChecks: [
      { context: "node-tests", appId: NODE_TESTS_APP },
      { context: "legacy-status", appId: null },
    ],
  });
  try {
    await assert.rejects(
      unpinned.publisher.validateAutomaticMerge("example/repo", "main"),
      /legacy-status/,
    );
    await assert.rejects(
      unpinned.publisher.validateAutomaticMerge("example/repo", "main"),
      /specific GitHub App/,
    );
    assert.doesNotMatch(unpinned.log(), /^gh merge/m);
  } finally {
    unpinned.cleanup();
  }
});

test("a passing check from the wrong application cannot merge", async () => {
  const impostor = publisherFixture("agent-runner-github-wrong-app-", {
    checkRuns: [checkRun({ app: { id: 99 } })],
  });
  const anonymous = publisherFixture("agent-runner-github-no-app-", {
    checkRuns: [checkRun({ app: null })],
  });
  try {
    const draft = await impostor.publisher.publishDraft(impostor.request);
    await assert.rejects(
      impostor.publisher.mergeVerified(impostor.request, draft),
      /node-tests \(reported by application 99, not by required application 15368\)/,
    );
    assert.doesNotMatch(impostor.log(), /^gh merge/m);

    const anonymousDraft = await anonymous.publisher.publishDraft(anonymous.request);
    await assert.rejects(
      anonymous.publisher.mergeVerified(anonymous.request, anonymousDraft),
      /node-tests \(reported by an unidentified source/,
    );
    assert.doesNotMatch(anonymous.log(), /^gh merge/m);
  } finally {
    impostor.cleanup();
    anonymous.cleanup();
  }
});

test("a passing check from the right application on another head cannot merge", async () => {
  const stale = publisherFixture("agent-runner-github-wrong-head-", {
    checkRuns: [checkRun({ head_sha: "9".repeat(40) })],
  });
  try {
    const draft = await stale.publisher.publishDraft(stale.request);
    await assert.rejects(
      stale.publisher.mergeVerified(stale.request, draft),
      /not on the verified head/,
    );
    assert.doesNotMatch(stale.log(), /^gh merge/m);
  } finally {
    stale.cleanup();
  }
});

test("an incomplete check-run listing cannot prove a required context", async () => {
  const truncated = publisherFixture("agent-runner-github-truncated-checks-", {
    checkRunTotal: 250,
  });
  try {
    const draft = await truncated.publisher.publishDraft(truncated.request);
    await assert.rejects(
      truncated.publisher.mergeVerified(truncated.request, draft),
      /unverifiable/,
    );
    assert.doesNotMatch(truncated.log(), /^gh merge/m);
  } finally {
    truncated.cleanup();
  }
});

test("a pending exact-head check cannot authorize merge but a later pass can", async () => {
  const fixture = publisherFixture("agent-runner-github-pending-then-pass-", {
    checkRunSequence: [
      [checkRun({ status: "queued", conclusion: null })],
      [checkRun()],
    ],
  });
  try {
    const draft = await fixture.publisher.publishDraft(fixture.request);

    await assert.rejects(
      fixture.publisher.mergeVerified(fixture.request, draft),
      /node-tests \(pending\)/,
    );
    assert.doesNotMatch(fixture.log(), /^gh merge/m);

    const merged = await fixture.publisher.mergeVerified(fixture.request, draft);
    assert.equal(merged.outcome, "merged");
    assert.match(fixture.log(), /^gh merge /m);
    assert.doesNotMatch(fixture.log(), /^gh ready$/m);
  } finally {
    fixture.cleanup();
  }
});

test("an already passing pull-request check reaches the merge without a settle timer", async () => {
  const fixture = publisherFixture("agent-runner-github-no-settle-timer-", {});
  try {
    const draft = await fixture.publisher.publishDraft(fixture.request);

    const merged = await fixture.publisher.mergeVerified(fixture.request, draft);

    assert.equal(merged.outcome, "merged");
    if (merged.outcome !== "merged") throw new Error("unreachable");
    assert.equal(merged.taskCompleted, true);
    assert.match(fixture.log(), /^gh merge /m);
    assert.doesNotMatch(fixture.log(), /^gh ready$/m);
  } finally {
    fixture.cleanup();
  }
});

function fixtureRequest(directory: string, draft = true): DraftPullRequestRequest {
  return {
    repository: "example/repo",
    repositoryPath: directory,
    workspacePath: directory,
    runId: "run-1",
    taskId: "TASK-01",
    sourceId: "1",
    branchName: "agent-runner/task-01-a1-run",
    baseBranch: "main",
    baseSha: "base-a",
    headSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    title: "Implement fixture",
    body: "Fixture body",
    draft,
  };
}

interface FakeCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  app: { id: number } | null;
}

interface FakeGhOptions {
  strict?: boolean;
  enforceAdmins?: boolean | null;
  requiredChecks?: Array<{ context: string; appId: number | null }>;
  checks?: Array<{ name: string; bucket: string; link: string }>;
  checksBeforeReady?: Array<{ name: string; bucket: string; link: string }>;
  checkRuns?: FakeCheckRun[];
  checkRunsBeforeReady?: FakeCheckRun[];
  checkRunSequence?: FakeCheckRun[][];
  checkRunTotal?: number;
  workflowSource?: string;
  requiredApprovingReviewCount?: number;
}

const NODE_TESTS_APP = 15368;
const VERIFIED_HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

function checkRun(overrides: Partial<FakeCheckRun> = {}): FakeCheckRun {
  return {
    name: "node-tests",
    status: "completed",
    conclusion: "success",
    head_sha: VERIFIED_HEAD,
    app: { id: NODE_TESTS_APP },
    ...overrides,
  };
}

function fakeGhScript(
  statePath: string,
  issueStatePath: string,
  callsPath: string,
  options: FakeGhOptions = {},
): string {
  const settings = {
    strict: options.strict ?? true,
    enforceAdmins: options.enforceAdmins === undefined ? true : options.enforceAdmins,
    requiredChecks: options.requiredChecks ?? [{ context: "node-tests", appId: NODE_TESTS_APP }],
    checks: options.checks ?? [{ name: "node-tests", bucket: "pass", link: "" }],
    checksBeforeReady: options.checksBeforeReady ?? null,
    checkRuns: options.checkRuns ?? [checkRun()],
    checkRunsBeforeReady: options.checkRunsBeforeReady ?? null,
    checkRunSequence: options.checkRunSequence ?? null,
    checkRunTotal: options.checkRunTotal ?? null,
    workflowSource: options.workflowSource ?? null,
    requiredApprovingReviewCount: options.requiredApprovingReviewCount ?? 0,
  };
  return `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
const issueStatePath = ${JSON.stringify(issueStatePath)};
const callsPath = ${JSON.stringify(callsPath)};
const settings = ${JSON.stringify(settings)};
const append = value => fs.appendFileSync(callsPath, value + "\\n");
const calls = () => fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8") : "";
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : "[]");
} else if (args[0] === "pr" && args[1] === "create") {
  append("gh create");
  const head = args[args.indexOf("--head") + 1];
  const base = args[args.indexOf("--base") + 1];
  fs.writeFileSync(statePath, JSON.stringify([{
    number: 7,
    url: "https://github.com/example/repo/pull/7",
    isDraft: args.includes("--draft"),
    state: "open",
    mergedAt: null,
    headRefName: head,
    baseRefName: base,
    headRefOid: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
  }]));
  process.stdout.write("https://github.com/example/repo/pull/7\\n");
} else if (args[0] === "pr" && args[1] === "edit") {
  append("gh edit");
} else if (args[0] === "pr" && args[1] === "ready") {
  append("gh ready");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state[0].isDraft = false;
  fs.writeFileSync(statePath, JSON.stringify(state));
} else if (args[0] === "pr" && args[1] === "merge") {
  const head = args[args.indexOf("--match-head-commit") + 1];
  append("gh merge " + head);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state[0].state = "closed";
  state[0].mergedAt = "2026-09-03T00:00:00Z";
  fs.writeFileSync(statePath, JSON.stringify(state));
} else if (args[0] === "pr" && args[1] === "checks") {
  const readyAlready = /^gh ready$/m.test(calls());
  append("gh checks");
  const rows = settings.checksBeforeReady !== null && !readyAlready
    ? settings.checksBeforeReady
    : settings.checks;
  process.stdout.write(JSON.stringify(rows));
} else if (args[0] === "api") {
  const endpoint = args.find(value => value.startsWith("repos/"));
  if (endpoint && endpoint.includes("/check-runs")) {
    const readyAlready = /^gh ready$/m.test(calls());
    const observations = calls().split("\\n").filter(line => line === "gh check-runs").length;
    append("gh check-runs");
    const sequence = settings.checkRunSequence;
    const runs = sequence !== null
      ? sequence[Math.min(observations, sequence.length - 1)]
      : settings.checkRunsBeforeReady !== null && !readyAlready
        ? settings.checkRunsBeforeReady
        : settings.checkRuns;
    process.stdout.write(JSON.stringify({
      total_count: settings.checkRunTotal === null ? runs.length : settings.checkRunTotal,
      check_runs: runs
    }));
  } else if (endpoint && endpoint.endsWith("/protection")) {
    append("gh protection");
    const protection = {
      required_status_checks: {
        strict: settings.strict,
        checks: settings.requiredChecks.map(entry => (
          entry.appId === null
            ? { context: entry.context }
            : { context: entry.context, app_id: entry.appId }
        ))
      }
    };
    protection.required_pull_request_reviews = settings.requiredApprovingReviewCount === 0
      ? null
      : { required_approving_review_count: settings.requiredApprovingReviewCount };
    if (settings.enforceAdmins !== null) {
      protection.enforce_admins = { enabled: settings.enforceAdmins };
    }
    process.stdout.write(JSON.stringify(protection));
  } else if (endpoint && endpoint.includes("/.github/workflows?ref=")) {
    append("gh workflow directory");
    process.stdout.write(JSON.stringify([{
      path: ".github/workflows/project-verification.yml",
      type: "file"
    }]));
  } else if (endpoint && endpoint.includes("/.github/workflows/")) {
    append("gh workflow source");
    const jobs = settings.requiredChecks.map((entry, index) =>
      "  check_" + index + ":\\n" +
      "    name: " + JSON.stringify(entry.context) + "\\n" +
      "    runs-on: ubuntu-latest\\n" +
      "    steps:\\n" +
      "      - run: npm test\\n"
    ).join("");
    process.stdout.write(settings.workflowSource ?? "on: pull_request\\njobs:\\n" + jobs);
  } else if (endpoint && endpoint.includes("/issues/")) {
    const issue = fs.existsSync(issueStatePath)
      ? JSON.parse(fs.readFileSync(issueStatePath, "utf8"))
      : { number: 1, state: "open", state_reason: null };
    if (args.includes("PATCH")) {
      issue.state = "closed";
      issue.state_reason = "completed";
      fs.writeFileSync(issueStatePath, JSON.stringify(issue));
      append("gh close issue 1");
    } else {
      append("gh inspect issue 1");
    }
    process.stdout.write(JSON.stringify(issue));
  } else {
    append("gh inspect");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"))[0];
    process.stdout.write(JSON.stringify({
      number: state.number,
      html_url: state.url,
      draft: state.isDraft,
      state: state.state,
      merged_at: state.mergedAt,
      head: { ref: state.headRefName, sha: state.headRefOid },
      base: { ref: state.baseRefName, sha: "base-a" }
    }));
  }
} else {
  process.stderr.write("unexpected gh arguments: " + JSON.stringify(args));
  process.exit(2);
}
`;
}

interface PublisherFixture {
  publisher: GitHubPullRequestPublisher;
  request: DraftPullRequestRequest;
  log(): string;
  cleanup(): void;
}

function publisherFixture(prefix: string, options: FakeGhOptions = {}): PublisherFixture {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const gh = join(directory, "fake-gh");
  const git = join(directory, "fake-git");
  const calls = join(directory, "calls.log");
  writeFileSync(
    gh,
    fakeGhScript(
      join(directory, "pull-request.json"),
      join(directory, "issue.json"),
      calls,
      options,
    ),
  );
  writeFileSync(git, fakeGitScript(calls));
  chmodSync(gh, 0o755);
  chmodSync(git, 0o755);
  return {
    publisher: new GitHubPullRequestPublisher({ ghExecutable: gh, gitExecutable: git }),
    request: fixtureRequest(directory, false),
    log: () => (existsSync(calls) ? readFileSync(calls, "utf8") : ""),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function fakeGitScript(callsPath: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const callsPath = ${JSON.stringify(callsPath)};
if (args[0] === "rev-parse" && args[1] === "HEAD") {
  process.stdout.write("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\\n");
} else if (args[0] === "push") {
  fs.appendFileSync(callsPath, "git push\\n");
} else {
  process.stderr.write("unexpected git arguments: " + JSON.stringify(args));
  process.exit(2);
}
`;
}
