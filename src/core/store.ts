import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  RUN_STATES,
  type CapacityClaimResult,
  type AutopilotExecutionRecord,
  type AutopilotQuarantineRecord,
  type ClaimRequest,
  type ClaimResult,
  type DeliveryCiStatus,
  type LeaseAcquisitionResult,
  type ReclaimResult,
  type RunDeliveryRecord,
  type RunExecutionRecord,
  type RunRecord,
  type RunState,
} from "./types.js";
import { isRetryableTaskFailure } from "./retry-policy.js";

const ALLOWED_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  discovered: ["claimed"],
  claimed: ["workspace-ready", "failed"],
  "workspace-ready": ["running", "failed"],
  running: ["verifying", "failed"],
  verifying: ["synchronized", "verified", "waiting-human", "failed"],
  synchronized: ["verifying", "failed"],
  verified: ["synchronized", "pr-open", "waiting-human", "failed"],
  "pr-open": ["synchronized", "ci", "waiting-human", "failed"],
  ci: ["synchronized", "completed", "waiting-human", "failed"],
  "waiting-human": ["pr-open", "ci", "completed", "failed"],
  completed: [],
  failed: [],
};

interface RunRow {
  id: string;
  project_id: string;
  task_id: string;
  revision: string;
  state: string;
  lease_owner: string | null;
  lease_expires_at: number | null;
  base_sha: string;
  head_sha: string | null;
  attempt: number;
  max_attempts: number;
  requires_reverification: number;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface RunExecutionRow {
  run_id: string;
  workspace_path: string | null;
  branch_name: string | null;
  worker_profile: string | null;
  worker_name: string | null;
  worker_status: string | null;
  worker_model: string | null;
  worker_session_id: string | null;
  worker_summary: string | null;
  worker_cost_usd: number | null;
  worker_duration_ms: number | null;
  updated_at: number;
}

interface RunCiWaitRow {
  run_id: string;
  head_sha: string;
  first_pending_at: number;
}

interface RunDeliveryRow {
  run_id: string;
  provider: string;
  external_id: string;
  url: string;
  branch_name: string;
  base_branch: string;
  base_sha: string;
  head_sha: string;
  draft: number;
  ci_status: string;
  updated_at: number;
}

interface AutopilotExecutionRow {
  id: string;
  started_at: number;
  finished_at: number | null;
  stop_reason: string | null;
}

interface AutopilotQuarantineRow {
  execution_id: string;
  run_id: string;
  project_id: string;
  task_id: string;
  revision: string;
  reason: string;
  recorded_at: number;
}

export interface WorkspaceEvidence {
  workspacePath: string;
  branchName: string;
  workerProfile: string;
}

export interface WorkerEvidence {
  workerName: string;
  status: "succeeded" | "failed" | "timed-out";
  model: string | null;
  sessionId: string | null;
  summary: string;
  costUsd: number | null;
  durationMs: number;
}

export interface WorkerUsage {
  attempts: number;
  costUsd: number | null;
  durationMs: number;
}

export interface DeliveryEvidence {
  provider: string;
  externalId: string;
  url: string;
  branchName: string;
  baseBranch: string;
  baseSha: string;
  headSha: string;
  draft: boolean;
  ciStatus: DeliveryCiStatus;
}

export interface RunCiWaitRecord {
  runId: string;
  headSha: string;
  firstPendingAt: number;
}

export interface TransitionPatch {
  baseSha?: string;
  headSha?: string | null;
  requiresReverification?: boolean;
  failureReason?: string | null;
}

export class RunStore {
  readonly #database: DatabaseSync;

  constructor(path = ":memory:") {
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") {
      this.#database.exec("PRAGMA journal_mode = WAL;");
    }
    this.#migrate();
  }

  close(): void {
    this.#database.close();
  }

  claim(request: ClaimRequest): ClaimResult {
    const result = this.#claimTransaction(request, null);
    if (result.outcome === "capacity") {
      throw new Error("Unbounded claim unexpectedly reached capacity");
    }
    return { claimed: result.outcome === "claimed", run: result.run };
  }

  claimWithinCapacity(request: ClaimRequest, maxActive: number): CapacityClaimResult {
    if (!Number.isInteger(maxActive) || maxActive < 1) {
      throw new Error("maxActive must be a positive integer");
    }
    return this.#claimTransaction(request, maxActive);
  }

