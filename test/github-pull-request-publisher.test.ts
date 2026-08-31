import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DraftPullRequestRequest } from "../src/delivery/types.js";
import {
  GitHubPullRequestPublisher,
  parseChecks,
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
  }]);

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

test("pushes and reconciles the same GitHub draft pull request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-github-delivery-"));
  const gh = join(directory, "fake-gh");
  const git = join(directory, "fake-git");
  const pullRequestState = join(directory, "pull-request.json");
  const calls = join(directory, "calls.log");
  writeFileSync(gh, fakeGhScript(pullRequestState, calls));
  writeFileSync(git, fakeGitScript(calls));
  chmodSync(gh, 0o755);
  chmodSync(git, 0o755);
  const publisher = new GitHubPullRequestPublisher({ ghExecutable: gh, gitExecutable: git });
  const request = fixtureRequest(directory);

  try {
    const first = await publisher.publishDraft(request);
    const second = await publisher.publishDraft(request);
    const ci = await publisher.checkCi(request, second);
    const log = readFileSync(calls, "utf8");

    assert.equal(first.externalId, "7");
    assert.deepEqual(second, first);
    assert.equal(ci.status, "passed");
    assert.equal((log.match(/^gh create$/gm) ?? []).length, 1);
    assert.equal((log.match(/^gh edit$/gm) ?? []).length, 2);
    assert.equal((log.match(/^git push$/gm) ?? []).length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
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

function fakeGhScript(statePath: string, callsPath: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
const callsPath = ${JSON.stringify(callsPath)};
const append = value => fs.appendFileSync(callsPath, value + "\\n");
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
    headRefName: head,
    baseRefName: base,
    headRefOid: "head-a"
  }]));
  process.stdout.write("https://github.com/example/repo/pull/7\\n");
} else if (args[0] === "pr" && args[1] === "edit") {
  append("gh edit");
} else if (args[0] === "pr" && args[1] === "checks") {
  append("gh checks");
  process.stdout.write(JSON.stringify([{ name: "verify", bucket: "pass", link: "" }]));
} else {
  process.stderr.write("unexpected gh arguments: " + JSON.stringify(args));
  process.exit(2);
}
`;
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
