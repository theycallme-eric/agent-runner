export interface WorkerRequest {
  workspacePath: string;
  prompt: string;
  timeoutMs: number;
  /** Controller-prepared reference directories. Workers must treat them as read-only. */
  additionalDirectories?: string[];
}

export interface WorkerOutcome {
  status: "succeeded" | "failed" | "timed-out";
  worker: string;
  model: string | null;
  sessionId: string | null;
  summary: string;
  costUsd: number | null;
  durationMs: number;
}

export interface WorkerAdapter {
  readonly name: string;
  run(request: WorkerRequest): Promise<WorkerOutcome>;
}
