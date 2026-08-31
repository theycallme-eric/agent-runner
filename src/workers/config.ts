import { readFile } from "node:fs/promises";

import { parseDocument } from "yaml";

import { ClaudeCodeWorker } from "./claude-code.js";
import { JsonProcessWorker } from "./json-process.js";
import { WorkerProfileRegistry } from "./registry.js";

export interface WorkerProfileSummary {
  profile: string;
  adapter: "claude-code" | "json-process";
  worker: string;
  model: string | null;
  environmentVariables: string[];
}

export interface LoadedWorkerProfiles {
  registry: WorkerProfileRegistry;
  summaries: WorkerProfileSummary[];
}

type Environment = Readonly<Record<string, string | undefined>>;

export async function loadWorkerProfiles(
  path: string,
  environment: Environment = process.env,
): Promise<LoadedWorkerProfiles> {
  return parseWorkerProfiles(await readFile(path, "utf8"), environment);
}

export function parseWorkerProfiles(
  source: string,
  environment: Environment = process.env,
): LoadedWorkerProfiles {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`Invalid worker profile YAML: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  const root = objectAt(document.toJS() as unknown, "worker config");
  exactKeys(root, ["version", "profiles"], "worker config");
  literal(root.version, 1, "version");
  const profiles = objectAt(root.profiles, "profiles");
  if (Object.keys(profiles).length === 0) {
    throw new Error("profiles must contain at least one worker profile");
  }

  const registry = new WorkerProfileRegistry();
  const summaries: WorkerProfileSummary[] = [];
  for (const profile of Object.keys(profiles).sort()) {
    validatePluginId(profile, `profiles.${profile}`);
    const value = objectAt(profiles[profile], `profiles.${profile}`);
    const adapter = stringAt(value.adapter, `profiles.${profile}.adapter`);
    if (adapter === "claude-code") {
      allowedKeys(
        value,
        [
          "adapter",
          "executable",
          "model",
          "maxBudgetUsd",
          "maxTurns",
          "tools",
          "settingSources",
          "persistSession",
          "environment",
        ],
        ["adapter", "model", "maxBudgetUsd", "maxTurns"],
        `profiles.${profile}`,
      );
      const environmentConfig = resolveEnvironment(
        value.environment,
        `profiles.${profile}.environment`,
        environment,
      );
      const model = stringAt(value.model, `profiles.${profile}.model`);
      const worker = new ClaudeCodeWorker({
        executable: executableAt(value.executable ?? "claude", `profiles.${profile}.executable`),
        model,
        maxBudgetUsd: positiveNumberAt(value.maxBudgetUsd, `profiles.${profile}.maxBudgetUsd`),
        maxTurns: positiveIntegerAt(value.maxTurns, `profiles.${profile}.maxTurns`),
        tools: value.tools === undefined ? [] : stringArrayAt(value.tools, `profiles.${profile}.tools`),
        settingSources: value.settingSources === undefined
          ? []
          : settingSourcesAt(value.settingSources, `profiles.${profile}.settingSources`),
        persistSession: value.persistSession === undefined
          ? false
          : booleanAt(value.persistSession, `profiles.${profile}.persistSession`),
        environment: environmentConfig.values,
      });
      registry.register(profile, worker);
      summaries.push({
        profile,
        adapter,
        worker: worker.name,
        model,
        environmentVariables: environmentConfig.sourceNames,
      });
      continue;
    }

    if (adapter === "json-process") {
      allowedKeys(
        value,
        ["adapter", "name", "executable", "arguments", "environment"],
        ["adapter", "name", "executable"],
        `profiles.${profile}`,
      );
      const environmentConfig = resolveEnvironment(
        value.environment,
        `profiles.${profile}.environment`,
        environment,
      );
      const worker = new JsonProcessWorker({
        name: pluginIdAt(value.name, `profiles.${profile}.name`),
        executable: executableAt(value.executable, `profiles.${profile}.executable`),
        arguments: value.arguments === undefined
          ? []
          : argumentArrayAt(value.arguments, `profiles.${profile}.arguments`),
        environment: environmentConfig.values,
      });
      registry.register(profile, worker);
      summaries.push({
        profile,
        adapter,
        worker: worker.name,
        model: null,
        environmentVariables: environmentConfig.sourceNames,
      });
      continue;
    }
    throw new Error(`Unsupported worker adapter for ${profile}: ${adapter}`);
  }
  return { registry, summaries };
}

function resolveEnvironment(
  value: unknown,
  path: string,
  environment: Environment,
): { values: Record<string, string>; sourceNames: string[] } {
  if (value === undefined) {
    return { values: {}, sourceNames: [] };
  }
  const entries = objectAt(value, path);
  const values: Record<string, string> = {};
  const sourceNames: string[] = [];
  for (const target of Object.keys(entries).sort()) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) {
      throw new Error(`${path} has invalid target variable: ${target}`);
    }
    const reference = objectAt(entries[target], `${path}.${target}`);
    exactKeys(reference, ["fromEnv"], `${path}.${target}`);
    const source = environmentNameAt(reference.fromEnv, `${path}.${target}.fromEnv`);
    const resolved = environment[source];
    if (resolved === undefined || resolved === "") {
      throw new Error(`${path}.${target} requires missing environment variable ${source}`);
    }
    values[target] = resolved;
    sourceNames.push(source);
  }
  return { values, sourceNames };
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error(`${path} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function positiveNumberAt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be greater than zero`);
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
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  return value.map((entry, index) => stringAt(entry, `${path}[${index}]`));
}

function argumentArrayAt(value: unknown, path: string): string[] {
  return stringArrayAt(value, path);
}

function settingSourcesAt(
  value: unknown,
  path: string,
): Array<"user" | "project" | "local"> {
  const sources = stringArrayAt(value, path);
  for (const source of sources) {
    if (source !== "user" && source !== "project" && source !== "local") {
      throw new Error(`${path} contains unsupported setting source: ${source}`);
    }
  }
  if (new Set(sources).size !== sources.length) {
    throw new Error(`${path} contains duplicate setting sources`);
  }
  return sources as Array<"user" | "project" | "local">;
}

function executableAt(value: unknown, path: string): string {
  const executable = stringAt(value, path);
  if (!/^[A-Za-z0-9_./-]+$/.test(executable) || executable.includes("..")) {
    throw new Error(`${path} must be a command name or absolute path without shell syntax`);
  }
  return executable;
}

function pluginIdAt(value: unknown, path: string): string {
  const result = stringAt(value, path);
  validatePluginId(result, path);
  return result;
}

function validatePluginId(value: string, path: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) {
    throw new Error(`${path} must be a lowercase plugin identifier`);
  }
}

function environmentNameAt(value: unknown, path: string): string {
  const result = stringAt(value, path);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(result)) {
    throw new Error(`${path} must be an environment variable name`);
  }
  return result;
}

function literal(value: unknown, expected: number, path: string): void {
  if (value !== expected) {
    throw new Error(`${path} must be ${expected}`);
  }
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
