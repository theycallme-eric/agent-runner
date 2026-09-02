import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

import { loadProjectContract } from "../project-contract.js";
import type { ProjectRegistryStore } from "./registry.js";
import type { RegisterProjectResult } from "./types.js";

export interface OnboardProjectRequest {
  rootPath: string;
  contractPath: string;
  workerProfile: string;
  now: number;
  gitExecutable?: string;
}

const execFileAsync = promisify(execFile);

export async function onboardProject(
  registry: ProjectRegistryStore,
  request: OnboardProjectRequest,
): Promise<RegisterProjectResult> {
  const rootPath = await realpath(resolve(request.rootPath));
  const contractPath = await realpath(resolve(request.contractPath));
  assertExternalContract(rootPath, contractPath);
  const contract = await loadProjectContract(contractPath);
  await verifyRepository(
    rootPath,
    contract.project.id,
    contract.tasks.provider === "github" || contract.delivery.provider === "github",
    request.gitExecutable ?? "git",
  );
  return registry.register({
    id: contract.project.id,
    rootPath,
    contractPath,
    workerProfile: request.workerProfile,
    contractVersion: contract.version,
    now: request.now,
  });
}

function assertExternalContract(rootPath: string, contractPath: string): void {
  const contractRelative = relative(rootPath, contractPath);
  if (!contractRelative.startsWith("..")) {
    throw new Error("Agent Runner project configuration must be outside the product repository");
  }
}

async function verifyRepository(
  rootPath: string,
  projectId: string,
  requiresGitHubRemote: boolean,
  gitExecutable: string,
): Promise<void> {
  const topLevel = (await gitText(gitExecutable, rootPath, [
    "rev-parse",
    "--show-toplevel",
  ])).trim();
  if (await realpath(topLevel) !== rootPath) {
    throw new Error(`Product path must be the Git repository root: ${rootPath}`);
  }
  if (!requiresGitHubRemote) {
    return;
  }
  let origin: string;
  try {
    origin = (await gitText(gitExecutable, rootPath, [
      "config",
      "--get",
      "remote.origin.url",
    ])).trim();
  } catch {
    throw new Error("A GitHub-backed project requires a GitHub origin remote");
  }
  const remoteId = githubRepositoryId(origin);
  if (!remoteId) {
    throw new Error("A GitHub-backed project requires a GitHub origin remote");
  }
  if (remoteId.toLowerCase() !== projectId.toLowerCase()) {
    throw new Error(
      `Project id ${projectId} does not match GitHub origin ${remoteId}`,
    );
  }
}

async function gitText(
  executable: string,
  repositoryPath: string,
  args: string[],
): Promise<string> {
  try {
    const result = await execFileAsync(executable, ["-C", repositoryPath, ...args], {
      encoding: "utf8",
      maxBuffer: 1_000_000,
    });
    return result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot inspect product Git repository: ${detail}`);
  }
}

function githubRepositoryId(remote: string): string | null {
  const scp = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  if (scp) {
    return stripGitSuffix(scp[1]!);
  }
  try {
    const url = new URL(remote);
    if (url.hostname.toLowerCase() !== "github.com") {
      return null;
    }
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    return /^[^/]+\/[^/]+(?:\.git)?$/.test(path) ? stripGitSuffix(path) : null;
  } catch {
    return null;
  }
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "");
}
