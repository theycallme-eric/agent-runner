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
  resolveRef(repositoryPath: string, ref: string): Promise<string> {
    return gitText(repositoryPath, ["rev-parse", "--verify", ref]);
  }

  async snapshot(workspacePath: string, baseSha: string): Promise<WorkspaceSnapshot> {
    const [headSha, committed, modified, untracked, status] = await Promise.all([
      gitText(workspacePath, ["rev-parse", "HEAD"]),
      gitRaw(workspacePath, ["diff", "--name-only", "-z", `${baseSha}..HEAD`]),
      gitRaw(workspacePath, ["diff", "--name-only", "-z"]),
      gitRaw(workspacePath, ["ls-files", "--others", "--exclude-standard", "-z"]),
      gitRaw(workspacePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
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
    const status = await gitRaw(workspacePath, ["status", "--porcelain=v1", "-z"]);
    if (status !== "") {
      await gitRaw(workspacePath, ["add", "--all"]);
      await gitRaw(workspacePath, [
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
    return gitText(workspacePath, ["rev-parse", "HEAD"]);
  }
}

function nulList(value: string): string[] {
  return value.split("\0").filter((entry) => entry !== "");
}

async function gitRaw(cwd: string, argumentsList: string[]): Promise<string> {
  const result = await execFileAsync("git", argumentsList, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_CAPTURE_BYTES,
  });
  return result.stdout;
}

async function gitText(cwd: string, argumentsList: string[]): Promise<string> {
  return (await gitRaw(cwd, argumentsList)).trim();
}
