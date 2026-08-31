import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GitWorktreeManager } from "../src/workspaces/git-worktree.js";
import { GitWorkspaceRepository } from "../src/workspaces/git-repository.js";

test("creates an isolated branch at the exact requested base commit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-workspace-"));
  const repository = join(directory, "repository");
  const workspaces = join(directory, "workspaces");
  mkdirSync(repository);

  try {
    git(repository, ["init", "--initial-branch=main"]);
    git(repository, ["config", "user.name", "Fixture"]);
    git(repository, ["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(repository, "README.md"), "fixture\n");
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-m", "Fixture base"]);
    const baseSha = git(repository, ["rev-parse", "HEAD"]);

    const manager = new GitWorktreeManager(workspaces);
    const workspace = await manager.create({
      repositoryPath: repository,
      runId: "run-1",
      baseRef: "main",
      branchName: "agent/task-1",
    });

    assert.equal(workspace.baseSha, baseSha);
    assert.equal(git(workspace.path, ["branch", "--show-current"]), "agent/task-1");
    assert.equal(git(workspace.path, ["rev-parse", "HEAD"]), baseSha);
    assert.equal(git(repository, ["branch", "--show-current"]), "main");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects unsafe refs before invoking git", async () => {
  const manager = new GitWorktreeManager(join(tmpdir(), "agent-runner-unused"));

  await assert.rejects(
    manager.create({
      repositoryPath: "/tmp/unused",
      runId: "run-1",
      baseRef: "main; touch bad",
      branchName: "agent/task-1",
    }),
    /Unsafe base ref/,
  );
});

test("synchronizes an isolated task branch onto an advanced base", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-sync-"));
  const repository = join(directory, "repository");
  const workspaces = join(directory, "workspaces");
  mkdirSync(repository);
  try {
    initialize(repository);
    const manager = new GitWorktreeManager(workspaces);
    const workspace = await manager.create({
      repositoryPath: repository,
      runId: "run-sync",
      baseRef: "main",
      branchName: "agent/task-sync",
    });
    writeFileSync(join(workspace.path, "task.txt"), "task change\n");
    git(workspace.path, ["add", "task.txt"]);
    git(workspace.path, ["commit", "-m", "Task change"]);

    writeFileSync(join(repository, "base.txt"), "base advanced\n");
    git(repository, ["add", "base.txt"]);
    git(repository, ["commit", "-m", "Advance base"]);
    const advancedBase = git(repository, ["rev-parse", "HEAD"]);

    const workspaceRepository = new GitWorkspaceRepository();
    const synchronized = await workspaceRepository.synchronize(workspace.path, advancedBase);
    assert.equal(synchronized.outcome, "synchronized");
    const snapshot = await workspaceRepository.snapshot(workspace.path, advancedBase);
    assert.equal(snapshot.dirty, false);
    assert.deepEqual(snapshot.changedPaths, ["task.txt"]);
    assert.equal(git(workspace.path, ["merge-base", "--is-ancestor", advancedBase, "HEAD"]), "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports a synchronization conflict and restores the verified task head", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-runner-sync-conflict-"));
  const repository = join(directory, "repository");
  const workspaces = join(directory, "workspaces");
  mkdirSync(repository);
  try {
    initialize(repository);
    const manager = new GitWorktreeManager(workspaces);
    const workspace = await manager.create({
      repositoryPath: repository,
      runId: "run-conflict",
      baseRef: "main",
      branchName: "agent/task-conflict",
    });
    writeFileSync(join(workspace.path, "README.md"), "task version\n");
    git(workspace.path, ["add", "README.md"]);
    git(workspace.path, ["commit", "-m", "Task version"]);
    const verifiedHead = git(workspace.path, ["rev-parse", "HEAD"]);

    writeFileSync(join(repository, "README.md"), "base version\n");
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-m", "Conflicting base version"]);
    const advancedBase = git(repository, ["rev-parse", "HEAD"]);

    const synchronized = await new GitWorkspaceRepository().synchronize(
      workspace.path,
      advancedBase,
    );
    assert.deepEqual(synchronized, { outcome: "conflict", conflictedPaths: ["README.md"] });
    assert.equal(git(workspace.path, ["rev-parse", "HEAD"]), verifiedHead);
    assert.equal(git(workspace.path, ["status", "--porcelain"]), "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function initialize(repository: string): void {
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Fixture"]);
  git(repository, ["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repository, "README.md"), "fixture\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "Fixture base"]);
}

function git(cwd: string, argumentsList: string[]): string {
  return execFileSync("git", argumentsList, { cwd, encoding: "utf8" }).trim();
}
