export interface WorkerRequest {
  workspacePath: string;
  prompt: string;
  model: string;
  maxBudgetUsd: number;
  maxTurns: number;
  timeoutMs: number;
  tools: string[];
  settingSources: Array<"user" | "project" | "local">;
  persistSession: boolean;
}

export interface WorkerOutcome {
  status: "succeeded" | "failed" | "timed-out";
  worker: string;
  model: string;
  sessionId: string | null;
  summary: string;
  costUsd: number | null;
  durationMs: number;
}

export interface WorkerAdapter {
  readonly name: string;
  run(request: WorkerRequest): Promise<WorkerOutcome>;
}
