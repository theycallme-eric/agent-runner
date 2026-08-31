export const RUN_STATES = [
  "discovered",
  "claimed",
  "workspace-ready",
  "running",
  "verifying",
  "synchronized",
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
