import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("run-once joins GitHub discovery, isolated execution, verification, and draft delivery", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-run-once-"));
  const remote = join(directory, "remote.git");
  const project = join(directory, "project");
  const runner = join(directory, "project-workspace", "runner");
  const contract = join(runner, "project.yml");
  const state = join(directory, "state.sqlite");
  const workspaces = join(directory, "workspaces");
  const gh = join(directory, "fake-gh");
  const worker = join(directory, "fake-worker");
  const profiles = join(directory, "workers.yml");
  const pullRequestState = join(directory, "pull-request.json");
  const callLog = join(directory, "calls.log");
  const cli = resolve("dist/src/cli.js");
  mkdirSync(project);
  mkdirSync(runner, { recursive: true });

  try {
    git(directory, ["init", "--bare", remote]);
    git(project, ["init", "--initial-branch=main"]);
    git(project, ["config", "user.name", "Fixture"]);
    git(project, ["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(contract, projectContract());
    writeFileSync(join(project, "README.md"), "run-once fixture\n");
    git(project, ["add", "README.md"]);
    git(project, ["commit", "-m", "Fixture base"]);
    git(project, [
      "config",
      `url.file://${remote}.insteadOf`,
      "https://github.com/fixture/run-once.git",
    ]);
    git(project, [
      "remote",
      "add",
      "origin",
      "https://github.com/fixture/run-once.git",
    ]);
    git(project, ["push", "-u", "origin", "main"]);

    writeFileSync(worker, fakeWorkerScript());
    writeFileSync(gh, fakeGhScript(remote, pullRequestState, callLog));
    chmodSync(worker, 0o755);
    chmodSync(gh, 0o755);
    writeFileSync(profiles, `version: 1
profiles:
  fixture-worker:
    adapter: json-process
    name: fixture-agent
    executable: ${worker}
`);

    cliJson(cli, [
      "register",
      project,
      "--contract",
      contract,
      "--worker",
      "fixture-worker",
      "--state",
      state,
    ]);
    const environment = { ...process.env, AGENT_RUNNER_GH_BIN: gh };
    const common = [
      "fixture/run-once",
      "--state",
      state,
      "--profiles",
      profiles,
      "--workspace-root",
      workspaces,
      "--controller",
      "fixture-controller",
      "--lease-seconds",
      "60",
      "--limit",
      "1",
      "--task",
      "issue-1",
    ];
    const dryRun = cliJson(cli, ["run-once", ...common, "--dry-run"], environment) as RunOnceOutput;

    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.dryRun, true);
    assert.deepEqual(dryRun.ready, [{ id: "issue-1", title: "Fixture implementation" }]);
    assert.deepEqual(dryRun.claimed, []);
    assert.equal(dryRun.limitReached, false);
    assert.equal(readFileIfExists(callLog), "");
    assert.equal(git(project, ["status", "--porcelain=v1"]), "");
    assert.throws(
      () => readFileSync(join(project, ".agent-runner.yml"), "utf8"),
      /ENOENT/,
    );

    const executed = cliJson(cli, ["run-once", ...common], environment) as RunOnceOutput;
    assert.equal(executed.ok, true);
    assert.equal(executed.claimed.length, 1);
    assert.equal(executed.claimed[0]?.state, "ci");
    assert.equal(executed.claimed[0]?.execution, "verified");
    assert.equal(executed.claimed[0]?.delivery, "waiting-ci");
    assert.equal(executed.claimed[0]?.pullRequestUrl, "https://github.com/fixture/run-once/pull/7");
    assert.equal(executed.claimed[0]?.ciStatus, "pending");

    const repeated = cliJson(cli, ["run-once", ...common], environment) as RunOnceOutput;
    assert.equal(repeated.ok, true);
    assert.deepEqual(repeated.claimed, []);
    assert.deepEqual(repeated.duplicateTaskIds, ["issue-1"]);
    assert.equal(repeated.reconciled.length, 1);
    assert.equal(repeated.reconciled[0]?.state, "completed");
    assert.equal(repeated.reconciled[0]?.execution, "not-run");
    assert.equal(repeated.reconciled[0]?.delivery, "completed");
    assert.equal(repeated.reconciled[0]?.ciStatus, "passed");
    const log = readFileSync(callLog, "utf8");
    assert.equal((log.match(/^pr-create$/gm) ?? []).length, 1);
    assert.equal((log.match(/^pr-edit$/gm) ?? []).length, 1);
    assert.equal((log.match(/^pr-checks$/gm) ?? []).length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface RunOnceOutput {
  ok: boolean;
  dryRun: boolean;
  ready: Array<{ id: string; title: string }>;
  claimed: Array<{
    state: string;
    execution: string;
    delivery: string;
    pullRequestUrl: string | null;
    ciStatus: string | null;
  }>;
  reconciled: Array<{
    state: string;
    execution: string;
    delivery: string;
    pullRequestUrl: string | null;
    ciStatus: string | null;
  }>;
  duplicateTaskIds: string[];
  limitReached: boolean;
}

function projectContract(): string {
  return `version: 1
project: { id: fixture/run-once, baseBranch: main }
tasks: { provider: github, dependencies: github-native }
workspace: { setup: [] }
verification:
  required:
    - test -f result.txt
    - git diff --check
  protectedPaths: []
execution: { concurrency: 1, attempts: 2, timeoutMinutes: 1 }
delivery: { provider: github, pullRequest: true, merge: never }
`;
}

function fakeWorkerScript(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  fs.writeFileSync("result.txt", "implemented by fixture worker\\n");
  process.stdout.write(JSON.stringify({
    status: request.protocolVersion === 1 ? "succeeded" : "failed",
    model: "fixture-model",
    sessionId: "fixture-session",
    summary: "fixture implemented",
    durationMs: 1
  }));
});
`;
}

function fakeGhScript(remote: string, state: string, log: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
const state = ${JSON.stringify(state)};
const log = ${JSON.stringify(log)};
const remote = ${JSON.stringify(remote)};
const append = value => fs.appendFileSync(log, value + "\\n");
if (args[0] === "api") {
  const endpoint = args[1];
  if (endpoint === "repos/fixture/run-once/issues") {
    process.stdout.write(JSON.stringify([[
      {
        number: 1,
        id: 101,
        node_id: "I_1",
        repository_url: "https://api.github.com/repos/fixture/run-once",
        title: "Fixture implementation",
        body: "Create result.txt.",
        state: "open",
        state_reason: null,
        updated_at: "2026-08-31T12:00:00Z",
        labels: [],
        html_url: "https://github.com/fixture/run-once/issues/1"
      }
    ]]));
  } else if (endpoint.endsWith("/dependencies/blocked_by")) {
    process.stdout.write("[[]]");
  } else if (endpoint === "repos/fixture/run-once/pulls/7") {
    const pull = JSON.parse(fs.readFileSync(state, "utf8"))[0];
    process.stdout.write(JSON.stringify({
      number: pull.number,
      html_url: pull.url,
      draft: pull.isDraft,
      state: "open",
      merged_at: null,
      head: { ref: pull.headRefName, sha: pull.headRefOid },
      base: { ref: pull.baseRefName, sha: "base-fixture" }
    }));
  } else {
    process.stderr.write("unexpected API endpoint: " + endpoint);
    process.exit(2);
  }
} else if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(fs.existsSync(state) ? fs.readFileSync(state, "utf8") : "[]");
} else if (args[0] === "pr" && args[1] === "create") {
  append("pr-create");
  const head = args[args.indexOf("--head") + 1];
  const base = args[args.indexOf("--base") + 1];
  const headSha = execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/" + head], { encoding: "utf8" }).trim();
  fs.writeFileSync(state, JSON.stringify([{
    number: 7,
    url: "https://github.com/fixture/run-once/pull/7",
    isDraft: true,
    headRefName: head,
    baseRefName: base,
    headRefOid: headSha
  }]));
  process.stdout.write("https://github.com/fixture/run-once/pull/7\\n");
} else if (args[0] === "pr" && args[1] === "edit") {
  append("pr-edit");
} else if (args[0] === "pr" && args[1] === "checks") {
  const previous = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  const checkCount = (previous.match(/^pr-checks$/gm) || []).length;
  append("pr-checks");
  process.stdout.write(JSON.stringify([{
    name: "fixture",
    bucket: checkCount === 0 ? "pending" : "pass",
    link: ""
  }]));
} else {
  process.stderr.write("unexpected gh arguments: " + JSON.stringify(args));
  process.exit(2);
}
`;
}

function cliJson(cli: string, argumentsList: string[], environment = process.env): unknown {
  return JSON.parse(execFileSync(process.execPath, [cli, ...argumentsList], {
    encoding: "utf8",
    env: environment,
  }));
}

function readFileIfExists(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function git(cwd: string, argumentsList: string[]): string {
  return execFileSync("git", argumentsList, { cwd, encoding: "utf8" }).trim();
}
