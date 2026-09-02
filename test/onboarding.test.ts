import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { onboardProject } from "../src/projects/onboarding.js";
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
