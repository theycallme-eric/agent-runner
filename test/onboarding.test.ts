import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProjectRepository, onboardProject } from "../src/projects/onboarding.js";
import { ProjectRegistryStore } from "../src/projects/registry.js";

test("onboards a repository from controller-owned configuration without modifying the product", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-onboard-"));
  const repository = join(directory, "product");
  const runner = join(directory, "project-workspace", "runner");
  const contractPath = join(runner, "project.yml");
  const canonicalDirectory = realpathSync(directory);
  mkdirSync(repository, { recursive: true });
  mkdirSync(runner, { recursive: true });
  git(repository, ["init", "--initial-branch=main"]);
  writeFileSync(contractPath, fixtureContract("fixture/onboard", "any-provider"));
  const registry = new ProjectRegistryStore();
  const before = git(repository, ["status", "--porcelain=v1"]);

  try {
    const result = await onboardProject(registry, {
      rootPath: repository,
      contractPath,
      workerProfile: "any-worker",
      now: 1_000,
    });

    assert.equal(result.created, true);
    assert.equal(result.project.id, "fixture/onboard");
    assert.equal(result.project.workerProfile, "any-worker");
    assert.equal(result.project.rootPath, join(canonicalDirectory, "product"));
    assert.equal(
      result.project.contractPath,
      join(canonicalDirectory, "project-workspace", "runner", "project.yml"),
    );
    assert.equal(git(repository, ["status", "--porcelain=v1"]), before);

    const inProductContract = join(repository, ".agent-runner.yml");
    writeFileSync(inProductContract, fixtureContract("fixture/onboard", "any-provider"));
    await assert.rejects(
      () => onboardProject(registry, {
        rootPath: repository,
        contractPath: inProductContract,
        workerProfile: "any-worker",
        now: 2_000,
      }),
      /outside the product repository/,
    );
  } finally {
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails registration when GitHub project identity disagrees with origin", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-onboard-remote-"));
  const repository = join(directory, "product");
  const runner = join(directory, "project-workspace", "runner");
  const contractPath = join(runner, "project.yml");
  mkdirSync(repository, { recursive: true });
  mkdirSync(runner, { recursive: true });
  git(repository, ["init", "--initial-branch=main"]);
  writeFileSync(contractPath, fixtureContract("example/intended-product", "github"));
  const registry = new ProjectRegistryStore();

  try {
    await assert.rejects(
      () => onboardProject(registry, {
        rootPath: repository,
        contractPath,
        workerProfile: "any-worker",
        now: 999,
      }),
      /requires a GitHub origin remote/,
    );
    git(repository, [
      "remote",
      "add",
      "origin",
      "https://github.com/example/different-product.git",
    ]);
    await assert.rejects(
      () => onboardProject(registry, {
        rootPath: repository,
        contractPath,
        workerProfile: "any-worker",
        now: 1_000,
      }),
      /does not match GitHub origin example\/different-product/,
    );
    assert.deepEqual(registry.list(), []);
  } finally {
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explicitly creates and idempotently registers an independent GitHub product repository", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-create-project-"));
  const repository = join(directory, "product");
  const runner = join(directory, "project-workspace", "runner");
  const contractPath = join(runner, "project.yml");
  const remote = join(directory, "remote.git");
  const gh = join(directory, "fake-gh");
  const log = join(directory, "gh.log");
  mkdirSync(runner, { recursive: true });
  writeFileSync(contractPath, fixtureContract("fixture/new-product", "github"));
  writeFileSync(gh, fakeGitHubExecutable(remote, log));
  chmodSync(gh, 0o755);
  const registry = new ProjectRegistryStore();

  try {
    const first = await createProjectRepository(registry, {
      rootPath: repository,
      contractPath,
      workerProfile: "any-worker",
      visibility: "private",
      confirmed: true,
      now: 1_000,
      ghExecutable: gh,
    });
    assert.equal(first.created, true);
    assert.equal(first.repositoryCreated, true);
    assert.equal(first.initialBranchPushed, true);
    assert.deepEqual(readdirSync(repository), [".git"]);
    assert.equal(git(repository, ["log", "-1", "--pretty=%s"]), "Initialize repository");
    assert.equal(
      git(repository, ["config", "--get", "remote.origin.url"]),
      "https://github.com/fixture/new-product.git",
    );

    const repeated = await createProjectRepository(registry, {
      rootPath: repository,
      contractPath,
      workerProfile: "any-worker",
      visibility: "private",
      confirmed: true,
      now: 2_000,
      ghExecutable: gh,
    });
    assert.equal(repeated.created, false);
    assert.equal(repeated.repositoryCreated, false);
    assert.equal(repeated.initialBranchPushed, false);
    assert.equal(readFileSync(log, "utf8"), "create\n");
  } finally {
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("repository creation requires confirmation and refuses non-empty non-repositories", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-create-project-reject-"));
  const repository = join(directory, "product");
  const runner = join(directory, "project-workspace", "runner");
  const contractPath = join(runner, "project.yml");
  mkdirSync(repository, { recursive: true });
  mkdirSync(runner, { recursive: true });
  writeFileSync(join(repository, "existing.txt"), "owner content\n");
  writeFileSync(contractPath, fixtureContract("fixture/rejected", "github"));
  const registry = new ProjectRegistryStore();

  try {
    await assert.rejects(
      () => createProjectRepository(registry, {
        rootPath: repository,
        contractPath,
        workerProfile: "any-worker",
        visibility: "private",
        confirmed: false,
        now: 1_000,
      }),
      /explicit --confirm-create authorization/,
    );
    await assert.rejects(
      () => createProjectRepository(registry, {
        rootPath: repository,
        contractPath,
        workerProfile: "any-worker",
        visibility: "private",
        confirmed: true,
        now: 1_000,
      }),
      /Refusing to initialize a non-empty product directory/,
    );
    assert.equal(readFileSync(join(repository, "existing.txt"), "utf8"), "owner content\n");
    assert.deepEqual(registry.list(), []);
  } finally {
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureContract(id: string, provider: string): string {
  return `version: 1
project: { id: ${id}, baseBranch: main }
tasks: { provider: ${provider}, dependencies: any-dag }
workspace: { setup: [] }
verification:
  required: [npm test]
  protectedPaths: []
execution: { concurrency: 1, attempts: 2, timeoutMinutes: 10 }
delivery: { provider: ${provider}, pullRequest: true, merge: never }
`;
}

function git(repository: string, args: string[]): string {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
  }).trim();
}

function fakeGitHubExecutable(remote: string, log: string): string {
  return `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "create") {
  const source = args[args.indexOf("--source") + 1];
  execFileSync("git", ["init", "--bare", ${JSON.stringify(remote)}]);
  const url = "https://github.com/fixture/new-product.git";
  execFileSync("git", ["-C", source, "remote", "add", "origin", url]);
  execFileSync("git", ["-C", source, "config", "url.file://${remote}.insteadOf", url]);
  appendFileSync(${JSON.stringify(log)}, "create\\n");
} else if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(JSON.stringify({
    nameWithOwner: "fixture/new-product",
    visibility: "PRIVATE"
  }));
} else {
  process.stderr.write("Unexpected gh arguments: " + args.join(" "));
  process.exitCode = 1;
}
`;
}
