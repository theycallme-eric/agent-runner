import { spawn } from "node:child_process";

import type { WorkerAdapter, WorkerOutcome, WorkerRequest } from "./types.js";

const MAX_CAPTURE_BYTES = 1_000_000;

export interface JsonProcessWorkerOptions {
  name: string;
  executable: string;
  arguments?: string[];
  environment?: Record<string, string>;
}

interface ProtocolResponse {
  status?: unknown;
  model?: unknown;
  sessionId?: unknown;
  summary?: unknown;
  costUsd?: unknown;
  durationMs?: unknown;
}

export class JsonProcessWorker implements WorkerAdapter {
  readonly name: string;
  readonly #options: Required<JsonProcessWorkerOptions>;

  constructor(options: JsonProcessWorkerOptions) {
    if (options.name.trim() === "" || options.executable.trim() === "") {
      throw new Error("Worker name and executable must be non-empty");
    }
    this.name = options.name;
    this.#options = {
      arguments: [],
      environment: {},
      ...options,
    };
  }

  run(request: WorkerRequest): Promise<WorkerOutcome> {
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1) {
      throw new Error("timeoutMs must be a positive integer");
    }
    if (request.prompt.trim() === "") {
      throw new Error("prompt must be non-empty");
    }

    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(this.#options.executable, this.#options.arguments, {
        cwd: request.workspacePath,
        env: { ...process.env, ...this.#options.environment },
        stdio: ["pipe", "pipe", "pipe"],
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
          resolve(failed(this.name, "timed-out", `Worker exceeded ${request.timeoutMs}ms`, elapsed));
          return;
        }

        const response = parseResponse(stdout);
        if (exitCode !== 0 || response === null) {
          resolve(
            failed(
              this.name,
              "failed",
              stderr.trim().slice(0, 1_000) || `Worker exited with status ${exitCode ?? "unknown"}`,
              elapsed,
            ),
          );
          return;
        }

        resolve({
          status: response.status as WorkerOutcome["status"],
          worker: this.name,
          model: stringOrNull(response.model),
          sessionId: stringOrNull(response.sessionId),
          summary: response.summary as string,
          costUsd: numberOrNull(response.costUsd),
          durationMs: numberOrNull(response.durationMs) ?? elapsed,
        });
      });

      child.stdin.end(
        JSON.stringify({
          protocolVersion: 1,
          workspacePath: request.workspacePath,
          prompt: request.prompt,
          timeoutMs: request.timeoutMs,
          additionalDirectories: request.additionalDirectories ?? [],
          allowedCommands: request.allowedCommands ?? [],
        }),
      );
    });
  }
}

function parseResponse(stdout: string): ProtocolResponse | null {
  try {
    const response = JSON.parse(stdout) as ProtocolResponse;
    if (
      typeof response !== "object" ||
      response === null ||
      !["succeeded", "failed", "timed-out"].includes(String(response.status)) ||
      typeof response.summary !== "string"
    ) {
      return null;
    }
    return response;
  } catch {
    return null;
  }
}

function failed(
  worker: string,
  status: "failed" | "timed-out",
  summary: string,
  durationMs: number,
): WorkerOutcome {
  return {
    status,
    worker,
    model: null,
    sessionId: null,
    summary,
    costUsd: null,
    durationMs,
  };
}

function appendBounded(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current) >= MAX_CAPTURE_BYTES) {
    return current;
  }
  const remaining = MAX_CAPTURE_BYTES - Buffer.byteLength(current);
  return current + chunk.subarray(0, remaining).toString("utf8");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
