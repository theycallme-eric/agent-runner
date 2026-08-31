import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_CAPTURE_BYTES = 1_000_000;

export interface WorkspaceSnapshot {
  headSha: string;
  changedPaths: string[];
  dirty: boolean;
}

export type WorkspaceSynchronization =
  | { outcome: "synchronized"; headSha: string }
  | { outcome: "conflict"; conflictedPaths: string[] };

export interface WorkspaceRepository {
  resolveRef(repositoryPath: string, ref: string): Promise<string>;
  snapshot(workspacePath: string, baseSha: string): Promise<WorkspaceSnapshot>;
  commit(workspacePath: string, message: string): Promise<string>;
  synchronize(workspacePath: string, baseSha: string): Promise<WorkspaceSynchronization>;
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

  async synchronize(workspacePath: string, baseSha: string): Promise<WorkspaceSynchronization> {
    if (!/^[0-9a-f]{7,64}$/i.test(baseSha)) {
      throw new Error(`Synchronization base is not a commit id: ${baseSha}`);
    }
    try {
      await gitRaw(this.#gitExecutable, workspacePath, [
        "-c",
        "user.name=Agent Runner",
        "-c",
        "user.email=agent-runner@localhost",
        "merge",
        "--no-ff",
        "--no-edit",
        baseSha,
      ]);
    } catch (error) {
      const conflictedPaths = nulList(await gitRaw(
        this.#gitExecutable,
        workspacePath,
        ["diff", "--name-only", "--diff-filter=U", "-z"],
      )).sort();
      if (conflictedPaths.length === 0) {
        throw error;
      }
      try {
        await gitRaw(this.#gitExecutable, workspacePath, ["merge", "--abort"]);
      } catch (abortError) {
        throw new Error(
          `Synchronization conflicted and merge abort failed: ${errorText(abortError)}`,
        );
      }
      return { outcome: "conflict", conflictedPaths };
    }
    const headSha = await gitText(this.#gitExecutable, workspacePath, ["rev-parse", "HEAD"]);
    await gitRaw(this.#gitExecutable, workspacePath, ["merge-base", "--is-ancestor", baseSha, headSha]);
    return { outcome: "synchronized", headSha };
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