  activeCount(projectId: string): number {
    const row = this.#database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM runs
        WHERE project_id = ?
          AND state IN ('claimed', 'workspace-ready', 'running', 'verifying', 'synchronized')
      `)
      .get(projectId) as { count: number };
    return row.count;
  }

  authorizeFailedRetry(runId: string, additionalAttempts: number, now: number): RunRecord {
    if (!Number.isInteger(additionalAttempts) || additionalAttempts < 1) {
      throw new Error("additionalAttempts must be a positive integer");
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.#database
        .prepare("SELECT * FROM runs WHERE id = ?")
        .get(runId) as RunRow | undefined;
      if (!row) throw new Error(`Unknown run: ${runId}`);
      if (row.state !== "failed") {
        throw new Error(`Run ${runId} is not failed`);
      }
      if (!isRetryableTaskFailure(row.failure_reason)) {
        throw new Error(`Run ${runId} is not eligible for an implementation retry`);
      }
      if (row.attempt < row.max_attempts) {
        throw new Error(`Run ${runId} already has a retry remaining`);
      }
      const delivery = this.#database
        .prepare("SELECT 1 AS present FROM run_delivery WHERE run_id = ?")
        .get(runId) as { present: number } | undefined;
      if (delivery) {
        throw new Error(`Run ${runId} has delivery identity and must be reconciled, not retried`);
      }
      const nextMaximum = row.max_attempts + additionalAttempts;
      this.#database
        .prepare("UPDATE runs SET max_attempts = ?, updated_at = ? WHERE id = ?")
        .run(nextMaximum, now, runId);
      this.#event(runId, now, "owner-retry-authorized", {
        additionalAttempts,
        previousMaximum: row.max_attempts,
        newMaximum: nextMaximum,
        failureReason: row.failure_reason,
      });
      const updated = this.#require(runId);
      this.#database.exec("COMMIT;");
      return updated;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  authorizeFailedWorkspaceRecovery(runId: string, now: number): RunRecord {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.#database
        .prepare("SELECT * FROM runs WHERE id = ?")
        .get(runId) as RunRow | undefined;
      if (!row) throw new Error(`Unknown run: ${runId}`);
      assertFailedWorkspaceRecoveryEligible(this.#database, row);
      const existing = this.#database
        .prepare(`
          SELECT 1 AS present
          FROM run_events
          WHERE run_id = ? AND event_type = 'owner-workspace-recovery-authorized'
          LIMIT 1
        `)
        .get(runId) as { present: number } | undefined;
      if (!existing) {
        const execution = this.#database
          .prepare("SELECT * FROM run_execution WHERE run_id = ?")
          .get(runId) as unknown as RunExecutionRow;
        this.#event(runId, now, "owner-workspace-recovery-authorized", {
          attempt: row.attempt,
          failureReason: row.failure_reason,
          workspacePath: execution.workspace_path,
          branchName: execution.branch_name,
        });
        this.#database
          .prepare("UPDATE runs SET updated_at = ? WHERE id = ?")
          .run(now, runId);
      }
      const updated = this.#require(runId);
      this.#database.exec("COMMIT;");
      return updated;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  completeFailedWorkspaceRecovery(
    runId: string,
    headSha: string,
    changedPaths: readonly string[],
    now: number,
  ): RunRecord {
    if (headSha.trim() === "" || changedPaths.length === 0) {
      throw new Error("Recovered workspace must have a non-empty head and changed paths");
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.#database
        .prepare("SELECT * FROM runs WHERE id = ?")
        .get(runId) as RunRow | undefined;
      if (!row) throw new Error(`Unknown run: ${runId}`);
      assertFailedWorkspaceRecoveryEligible(this.#database, row);
      const authorization = this.#database
        .prepare(`
          SELECT 1 AS present
          FROM run_events
          WHERE run_id = ? AND event_type = 'owner-workspace-recovery-authorized'
          LIMIT 1
        `)
        .get(runId) as { present: number } | undefined;
      if (!authorization) {
        throw new Error(`Run ${runId} has no owner-authorized workspace recovery`);
      }
      const updated = this.#database.prepare(`
        UPDATE runs
        SET state = 'verified', lease_owner = NULL, lease_expires_at = NULL,
            head_sha = ?, requires_reverification = 0, failure_reason = NULL, updated_at = ?
        WHERE id = ? AND state = 'failed'
      `).run(headSha, now, runId);
      if (updated.changes !== 1) {
        throw new Error(`Failed to atomically recover run ${runId}`);
      }
      this.#event(runId, now, "transition", {
        from: "failed",
        to: "verified",
        headSha,
        recovery: "owner-authorized-failed-workspace",
      });
      this.#event(runId, now, "failed-workspace-recovered", {
        headSha,
        changedPaths: [...changedPaths],
      });
      const recovered = this.#require(runId);
      this.#database.exec("COMMIT;");
      return recovered;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  #claimTransaction(request: ClaimRequest, maxActive: number | null): CapacityClaimResult {
    const id = randomUUID();
    const expiresAt = request.now + request.leaseDurationMs;

    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.#findTaskRow(request.projectId, request.taskId, request.revision);
      if (existing) {
        if (
          existing.state === "failed" &&
          existing.attempt < existing.max_attempts &&
          isRetryableTaskFailure(existing.failure_reason) &&
          !this.delivery(existing.id)
        ) {
          if (maxActive !== null) {
            const active = this.#database.prepare(`
              SELECT COUNT(*) AS count
              FROM runs
              WHERE project_id = ?
                AND state IN ('claimed', 'workspace-ready', 'running', 'verifying', 'synchronized')
            `).get(request.projectId) as { count: number };
            if (active.count >= maxActive) {
              this.#database.exec("COMMIT;");
              return { outcome: "capacity", run: null };
            }
          }
          const nextAttempt = existing.attempt + 1;
          const retried = this.#database.prepare(`
            UPDATE runs
            SET state = 'claimed', lease_owner = ?, lease_expires_at = ?, base_sha = ?,
                head_sha = NULL, attempt = ?, requires_reverification = 0,
                failure_reason = NULL, updated_at = ?
            WHERE id = ? AND state = 'failed' AND attempt = ?
          `).run(
            request.workerId,
            expiresAt,
            request.baseSha,
            nextAttempt,
            request.now,
            existing.id,
            existing.attempt,
          );
          if (retried.changes !== 1) {
            throw new Error(`Failed to atomically retry run ${existing.id}`);
          }
          this.#database.prepare(`
            UPDATE run_execution
            SET workspace_path = NULL, branch_name = NULL, worker_profile = NULL,
                worker_name = NULL, worker_status = NULL, worker_model = NULL,
                worker_session_id = NULL, worker_summary = NULL, worker_cost_usd = NULL,
                worker_duration_ms = NULL, updated_at = ?
            WHERE run_id = ?
          `).run(request.now, existing.id);
          this.#event(existing.id, request.now, "task-retried", {
            previousFailureReason: existing.failure_reason,
            workerId: request.workerId,
            leaseExpiresAt: expiresAt,
            attempt: nextAttempt,
          });
          const retriedRow = this.#require(existing.id);
          this.#database.exec("COMMIT;");
          return { outcome: "claimed", run: retriedRow };
        }
        this.#database.exec("COMMIT;");
        return { outcome: "duplicate", run: mapRun(existing) };
      }
      if (maxActive !== null) {
        const active = this.#database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM runs
            WHERE project_id = ?
              AND state IN ('claimed', 'workspace-ready', 'running', 'verifying', 'synchronized')
          `)
          .get(request.projectId) as { count: number };
        if (active.count >= maxActive) {
          this.#database.exec("COMMIT;");
          return { outcome: "capacity", run: null };
        }
      }

      const result = this.#database
        .prepare(`
          INSERT INTO runs (
            id, project_id, task_id, revision, state, lease_owner, lease_expires_at,
            base_sha, attempt, max_attempts, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'claimed', ?, ?, ?, 1, ?, ?, ?)
          ON CONFLICT(project_id, task_id, revision) DO NOTHING
        `)
        .run(
          id,
          request.projectId,
          request.taskId,
          request.revision,
          request.workerId,
          expiresAt,
          request.baseSha,
          request.maxAttempts,
          request.now,
          request.now,
        );

      const row = this.#findTaskRow(
        request.projectId,
        request.taskId,
        request.revision,
      );
      if (!row) {
        throw new Error("Claim insert completed without a readable run");
      }
      if (result.changes === 1) {
        this.#event(row.id, request.now, "claimed", {
          workerId: request.workerId,
          leaseExpiresAt: expiresAt,
        });
      }
      this.#database.exec("COMMIT;");
      return {
        outcome: result.changes === 1 ? "claimed" : "duplicate",
        run: mapRun(row),
      };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  get(runId: string): RunRecord | null {
    const row = this.#database
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get(runId) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  listProject(projectId: string): RunRecord[] {
    const rows = this.#database
      .prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY created_at, id")
      .all(projectId) as unknown as RunRow[];
    return rows.map(mapRun);
  }

  findTask(projectId: string, taskId: string, revision: string): RunRecord | null {
    const row = this.#findTaskRow(projectId, taskId, revision);
    return row ? mapRun(row) : null;
  }

  transition(
    runId: string,
    nextState: RunState,
    now: number,
    patch: TransitionPatch = {},
  ): RunRecord {
    const current = this.get(runId);
    if (!current) {
      throw new Error(`Unknown run: ${runId}`);
    }
    if (!RUN_STATES.includes(nextState)) {
      throw new Error(`Unknown run state: ${nextState}`);
    }
    if (!ALLOWED_TRANSITIONS[current.state].includes(nextState)) {
      throw new Error(`Invalid transition: ${current.state} -> ${nextState}`);
    }

    const values: SQLInputValue[] = [nextState, now];
    const assignments = ["state = ?", "updated_at = ?"];
    addPatch(assignments, values, "base_sha", patch.baseSha);
    addPatch(assignments, values, "head_sha", patch.headSha);
    addPatch(
      assignments,
      values,
      "requires_reverification",
      patch.requiresReverification === undefined
        ? undefined
        : Number(patch.requiresReverification),
    );
    addPatch(assignments, values, "failure_reason", patch.failureReason);
    values.push(runId);

    this.#database
      .prepare(`UPDATE runs SET ${assignments.join(", ")} WHERE id = ?`)
      .run(...values);
    this.#event(runId, now, "transition", {
      from: current.state,
      to: nextState,
      ...patch,
    });
    return this.#require(runId);
  }

  heartbeat(runId: string, workerId: string, now: number, leaseDurationMs: number): boolean {
    const result = this.#database
      .prepare(`
        UPDATE runs
        SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND lease_owner = ? AND state NOT IN ('completed', 'failed')
      `)
      .run(now + leaseDurationMs, now, runId, workerId);
    if (result.changes === 1) {
      this.#event(runId, now, "heartbeat", { workerId });
    }
    return result.changes === 1;
  }

  reclaimExpired(runId: string, workerId: string, now: number, leaseDurationMs: number): ReclaimResult {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.#database
        .prepare("SELECT * FROM runs WHERE id = ?")
        .get(runId) as RunRow | undefined;
      if (!row) {
        this.#database.exec("COMMIT;");
        return { outcome: "missing", run: null };
      }
      if (row.lease_expires_at === null || row.lease_expires_at > now) {
        this.#database.exec("COMMIT;");
        return { outcome: "not-stale", run: mapRun(row) };
      }

      const nextAttempt = row.attempt + 1;
      if (nextAttempt > row.max_attempts) {
        this.#database
          .prepare(`
            UPDATE runs
            SET state = 'failed', failure_reason = 'attempts-exhausted',
                lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
            WHERE id = ?
          `)
          .run(now, runId);
        this.#event(runId, now, "attempts-exhausted", { previousOwner: row.lease_owner });
        const failed = this.#require(runId);
        this.#database.exec("COMMIT;");
        return { outcome: "failed", run: failed };
      }

      this.#database
        .prepare(`
          UPDATE runs
          SET state = 'claimed', lease_owner = ?, lease_expires_at = ?,
              attempt = ?, failure_reason = NULL, updated_at = ?
          WHERE id = ?
        `)
        .run(workerId, now + leaseDurationMs, nextAttempt, now, runId);
      this.#event(runId, now, "lease-reclaimed", {
        previousOwner: row.lease_owner,
        workerId,
        attempt: nextAttempt,
      });
      const reclaimed = this.#require(runId);
      this.#database.exec("COMMIT;");
      return { outcome: "reclaimed", run: reclaimed };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  resumeExpired(runId: string, workerId: string, now: number, leaseDurationMs: number): ReclaimResult {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.#database
        .prepare("SELECT * FROM runs WHERE id = ?")
        .get(runId) as RunRow | undefined;
      if (!row) {
        this.#database.exec("COMMIT;");
        return { outcome: "missing", run: null };
      }
      if (row.lease_expires_at === null || row.lease_expires_at > now) {
        this.#database.exec("COMMIT;");
        return { outcome: "not-stale", run: mapRun(row) };
      }
      if (!row.requires_reverification || !["synchronized", "verifying"].includes(row.state)) {
        throw new Error(`Run ${runId} is not a resumable synchronization`);
      }

      const nextAttempt = row.attempt + 1;
      if (nextAttempt > row.max_attempts) {
        this.#database
          .prepare(`
            UPDATE runs
            SET state = 'failed', failure_reason = 'attempts-exhausted',
                lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
            WHERE id = ?
          `)
          .run(now, runId);
        this.#event(runId, now, "attempts-exhausted", { previousOwner: row.lease_owner });
        const failed = this.#require(runId);
        this.#database.exec("COMMIT;");
        return { outcome: "failed", run: failed };
      }

      this.#database
        .prepare(`
          UPDATE runs
          SET lease_owner = ?, lease_expires_at = ?, attempt = ?,
              failure_reason = NULL, updated_at = ?
          WHERE id = ?
        `)
        .run(workerId, now + leaseDurationMs, nextAttempt, now, runId);
      this.#event(runId, now, "synchronization-reclaimed", {
        previousOwner: row.lease_owner,
        workerId,
        attempt: nextAttempt,
        state: row.state,
      });
      const reclaimed = this.#require(runId);
      this.#database.exec("COMMIT;");
      return { outcome: "reclaimed", run: reclaimed };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  acquireLease(
    runId: string,
    workerId: string,
    now: number,
    leaseDurationMs: number,
  ): LeaseAcquisitionResult {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.#database
        .prepare("SELECT * FROM runs WHERE id = ?")
        .get(runId) as RunRow | undefined;
      if (!row) {
        this.#database.exec("COMMIT;");
        return { outcome: "missing", run: null };
      }
      if (["completed", "failed"].includes(row.state)) {
        this.#database.exec("COMMIT;");
        return { outcome: "terminal", run: mapRun(row) };
      }
      if (
        row.lease_expires_at !== null &&
        row.lease_expires_at > now &&
        row.lease_owner !== workerId
      ) {
        this.#database.exec("COMMIT;");
        return { outcome: "live", run: mapRun(row) };
      }
      this.#database
        .prepare(`
          UPDATE runs
          SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(workerId, now + leaseDurationMs, now, runId);
      this.#event(runId, now, "lease-acquired", {
        workerId,
        leaseExpiresAt: now + leaseDurationMs,
      });
      const acquired = this.#require(runId);
      this.#database.exec("COMMIT;");
      return { outcome: "acquired", run: acquired };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  releaseLease(runId: string, workerId: string, now: number): boolean {
    const result = this.#database
      .prepare(`
        UPDATE runs
        SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND lease_owner = ?
      `)
      .run(now, runId, workerId);
    if (result.changes === 1) {
      this.#event(runId, now, "lease-released", { workerId });
      return true;
    }
    return false;
  }

  events(runId: string): Array<{ type: string; at: number; detail: unknown }> {
    const rows = this.#database
      .prepare("SELECT event_type, occurred_at, detail_json FROM run_events WHERE run_id = ? ORDER BY sequence")
      .all(runId) as Array<{
      event_type: string;
      occurred_at: number;
      detail_json: string;
    }>;
    return rows.map((row) => ({
      type: row.event_type,
      at: row.occurred_at,
      detail: JSON.parse(row.detail_json) as unknown,
    }));
  }

  workerUsage(runId: string): WorkerUsage {
    this.#require(runId);
    let attempts = 0;
    let durationMs = 0;
    let costUsd = 0;
    let hasReportedCost = false;
    for (const event of this.events(runId)) {
      if (event.type !== "worker-recorded" || !isObject(event.detail)) continue;
      attempts += 1;
      const duration = event.detail.durationMs;
      if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) {
        durationMs += duration;
      }
      const cost = event.detail.costUsd;
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
        costUsd += cost;
        hasReportedCost = true;
      }
    }
    return {
      attempts,
      costUsd: hasReportedCost ? costUsd : null,
      durationMs,
    };
  }

  recordWorkspace(runId: string, evidence: WorkspaceEvidence, now: number): void {
    this.#require(runId);
    this.#database
      .prepare(`
        INSERT INTO run_execution (
          run_id, workspace_path, branch_name, worker_profile, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          workspace_path = excluded.workspace_path,
          branch_name = excluded.branch_name,
          worker_profile = excluded.worker_profile,
          updated_at = excluded.updated_at
      `)
      .run(
        runId,
        evidence.workspacePath,
        evidence.branchName,
        evidence.workerProfile,
        now,
      );
    this.#event(runId, now, "workspace-recorded", evidence);
  }

  recordWorker(runId: string, evidence: WorkerEvidence, now: number): void {
    this.#require(runId);
    this.#database
      .prepare(`
        INSERT INTO run_execution (
          run_id, worker_name, worker_status, worker_model, worker_session_id,
          worker_summary, worker_cost_usd, worker_duration_ms, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          worker_name = excluded.worker_name,
          worker_status = excluded.worker_status,
          worker_model = excluded.worker_model,
          worker_session_id = excluded.worker_session_id,
          worker_summary = excluded.worker_summary,
          worker_cost_usd = excluded.worker_cost_usd,
          worker_duration_ms = excluded.worker_duration_ms,
          updated_at = excluded.updated_at
      `)
      .run(
        runId,
        evidence.workerName,
        evidence.status,
        evidence.model,
        evidence.sessionId,
        evidence.summary,
        evidence.costUsd,
        evidence.durationMs,
        now,
      );
    this.#event(runId, now, "worker-recorded", evidence);
  }

  recordEvidence(runId: string, type: string, detail: unknown, now: number): void {
    this.#require(runId);
    if (!/^[a-z][a-z0-9-]*$/.test(type)) {
      throw new Error(`Invalid evidence type: ${type}`);
    }
    this.#event(runId, now, type, detail);
  }

  execution(runId: string): RunExecutionRecord | null {
    const row = this.#database
      .prepare("SELECT * FROM run_execution WHERE run_id = ?")
      .get(runId) as RunExecutionRow | undefined;
    return row ? mapExecution(row) : null;
  }

  recordDelivery(runId: string, evidence: DeliveryEvidence, now: number): void {
    this.#require(runId);
    validateCiStatus(evidence.ciStatus);
    this.#database
      .prepare(`
        INSERT INTO run_delivery (
          run_id, provider, external_id, url, branch_name, base_branch,
          base_sha, head_sha, draft, ci_status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          provider = excluded.provider,
          external_id = excluded.external_id,
          url = excluded.url,
          branch_name = excluded.branch_name,
          base_branch = excluded.base_branch,
          base_sha = excluded.base_sha,
          head_sha = excluded.head_sha,
          draft = excluded.draft,
          ci_status = excluded.ci_status,
          updated_at = excluded.updated_at
      `)
      .run(
        runId,
        evidence.provider,
        evidence.externalId,
        evidence.url,
        evidence.branchName,
        evidence.baseBranch,
        evidence.baseSha,
        evidence.headSha,
        Number(evidence.draft),
        evidence.ciStatus,
        now,
      );
    this.#event(runId, now, "delivery-recorded", evidence);
  }

  updateDeliveryCi(runId: string, ciStatus: DeliveryCiStatus, now: number): RunDeliveryRecord {
    validateCiStatus(ciStatus);
    const result = this.#database
      .prepare("UPDATE run_delivery SET ci_status = ?, updated_at = ? WHERE run_id = ?")
      .run(ciStatus, now, runId);
    if (result.changes !== 1) {
      throw new Error(`Run ${runId} has no delivery record`);
    }
    this.#event(runId, now, "delivery-ci", { status: ciStatus });
    const delivery = this.delivery(runId);
    if (!delivery) {
      throw new Error(`Run ${runId} delivery disappeared after CI update`);
    }
    return delivery;
  }

  ciWait(runId: string): RunCiWaitRecord | null {
    const row = this.#database
      .prepare("SELECT * FROM run_ci_wait WHERE run_id = ?")
      .get(runId) as RunCiWaitRow | undefined;
    return row
      ? { runId: row.run_id, headSha: row.head_sha, firstPendingAt: row.first_pending_at }
      : null;
  }

  recordCiWait(runId: string, headSha: string, now: number): RunCiWaitRecord {
    this.#require(runId);
    if (headSha.trim() === "") {
      throw new Error("A CI wait clock requires a pull-request head");
    }
    const existing = this.ciWait(runId);
    if (existing && existing.headSha === headSha) {
      return existing;
    }
    this.#database
      .prepare(`
        INSERT INTO run_ci_wait (run_id, head_sha, first_pending_at) VALUES (?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          head_sha = excluded.head_sha,
          first_pending_at = excluded.first_pending_at
      `)
      .run(runId, headSha, now);
    return { runId, headSha, firstPendingAt: now };
  }

  clearCiWait(runId: string): void {
    this.#database.prepare("DELETE FROM run_ci_wait WHERE run_id = ?").run(runId);
  }

  delivery(runId: string): RunDeliveryRecord | null {
    const row = this.#database
      .prepare("SELECT * FROM run_delivery WHERE run_id = ?")
      .get(runId) as RunDeliveryRow | undefined;
    return row ? mapDelivery(row) : null;
  }

  /** Resume the one crash-interrupted execution, or open a fresh owner-authorized execution. */
  startOrResumeAutopilot(now: number): { execution: AutopilotExecutionRecord; resumed: boolean } {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const active = this.#database
        .prepare("SELECT * FROM autopilot_executions WHERE finished_at IS NULL ORDER BY started_at LIMIT 1")
        .get() as AutopilotExecutionRow | undefined;
      if (active) {
        this.#database.exec("COMMIT;");
        return { execution: mapAutopilotExecution(active), resumed: true };
      }
      const id = randomUUID();
      this.#database
        .prepare("INSERT INTO autopilot_executions (id, started_at) VALUES (?, ?)")
        .run(id, now);
      this.#database.exec("COMMIT;");
      return {
        execution: { id, startedAt: now, finishedAt: null, stopReason: null },
        resumed: false,
      };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  finishAutopilot(executionId: string, now: number, stopReason: string): void {
    const result = this.#database
      .prepare(`
        UPDATE autopilot_executions
        SET finished_at = ?, stop_reason = ?
        WHERE id = ? AND finished_at IS NULL
      `)
      .run(now, stopReason, executionId);
    if (result.changes !== 1) {
      throw new Error(`Active autopilot execution not found: ${executionId}`);
    }
  }

  recordAutopilotQuarantine(
    executionId: string,
    runId: string,
    reason: string,
    now: number,
  ): void {
    if (reason.trim() === "") throw new Error("Autopilot quarantine reason must be non-empty");
    this.#require(runId);
    const execution = this.#database
      .prepare("SELECT id FROM autopilot_executions WHERE id = ? AND finished_at IS NULL")
      .get(executionId);
    if (!execution) throw new Error(`Active autopilot execution not found: ${executionId}`);
    this.#database
      .prepare(`
        INSERT INTO autopilot_quarantines (execution_id, run_id, reason, recorded_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(execution_id, run_id) DO NOTHING
      `)
      .run(executionId, runId, reason, now);
  }

  autopilotQuarantines(executionId: string): AutopilotQuarantineRecord[] {
    const rows = this.#database.prepare(`
      SELECT q.execution_id, q.run_id, q.reason, q.recorded_at,
             r.project_id, r.task_id, r.revision
      FROM autopilot_quarantines q
      JOIN runs r ON r.id = q.run_id
      WHERE q.execution_id = ?
      ORDER BY q.recorded_at, r.project_id, r.task_id, r.revision
    `).all(executionId) as unknown as AutopilotQuarantineRow[];
    return rows.map((row) => ({
      executionId: row.execution_id,
      runId: row.run_id,
      projectId: row.project_id,
      taskId: row.task_id,
      revision: row.revision,
      reason: row.reason,
      recordedAt: row.recorded_at,
    }));
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        state TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        base_sha TEXT NOT NULL,
        head_sha TEXT,
        attempt INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        requires_reverification INTEGER NOT NULL DEFAULT 0,
        failure_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_id, task_id, revision)
      );

      CREATE TABLE IF NOT EXISTS run_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        occurred_at INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        detail_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_execution (
        run_id TEXT PRIMARY KEY REFERENCES runs(id),
        workspace_path TEXT,
        branch_name TEXT,
        worker_profile TEXT,
        worker_name TEXT,
        worker_status TEXT,
        worker_model TEXT,
        worker_session_id TEXT,
        worker_summary TEXT,
        worker_cost_usd REAL,
        worker_duration_ms INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_ci_wait (
        run_id TEXT PRIMARY KEY REFERENCES runs(id),
        head_sha TEXT NOT NULL,
        first_pending_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_delivery (
        run_id TEXT PRIMARY KEY REFERENCES runs(id),
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        url TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        draft INTEGER NOT NULL,
        ci_status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS autopilot_executions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        stop_reason TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS one_active_autopilot_execution
        ON autopilot_executions ((finished_at IS NULL))
        WHERE finished_at IS NULL;

      CREATE TABLE IF NOT EXISTS autopilot_quarantines (
        execution_id TEXT NOT NULL REFERENCES autopilot_executions(id),
        run_id TEXT NOT NULL REFERENCES runs(id),
        reason TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (execution_id, run_id)
      );
    `);
  }

  #findTaskRow(projectId: string, taskId: string, revision: string): RunRow | null {
    return (this.#database
      .prepare("SELECT * FROM runs WHERE project_id = ? AND task_id = ? AND revision = ?")
      .get(projectId, taskId, revision) as RunRow | undefined) ?? null;
  }

  #require(runId: string): RunRecord {
    const run = this.get(runId);
    if (!run) {
      throw new Error(`Unknown run: ${runId}`);
    }
    return run;
  }

  #event(runId: string, at: number, type: string, detail: unknown): void {
    this.#database
      .prepare("INSERT INTO run_events (run_id, occurred_at, event_type, detail_json) VALUES (?, ?, ?, ?)")
      .run(runId, at, type, JSON.stringify(detail));
  }
}

function addPatch(
  assignments: string[],
  values: SQLInputValue[],
  column: string,
  value: SQLInputValue | undefined,
): void {
  if (value !== undefined) {
    assignments.push(`${column} = ?`);
    values.push(value);
  }
}

function mapRun(row: RunRow): RunRecord {
  if (!RUN_STATES.includes(row.state as RunState)) {
    throw new Error(`Invalid persisted run state: ${row.state}`);
  }
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    revision: row.revision,
    state: row.state as RunState,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    requiresReverification: row.requires_reverification === 1,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAutopilotExecution(row: AutopilotExecutionRow): AutopilotExecutionRecord {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stopReason: row.stop_reason,
  };
}

function mapExecution(row: RunExecutionRow): RunExecutionRecord {
  const status = row.worker_status;
  if (status !== null && !["succeeded", "failed", "timed-out"].includes(status)) {
    throw new Error(`Invalid persisted worker status: ${status}`);
  }
  return {
    runId: row.run_id,
    workspacePath: row.workspace_path,
    branchName: row.branch_name,
    workerProfile: row.worker_profile,
    workerName: row.worker_name,
    workerStatus: status as RunExecutionRecord["workerStatus"],
    workerModel: row.worker_model,
    workerSessionId: row.worker_session_id,
    workerSummary: row.worker_summary,
    workerCostUsd: row.worker_cost_usd,
    workerDurationMs: row.worker_duration_ms,
    updatedAt: row.updated_at,
  };
}

function mapDelivery(row: RunDeliveryRow): RunDeliveryRecord {
  validateCiStatus(row.ci_status);
  return {
    runId: row.run_id,
    provider: row.provider,
    externalId: row.external_id,
    url: row.url,
    branchName: row.branch_name,
    baseBranch: row.base_branch,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    draft: row.draft === 1,
    ciStatus: row.ci_status as DeliveryCiStatus,
    updatedAt: row.updated_at,
  };
}

function validateCiStatus(value: string): asserts value is DeliveryCiStatus {
  if (!["none", "pending", "passed", "failed"].includes(value)) {
    throw new Error(`Invalid delivery CI status: ${value}`);
  }
}

function assertFailedWorkspaceRecoveryEligible(database: DatabaseSync, row: RunRow): void {
  if (row.state !== "failed") {
    throw new Error(`Run ${row.id} is not failed`);
  }
  if (!["worker-failed", "worker-timed-out"].includes(row.failure_reason ?? "")) {
    throw new Error(`Run ${row.id} is not eligible for failed-workspace recovery`);
  }
  const delivery = database
    .prepare("SELECT 1 AS present FROM run_delivery WHERE run_id = ?")
    .get(row.id) as { present: number } | undefined;
  if (delivery) {
    throw new Error(`Run ${row.id} has delivery identity and cannot recover a failed workspace`);
  }
  const execution = database
    .prepare("SELECT * FROM run_execution WHERE run_id = ?")
    .get(row.id) as RunExecutionRow | undefined;
  if (!execution?.workspace_path || !execution.branch_name) {
    throw new Error(`Run ${row.id} has no recorded failed workspace`);
  }
  if (!["failed", "timed-out"].includes(execution.worker_status ?? "")) {
    throw new Error(`Run ${row.id} does not have a failed worker result`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
