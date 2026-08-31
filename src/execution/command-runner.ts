import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_CAPTURE_BYTES = 1_000_000;

export interface CommandRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
}

export interface CommandOutcome {
  command: string;
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandOutcome>;
}

export class ShellCommandRunner implements CommandRunner {
  async run(request: CommandRequest): Promise<CommandOutcome> {
    validateRequest(request);
    const startedAt = Date.now();
    try {
      const result = await execFileAsync("/bin/sh", ["-lc", request.command], {
        cwd: request.cwd,
        encoding: "utf8",
        maxBuffer: MAX_CAPTURE_BYTES,
        timeout: request.timeoutMs,
      });
      return {
        command: request.command,
        passed: true,
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & {
        code?: string | number;
        stdout?: string;
        stderr?: string;
      };
      return {
        command: request.command,
        passed: false,
        exitCode: typeof failure.code === "number" ? failure.code : null,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message,
        durationMs: Date.now() - startedAt,
      };
    }
  }
}

function validateRequest(request: CommandRequest): void {
  if (request.command.trim() === "" || request.cwd.trim() === "") {
    throw new Error("Command and cwd must be non-empty");
  }
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1) {
    throw new Error("Command timeoutMs must be a positive integer");
  }
}
