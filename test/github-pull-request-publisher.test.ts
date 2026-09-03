import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DraftPullRequestRequest } from "../src/delivery/types.js";
import {
  GitHubPullRequestPublisher,
  parseBranchProtection,
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
      headRefOid: "head-a",
    },
  ]));
  assert.deepEqual(pullRequests, [{
    externalId: "42",
    url: "https://github.com/example/repo/pull/42",
    draft: true,
    branchName: "agent-runner/task-42",
    baseBranch: "main",
    headSha: "head-a",
    state: "open",
  }]);

  assert.equal(parsePullRequest(JSON.stringify({
    number: 42,
    html_url: "https://github.com/example/repo/pull/42",
    draft: true,
    state: "closed",
    merged_at: "2026-08-31T00:00:00Z",
    head: { ref: "agent-runner/task-42", sha: "head-a" },
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
  })), { strict: true, requiredChecks: ["node-tests"], enforceAdmins: false });
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
  const request = fixtureRequest(directory);

  try {
    const draft = await publisher.publishDraft(request);
    const protection = await publisher.validateAutomaticMerge(
      request.repository,
      request.baseBranch,
    );
    const result = await publisher.mergeVerified(request, draft);
    const log = readFileSync(calls, "utf8");

    assert.deepEqual(protection.evidence, [
      "Protected base branch: main",
      "Required checks: node-tests",
      "Administrators cannot bypass required checks",
    ]);
    assert.deepEqual(protection.requiredChecks, ["node-tests"]);
    assert.equal(result.pullRequest.state, "merged");
    assert.equal(result.pullRequest.draft, false);
    assert.equal(result.pullRequest.headSha, "head-a");
    assert.equal(result.taskCompleted, true);
    assert.match(log, /^gh ready$/m);
    assert.match(log, /^gh merge head-a$/m);
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

test("refuses to merge unless every required context reported a passing check", async () => {
  const partial = publisherFixture("agent-runner-github-partial-checks-", {
    requiredContexts: ["node-tests", "verify"],
    checks: [{ name: "verify", bucket: "pass", link: "" }],
  });
  const skipped = publisherFixture("agent-runner-github-skipped-checks-", {
    checks: [{ name: "node-tests", bucket: "skipping", link: "" }],
  });
  const cancelled = publisherFixture("agent-runner-github-cancelled-checks-", {
    checks: [{ name: "node-tests", bucket: "cancel", link: "" }],
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

test("re-observes required checks after the draft becomes ready and before merging", async () => {
  const fixture = publisherFixture("agent-runner-github-post-ready-checks-", {
    checksBeforeReady: [],
  });
  try {
    const draft = await fixture.publisher.publishDraft(fixture.request);
    const beforeReady = await fixture.publisher.checkCi(fixture.request, draft);
    const result = await fixture.publisher.mergeVerified(fixture.request, draft);
    const lines = fixture.log().trimEnd().split("\n");
    const ready = lines.indexOf("gh ready");
    const merge = lines.findIndex((line) => line.startsWith("gh merge"));
    const observed = lines.findIndex((line, index) => line === "gh checks" && index > ready);

    assert.equal(beforeReady.status, "none");
    assert.equal(result.pullRequest.state, "merged");
    assert.ok(ready >= 0, "the draft was never marked ready");
    assert.ok(observed > ready, "required checks were not re-observed after the draft became ready");
    assert.ok(merge > observed, "the merge did not follow the post-ready check observation");
  } finally {
    fixture.cleanup();
  }
});

test("refuses to merge when required checks are still pending after the draft becomes ready", async () => {
  const fixture = publisherFixture("agent-runner-github-post-ready-pending-", {
    checksBeforeReady: [],
    checks: [{ name: "node-tests", bucket: "pending", link: "" }],
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

function fixtureRequest(directory: string): DraftPullRequestRequest {
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
    headSha: "head-a",
    title: "Implement fixture",
    body: "Fixture body",
  };
}

interface FakeGhOptions {
  strict?: boolean;
  enforceAdmins?: boolean | null;
  requiredContexts?: string[];
  checks?: Array<{ name: string; bucket: string; link: string }>;
  checksBeforeReady?: Array<{ name: string; bucket: string; link: string }>;
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
    requiredContexts: options.requiredContexts ?? ["node-tests"],
    checks: options.checks ?? [{ name: "node-tests", bucket: "pass", link: "" }],
    checksBeforeReady: options.checksBeforeReady ?? null,
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
    isDraft: true,
    state: "open",
    mergedAt: null,
    headRefName: head,
    baseRefName: base,
    headRefOid: "head-a"
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
  if (endpoint && endpoint.endsWith("/protection")) {
    append("gh protection");
    const protection = {
      required_status_checks: {
        strict: settings.strict,
        checks: settings.requiredContexts.map(context => ({ context, app_id: 15368 }))
      }
    };
    if (settings.enforceAdmins !== null) {
      protection.enforce_admins = { enabled: settings.enforceAdmins };
    }
    process.stdout.write(JSON.stringify(protection));
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
    request: fixtureRequest(directory),
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
  process.stdout.write("head-a\\n");
} else if (args[0] === "push") {
  fs.appendFileSync(callsPath, "git push\\n");
} else {
  process.stderr.write("unexpected git arguments: " + JSON.stringify(args));
  process.exit(2);
}
`;
}
