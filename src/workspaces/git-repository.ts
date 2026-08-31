import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_CAPTURE_BYTES = 1_000_000;

export interface WorkspaceSnapshot {
  headSha: string;
  changedPaths: string[];
  dirty: boolean;
}

export interface WorkspaceRepository {
  resolveRef(repositoryPath: string, ref: string): Promise<string>;
  snapshot(workspacePath: string, baseSha: string): Promise<WorkspaceSnapshot>;
  commit(workspacePath: string, message: string): Promise<string>;
}

export class GitWorkspaceRepository implements WorkspaceRepository {
  readonly #gitExecutable: string;

  constructor(gitExecutable = "git") {
    this.#gitExecutable = gitExecutable;
  }

  resolveRef(repositoryPath: string, ref: string): Promise<string> {
    return gitText(this.#gitExecutable, repositoryPath, ["rev-parse", "--verify", ref]);
  }

  async snapshot(workspacePath: string, baseSha: string): Promise<WorkspaceSnapshot> {
    const [headSha, committed, modified, untracked, status] = await Promise.all([
      gitText(this.#gitExecutable, workspacePath, ["rev-parse", "HEAD"]),
      gitRaw(this.#gitExecutable, workspacePath, ["diff", "--name-only", "-z", `${baseSha}..HEAD`]),
      gitRaw(this.#gitExecutable, workspacePath, ["diff", "--name-only", "-z"]),
      gitRaw(this.#gitExecutable, workspacePath, ["ls-files", "--others", "--exclude-standard", "-z"]),
      gitRaw(this.#gitExecutable, workspacePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ]);
    const changedPaths = [...new Set([
      ...nulList(committed),
      ...nulList(modified),
      ...nulList(untracked),
    ])].sort();
    return { headSha, changedPaths, dirty: status.length > 0 };
  }

  async commit(workspacePath: string, message: string): Promise<string> {
    if (message.trim() === "") {
      throw new Error("Commit message must be non-empty");
    }
    const status = await gitRaw(this.#gitExecutable, workspacePath, ["status", "--porcelain=v1", "-z"]);
    if (status !== "") {
      await gitRaw(this.#gitExecutable, workspacePath, ["add", "--all"]);
      await gitRaw(this.#gitExecutable, workspacePath, [
        "-c",
        "user.name=Agent Runner",
        "-c",
        "user.email=agent-runner@localhost",
        "commit",
        "--no-verify",
        "-m",
        message,
      ]);
    }
    return gitText(this.#gitExecutable, workspacePath, ["rev-parse", "HEAD"]);
  }
}

function nulList(value: string): string[] {
  return value.split("\0").filter((entry) => entry !== "");
}

async function gitRaw(executable: string, cwd: string, argumentsList: string[]): Promise<string> {
  const result = await execFileAsync(executable, argumentsList, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_CAPTURE_BYTES,
  });
  return result.stdout;
}

async function gitText(executable: string, cwd: string, argumentsList: string[]): Promise<string> {
  return (await gitRaw(executable, cwd, argumentsList)).trim();
}
