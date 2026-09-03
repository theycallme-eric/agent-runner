import { execFile } from "node:child_process";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
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

export interface CreateProjectRepositoryRequest extends OnboardProjectRequest {
  visibility: "public" | "private";
  confirmed: boolean;
  ghExecutable?: string;
}

export type CreateProjectRepositoryResult = RegisterProjectResult & {
  repositoryCreated: boolean;
  initialBranchPushed: boolean;
};

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

export async function createProjectRepository(
  registry: ProjectRegistryStore,
  request: CreateProjectRepositoryRequest,
): Promise<CreateProjectRepositoryResult> {
  if (!request.confirmed) {
    throw new Error("Project repository creation requires explicit --confirm-create authorization");
  }
  const requestedRoot = resolve(request.rootPath);
  const contractPath = await realpath(resolve(request.contractPath));
  assertExternalContract(requestedRoot, contractPath);
  const contract = await loadProjectContract(contractPath);
  if (contract.tasks.provider !== "github" && contract.delivery.provider !== "github") {
    throw new Error("Project repository creation currently requires a GitHub-backed contract");
  }
  const gitExecutable = request.gitExecutable ?? "git";
  await assertCreatableDirectory(requestedRoot, gitExecutable);
  await mkdir(dirname(requestedRoot), { recursive: true });
  await mkdir(requestedRoot, { recursive: true });
  const rootPath = await realpath(requestedRoot);
  const ghExecutable = request.ghExecutable ?? "gh";
  let repositoryCreated = false;

  if (!(await isGitRepository(rootPath, gitExecutable))) {
    await run(gitExecutable, ["-C", rootPath, "init", `--initial-branch=${contract.project.baseBranch}`]);
  }
  const topLevel = (await gitText(gitExecutable, rootPath, ["rev-parse", "--show-toplevel"])).trim();
  if (await realpath(topLevel) !== rootPath) {
    throw new Error(`Product path must be the Git repository root: ${rootPath}`);
  }

  let origin = await optionalGitText(gitExecutable, rootPath, [
    "config",
    "--get",
    "remote.origin.url",
  ]);
  if (origin) {
    const remoteId = githubRepositoryId(origin.trim());
    if (remoteId?.toLowerCase() !== contract.project.id.toLowerCase()) {
      throw new Error(
        `Project id ${contract.project.id} does not match GitHub origin ${remoteId ?? origin.trim()}`,
      );
    }
  } else {
    const existingHead = await optionalGitText(gitExecutable, rootPath, [
      "rev-parse",
      "--verify",
      "HEAD",
    ]);
    const existingChanges = await optionalGitText(gitExecutable, rootPath, [
      "status",
      "--porcelain=v1",
    ]);
    if (existingHead || existingChanges?.trim()) {
      throw new Error(
        "Refusing to create a GitHub repository from an existing local repository without an origin",
      );
    }
    await ensureInitialCommit(rootPath, contract.project.baseBranch, gitExecutable);
    await run(ghExecutable, [
      "repo",
      "create",
      contract.project.id,
      request.visibility === "public" ? "--public" : "--private",
      "--source",
      rootPath,
      "--remote",
      "origin",
    ]);
    repositoryCreated = true;
    origin = await optionalGitText(gitExecutable, rootPath, [
      "config",
      "--get",
      "remote.origin.url",
    ]);
    if (!origin) {
      throw new Error("GitHub repository creation did not configure an origin remote");
    }
  }

  await verifyGitHubRepository(
    ghExecutable,
    contract.project.id,
    request.visibility,
  );
  await ensureInitialCommit(rootPath, contract.project.baseBranch, gitExecutable);
  const initialBranchPushed = await ensureRemoteBranch(
    rootPath,
    contract.project.baseBranch,
    gitExecutable,
  );
  const registered = await onboardProject(registry, {
    rootPath,
    contractPath,
    workerProfile: request.workerProfile,
    now: request.now,
    gitExecutable,
  });
  return { ...registered, repositoryCreated, initialBranchPushed };
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

async function assertCreatableDirectory(path: string, gitExecutable: string): Promise<void> {
  try {
    const pathStat = await stat(path);
    if (!pathStat.isDirectory()) {
      throw new Error(`Product repository path is not a directory: ${path}`);
    }
    const entries = await readdir(path);
    if (entries.length === 0 || entries.every((entry) => entry === ".git")) {
      return;
    }
    if (await isGitRepository(path, gitExecutable)) {
      return;
    }
    throw new Error(`Refusing to initialize a non-empty product directory: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function isGitRepository(path: string, executable: string): Promise<boolean> {
  try {
    await execFileAsync(executable, ["-C", path, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      maxBuffer: 1_000_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function ensureInitialCommit(
  rootPath: string,
  baseBranch: string,
  gitExecutable: string,
): Promise<void> {
  const head = await optionalGitText(gitExecutable, rootPath, ["rev-parse", "--verify", "HEAD"]);
  if (head) return;
  await run(gitExecutable, [
    "-C",
    rootPath,
    "-c",
    "user.name=Agent Runner",
    "-c",
    "user.email=agent-runner@local.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "Initialize repository",
  ]);
  const branch = (await gitText(gitExecutable, rootPath, ["branch", "--show-current"])).trim();
  if (branch !== baseBranch) {
    throw new Error(`Initialized branch ${branch} does not match configured base ${baseBranch}`);
  }
}

async function ensureRemoteBranch(
  rootPath: string,
  baseBranch: string,
  gitExecutable: string,
): Promise<boolean> {
  const remote = await optionalGitText(gitExecutable, rootPath, [
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${baseBranch}`,
  ]);
  if (remote?.trim()) return false;
  await run(gitExecutable, ["-C", rootPath, "push", "-u", "origin", baseBranch]);
  return true;
}

async function verifyGitHubRepository(
  ghExecutable: string,
  projectId: string,
  visibility: "public" | "private",
): Promise<void> {
  const output = await run(ghExecutable, [
    "repo",
    "view",
    projectId,
    "--json",
    "nameWithOwner,visibility",
  ]);
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("GitHub repository verification returned invalid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub repository verification returned an invalid object");
  }
  const result = value as Record<string, unknown>;
  if (String(result.nameWithOwner).toLowerCase() !== projectId.toLowerCase()) {
    throw new Error(`GitHub created or resolved the wrong repository: ${String(result.nameWithOwner)}`);
  }
  if (String(result.visibility).toLowerCase() !== visibility) {
    throw new Error(
      `GitHub repository visibility ${String(result.visibility)} does not match requested ${visibility}`,
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

async function optionalGitText(
  executable: string,
  repositoryPath: string,
  args: string[],
): Promise<string | null> {
  try {
    return await gitText(executable, repositoryPath, args);
  } catch {
    return null;
  }
}

async function run(executable: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync(executable, args, {
      encoding: "utf8",
      maxBuffer: 1_000_000,
    });
    return result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Command failed: ${executable} ${args.join(" ")}: ${detail}`);
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
