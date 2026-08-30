import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GitWorktreeManager } from "../src/workspaces/git-worktree.js";

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

function git(cwd: string, argumentsList: string[]): string {
  return execFileSync("git", argumentsList, { cwd, encoding: "utf8" }).trim();
}
