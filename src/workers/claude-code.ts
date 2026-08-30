import { spawn } from "node:child_process";

import type { WorkerAdapter, WorkerOutcome, WorkerRequest } from "./types.js";

const MAX_CAPTURE_BYTES = 1_000_000;

interface ClaudeJsonResult {
  result?: unknown;
  session_id?: unknown;
  is_error?: unknown;
  total_cost_usd?: unknown;
  duration_ms?: unknown;
}

export class ClaudeCodeWorker implements WorkerAdapter {
  readonly name = "claude-code";
  readonly #executable: string;

  constructor(executable = "claude") {
    this.#executable = executable;
  }

  run(request: WorkerRequest): Promise<WorkerOutcome> {
    validateRequest(request);
    const startedAt = Date.now();
    const argumentsList = [
      "--print",
      request.prompt,
      "--model",
      request.model,
      "--output-format",
      "json",
      "--permission-mode",
      "dontAsk",
      "--max-budget-usd",
      String(request.maxBudgetUsd),
      "--max-turns",
      String(request.maxTurns),
      "--tools",
      request.tools.join(","),
      "--setting-sources",
      request.settingSources.join(","),
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--no-chrome",
      "--disable-slash-commands",
    ];
    if (!request.persistSession) {
      argumentsList.push("--no-session-persistence");
    }

    return new Promise((resolve, reject) => {
      const child = spawn(this.#executable, argumentsList, {
        cwd: request.workspacePath,
        env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, request.timeoutMs);
      timer.unref();

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendBounded(stderr, chunk);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        const elapsed = Date.now() - startedAt;
        if (timedOut) {
          resolve({
            status: "timed-out",
            worker: this.name,
            model: request.model,
            sessionId: null,
            summary: `Claude Code exceeded ${request.timeoutMs}ms`,
            costUsd: null,
            durationMs: elapsed,
          });
          return;
        }

        const parsed = parseClaudeResult(stdout);
        if (exitCode !== 0 || parsed === null || parsed.is_error === true) {
          resolve({
            status: "failed",
            worker: this.name,
            model: request.model,
            sessionId: stringOrNull(parsed?.session_id),
            summary: failureSummary(exitCode, parsed, stderr),
            costUsd: numberOrNull(parsed?.total_cost_usd),
            durationMs: numberOrNull(parsed?.duration_ms) ?? elapsed,
          });
          return;
        }

        resolve({
          status: "succeeded",
          worker: this.name,
          model: request.model,
          sessionId: stringOrNull(parsed.session_id),
          summary: stringOrNull(parsed.result) ?? "Claude Code completed without a text result",
          costUsd: numberOrNull(parsed.total_cost_usd),
          durationMs: numberOrNull(parsed.duration_ms) ?? elapsed,
        });
      });
    });
  }
}

function validateRequest(request: WorkerRequest): void {
  if (!Number.isFinite(request.maxBudgetUsd) || request.maxBudgetUsd <= 0) {
    throw new Error("maxBudgetUsd must be greater than zero");
  }
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive integer");
  }
  if (!Number.isInteger(request.maxTurns) || request.maxTurns < 1) {
    throw new Error("maxTurns must be a positive integer");
  }
  if (request.model.trim() === "") {
    throw new Error("model must be non-empty");
  }
  if (request.prompt.trim() === "") {
    throw new Error("prompt must be non-empty");
  }
}

function appendBounded(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current) >= MAX_CAPTURE_BYTES) {
    return current;
  }
  const remaining = MAX_CAPTURE_BYTES - Buffer.byteLength(current);
  return current + chunk.subarray(0, remaining).toString("utf8");
}

function parseClaudeResult(stdout: string): ClaudeJsonResult | null {
  try {
    const value = JSON.parse(stdout) as unknown;
    return typeof value === "object" && value !== null ? (value as ClaudeJsonResult) : null;
  } catch {
    return null;
  }
}

function failureSummary(
  exitCode: number | null,
  parsed: ClaudeJsonResult | null,
  stderr: string,
): string {
  const result = stringOrNull(parsed?.result);
  if (result) {
    return result;
  }
  const error = stderr.trim();
  if (error) {
    return error.slice(0, 1_000);
  }
  return `Claude Code exited with status ${exitCode ?? "unknown"}`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
