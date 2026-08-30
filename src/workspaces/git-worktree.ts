import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { WorkspaceManager, WorkspaceRecord, WorkspaceRequest } from "./types.js";

const execFileAsync = promisify(execFile);
const SAFE_GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class GitWorktreeManager implements WorkspaceManager {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async create(request: WorkspaceRequest): Promise<WorkspaceRecord> {
    validateRequest(request);
    await mkdir(this.#root, { recursive: true });
    const workspacePath = resolve(this.#root, request.runId);
    if (!workspacePath.startsWith(`${this.#root}${sep}`)) {
      throw new Error("Workspace path escaped its configured root");
    }

    const baseSha = await git(request.repositoryPath, ["rev-parse", "--verify", request.baseRef]);
    await git(request.repositoryPath, [
      "worktree",
      "add",
      "--no-track",
      "-b",
      request.branchName,
      workspacePath,
      baseSha,
    ]);
    const workspaceHead = await git(workspacePath, ["rev-parse", "HEAD"]);
    if (workspaceHead !== baseSha) {
      throw new Error(`Workspace HEAD ${workspaceHead} does not match selected base ${baseSha}`);
    }
    return { path: workspacePath, branchName: request.branchName, baseSha };
  }
}

function validateRequest(request: WorkspaceRequest): void {
  if (!SAFE_RUN_ID.test(request.runId)) {
    throw new Error(`Unsafe run id: ${request.runId}`);
  }
  if (!SAFE_GIT_REF.test(request.baseRef)) {
    throw new Error(`Unsafe base ref: ${request.baseRef}`);
  }
  if (!SAFE_GIT_REF.test(request.branchName) || request.branchName.startsWith("-") || request.branchName.includes("..")) {
    throw new Error(`Unsafe branch name: ${request.branchName}`);
  }
}

async function git(cwd: string, argumentsList: string[]): Promise<string> {
  const result = await execFileAsync("git", argumentsList, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1_000_000,
  });
  return result.stdout.trim();
}
