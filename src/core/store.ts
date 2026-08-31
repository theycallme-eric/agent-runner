import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  RUN_STATES,
  type CapacityClaimResult,
  type ClaimRequest,
  type ClaimResult,
  type ReclaimResult,
  type RunRecord,
  type RunState,
} from "./types.js";

const ALLOWED_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  discovered: ["claimed"],
  claimed: ["workspace-ready", "failed"],
  "workspace-ready": ["running", "failed"],
  running: ["verifying", "failed"],
  verifying: ["synchronized", "pr-open", "waiting-human", "failed"],
  synchronized: ["verifying", "failed"],
  "pr-open": ["ci", "waiting-human", "failed"],
  ci: ["completed", "waiting-human", "failed"],
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

  #claimTransaction(request: ClaimRequest, maxActive: number | null): CapacityClaimResult {
    const id = randomUUID();
    const expiresAt = request.now + request.leaseDurationMs;

    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.#findTaskRow(request.projectId, request.taskId, request.revision);
      if (existing) {
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
