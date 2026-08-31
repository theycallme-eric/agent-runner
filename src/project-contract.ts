import { readFile } from "node:fs/promises";

import { parseDocument } from "yaml";

export interface ProjectContract {
  version: 1;
  project: {
    id: string;
    baseBranch: string;
  };
  tasks: {
    provider: string;
    dependencies: string;
    config: Record<string, unknown>;
  };
  workspace: {
    setup: string[];
  };
  verification: {
    required: string[];
    protectedPaths: Array<{
      pattern: string;
      gate: "human";
    }>;
  };
  execution: {
    concurrency: number;
    attempts: number;
    timeoutMinutes: number;
  };
  delivery: {
    pullRequest: boolean;
    merge: "never";
  };
}

export async function loadProjectContract(path: string): Promise<ProjectContract> {
  return parseProjectContract(await readFile(path, "utf8"));
}

export function parseProjectContract(source: string): ProjectContract {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`Invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  const value = document.toJS() as unknown;
  const root = objectAt(value, "contract");
  exactKeys(root, ["version", "project", "tasks", "workspace", "verification", "execution", "delivery"], "contract");
  literal(root.version, 1, "version");

  const project = objectAt(root.project, "project");
  exactKeys(project, ["id", "baseBranch"], "project");

  const tasks = objectAt(root.tasks, "tasks");
  allowedKeys(tasks, ["provider", "dependencies", "config"], ["provider", "dependencies"], "tasks");

  const workspace = objectAt(root.workspace, "workspace");
  exactKeys(workspace, ["setup"], "workspace");

  const verification = objectAt(root.verification, "verification");
  exactKeys(verification, ["required", "protectedPaths"], "verification");
  const protectedPaths = arrayAt(verification.protectedPaths, "verification.protectedPaths").map(
    (entry, index) => {
      const item = objectAt(entry, `verification.protectedPaths[${index}]`);
      exactKeys(item, ["pattern", "gate"], `verification.protectedPaths[${index}]`);
      literal(item.gate, "human", `verification.protectedPaths[${index}].gate`);
      return {
        pattern: stringAt(item.pattern, `verification.protectedPaths[${index}].pattern`),
        gate: "human" as const,
      };
    },
  );

  const execution = objectAt(root.execution, "execution");
  exactKeys(execution, ["concurrency", "attempts", "timeoutMinutes"], "execution");

  const delivery = objectAt(root.delivery, "delivery");
  exactKeys(delivery, ["pullRequest", "merge"], "delivery");
  literal(delivery.merge, "never", "delivery.merge");

  return {
    version: 1,
    project: {
      id: stringAt(project.id, "project.id"),
      baseBranch: stringAt(project.baseBranch, "project.baseBranch"),
    },
    tasks: {
      provider: pluginIdAt(tasks.provider, "tasks.provider"),
      dependencies: pluginIdAt(tasks.dependencies, "tasks.dependencies"),
      config: tasks.config === undefined ? {} : objectAt(tasks.config, "tasks.config"),
    },
    workspace: {
      setup: stringArrayAt(workspace.setup, "workspace.setup"),
    },
    verification: {
      required: nonEmptyStringArrayAt(verification.required, "verification.required"),
      protectedPaths,
    },
    execution: {
      concurrency: positiveIntegerAt(execution.concurrency, "execution.concurrency"),
      attempts: positiveIntegerAt(execution.attempts, "execution.attempts"),
      timeoutMinutes: positiveIntegerAt(execution.timeoutMinutes, "execution.timeoutMinutes"),
    },
    delivery: {
      pullRequest: booleanAt(delivery.pullRequest, "delivery.pullRequest"),
      merge: "never",
    },
  };
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  return value;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function positiveIntegerAt(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${path} must be a positive integer`);
  }
  return value as number;
}

function stringArrayAt(value: unknown, path: string): string[] {
  return arrayAt(value, path).map((entry, index) => stringAt(entry, `${path}[${index}]`));
}

function nonEmptyStringArrayAt(value: unknown, path: string): string[] {
  const result = stringArrayAt(value, path);
  if (result.length === 0) {
    throw new Error(`${path} must contain at least one command`);
  }
  return result;
}

function literal(value: unknown, expected: string | number, path: string): void {
  if (value !== expected) {
    throw new Error(`${path} must be ${JSON.stringify(expected)}`);
  }
}

function pluginIdAt(value: unknown, path: string): string {
  const result = stringAt(value, path);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(result)) {
    throw new Error(`${path} must be a lowercase plugin identifier`);
  }
  return result;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  allowedKeys(value, expected, expected, path);
}

function allowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  const missing = required.filter((key) => !(key in value));
  if (unknown.length > 0) {
    throw new Error(`${path} has unknown fields: ${unknown.join(", ")}`);
  }
  if (missing.length > 0) {
    throw new Error(`${path} is missing fields: ${missing.join(", ")}`);
  }
}
