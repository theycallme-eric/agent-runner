import { isAbsolute, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ProjectRegistration,
  RegisterProjectRequest,
  RegisterProjectResult,
} from "./types.js";

interface ProjectRow {
  id: string;
  root_path: string;
  contract_path: string;
  worker_profile: string;
  enabled: number;
  contract_version: number;
  registered_at: number;
  updated_at: number;
}

export class ProjectRegistryStore {
  readonly #database: DatabaseSync;

  constructor(path = ":memory:") {
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") {
      this.#database.exec("PRAGMA journal_mode = WAL;");
    }
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL UNIQUE,
        contract_path TEXT NOT NULL,
        worker_profile TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        contract_version INTEGER NOT NULL,
        registered_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.#database.close();
  }

  register(request: RegisterProjectRequest): RegisterProjectResult {
    validateRegistration(request);
    const existingById = this.get(request.id);
    if (existingById) {
      if (
        existingById.rootPath !== request.rootPath ||
        existingById.contractPath !== request.contractPath ||
        existingById.workerProfile !== request.workerProfile ||
        existingById.contractVersion !== request.contractVersion
      ) {
        throw new Error(`Project ${request.id} is already registered with different settings`);
      }
      return { created: false, project: existingById };
    }

    const existingPath = this.#database
      .prepare("SELECT id FROM projects WHERE root_path = ?")
      .get(request.rootPath) as { id: string } | undefined;
    if (existingPath) {
      throw new Error(`Project root is already registered as ${existingPath.id}`);
    }

    this.#database
      .prepare(`
        INSERT INTO projects (
          id, root_path, contract_path, worker_profile, enabled,
          contract_version, registered_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      `)
      .run(
        request.id,
        request.rootPath,
        request.contractPath,
        request.workerProfile,
        request.contractVersion,
        request.now,
        request.now,
      );
    return { created: true, project: this.#require(request.id) };
  }

  get(id: string): ProjectRegistration | null {
    const row = this.#database
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(id) as ProjectRow | undefined;
    return row ? mapProject(row) : null;
  }

  list(): ProjectRegistration[] {
    const rows = this.#database
      .prepare("SELECT * FROM projects ORDER BY id")
      .all() as unknown as ProjectRow[];
    return rows.map(mapProject);
  }

  setEnabled(id: string, enabled: boolean, now: number): ProjectRegistration {
    const result = this.#database
      .prepare("UPDATE projects SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(Number(enabled), now, id);
    if (result.changes !== 1) {
      throw new Error(`Unknown project: ${id}`);
    }
    return this.#require(id);
  }

  setWorkerProfile(id: string, workerProfile: string, now: number): ProjectRegistration {
    validatePluginId(workerProfile, "workerProfile");
    const result = this.#database
      .prepare("UPDATE projects SET worker_profile = ?, updated_at = ? WHERE id = ?")
      .run(workerProfile, now, id);
    if (result.changes !== 1) {
      throw new Error(`Unknown project: ${id}`);
    }
    return this.#require(id);
  }

  #require(id: string): ProjectRegistration {
    const project = this.get(id);
    if (!project) {
      throw new Error(`Unknown project: ${id}`);
    }
    return project;
  }
}

function validateRegistration(request: RegisterProjectRequest): void {
  if (request.id.trim() === "") {
    throw new Error("Project id must be non-empty");
  }
  if (!isAbsolute(request.rootPath) || !isAbsolute(request.contractPath)) {
    throw new Error("Project root and contract paths must be absolute");
  }
  const contractRelative = relative(request.rootPath, request.contractPath);
  if (!contractRelative.startsWith("..") && !isAbsolute(contractRelative)) {
    throw new Error("Project contract must be outside the product root");
  }
  validatePluginId(request.workerProfile, "workerProfile");
  if (!Number.isInteger(request.contractVersion) || request.contractVersion < 1) {
    throw new Error("contractVersion must be a positive integer");
  }
}

function validatePluginId(value: string, path: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) {
    throw new Error(`${path} must be a lowercase plugin identifier`);
  }
}

function mapProject(row: ProjectRow): ProjectRegistration {
  return {
    id: row.id,
    rootPath: row.root_path,
    contractPath: row.contract_path,
    workerProfile: row.worker_profile,
    enabled: row.enabled === 1,
    contractVersion: row.contract_version,
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
  };
}
