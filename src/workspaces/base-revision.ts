import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export interface BaseRevisionProvider {
  inspect(repositoryPath: string, baseBranch: string): Promise<string>;
  refresh(repositoryPath: string, baseBranch: string): Promise<string>;
}

export class GitRemoteBaseRevisionProvider implements BaseRevisionProvider {
  readonly #gitExecutable: string;

  constructor(gitExecutable = "git") {
    this.#gitExecutable = gitExecutable;
  }

  async inspect(repositoryPath: string, baseBranch: string): Promise<string> {
    validateBranch(baseBranch);
    const output = await this.#git(repositoryPath, [
      "ls-remote",
      "--exit-code",
      "origin",
      `refs/heads/${baseBranch}`,
    ]);
    const [sha, ref, ...extra] = output.split(/\s+/);
    if (!sha || ref !== `refs/heads/${baseBranch}` || extra.length > 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
      throw new Error(`Cannot resolve origin/${baseBranch} from git ls-remote output`);
    }
    return sha;
  }

  async refresh(repositoryPath: string, baseBranch: string): Promise<string> {
    validateBranch(baseBranch);
    const remoteRef = `refs/remotes/origin/${baseBranch}`;
    await this.#git(repositoryPath, [
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${baseBranch}:${remoteRef}`,
    ]);
    const sha = await this.#git(repositoryPath, ["rev-parse", "--verify", remoteRef]);
    if (!/^[0-9a-f]{40,64}$/.test(sha)) {
      throw new Error(`Fetched base is not a commit id: ${sha}`);
    }
    return sha;
  }

  async #git(cwd: string, argumentsList: string[]): Promise<string> {
    const result = await execFileAsync(this.#gitExecutable, argumentsList, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1_000_000,
    });
    return result.stdout.trim();
  }
}

function validateBranch(baseBranch: string): void {
  if (
    !SAFE_BRANCH.test(baseBranch) ||
    baseBranch.startsWith("-") ||
    baseBranch.includes("..")
  ) {
    throw new Error(`Unsafe base branch: ${baseBranch}`);
  }
}
