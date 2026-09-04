export const RUN_STATES = [
  "discovered",
  "claimed",
  "workspace-ready",
  "running",
  "verifying",
  "synchronized",
  "verified",
  "pr-open",
  "ci",
  "waiting-human",
  "completed",
  "failed",
] as const;

export type RunState = (typeof RUN_STATES)[number];

export interface TaskRef {
  projectId: string;
  taskId: string;
  revision: string;
  baseSha: string;
}

export interface RunRecord extends TaskRef {
  id: string;
  state: RunState;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  headSha: string | null;
  attempt: number;
  maxAttempts: number;
  requiresReverification: boolean;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RunExecutionRecord {
  runId: string;
  workspacePath: string | null;
  branchName: string | null;
  workerProfile: string | null;
  workerName: string | null;
  workerStatus: "succeeded" | "failed" | "timed-out" | null;
  workerModel: string | null;
  workerSessionId: string | null;
  workerSummary: string | null;
  workerCostUsd: number | null;
  workerDurationMs: number | null;
  updatedAt: number;
}

export type DeliveryCiStatus = "none" | "pending" | "passed" | "failed";

export interface RunDeliveryRecord {
  runId: string;
  provider: string;
  externalId: string;
  url: string;
  branchName: string;
  baseBranch: string;
  baseSha: string;
  headSha: string;
  draft: boolean;
  ciStatus: DeliveryCiStatus;
  updatedAt: number;
}

export interface AutopilotExecutionRecord {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  stopReason: string | null;
}

export interface AutopilotQuarantineRecord {
  executionId: string;
  runId: string;
  projectId: string;
  taskId: string;
  revision: string;
  reason: string;
  recordedAt: number;
}

export interface ClaimRequest extends TaskRef {
  workerId: string;
  now: number;
  leaseDurationMs: number;
  maxAttempts: number;
}

export type ClaimResult =
  | { claimed: true; run: RunRecord }
  | { claimed: false; run: RunRecord };

export type CapacityClaimResult =
  | { outcome: "claimed" | "duplicate"; run: RunRecord }
  | { outcome: "capacity"; run: null };

export type ReclaimResult =
  | { outcome: "reclaimed"; run: RunRecord }
  | { outcome: "failed"; run: RunRecord }
  | { outcome: "not-stale" | "missing"; run: RunRecord | null };

export type LeaseAcquisitionResult =
  | { outcome: "acquired"; run: RunRecord }
  | { outcome: "live" | "missing" | "terminal"; run: RunRecord | null };

export interface WorkerResult {
  reportedSuccess: boolean;
  headSha: string | null;
  changedPaths: string[];
}

export interface VerificationResult {
  passed: boolean;
  evidence: string[];
}

export interface CiResult {
  passed: boolean;
  evidence: string[];
}
