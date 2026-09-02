#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { loadWorkerProfiles } from "../workers/config.js";
import { buildRequirements } from "./builder.js";
import { renderGitHubIssueDrafts, renderRequirementsPreview } from "./render.js";
import { analyzeRequirementsPlan, parseRequirementsPlan } from "./schema.js";

async function main(): Promise<void> {
  const [command, ...argumentsList] = process.argv.slice(2);
  switch (command) {
    case "build":
      await buildCommand(argumentsList);
      return;
    case "validate":
      await validateCommand(argumentsList);
      return;
    case "preview":
      await previewCommand(argumentsList);
      return;
    default:
      usage();
  }
}

async function buildCommand(argumentsList: string[]): Promise<void> {
  const sourcePaths = repeatedOption(argumentsList, "--source").map((path) => resolve(path));
  const output = option(argumentsList, "--output");
  const profile = option(argumentsList, "--worker");
  if (sourcePaths.length === 0 || !output || !profile) {
    usage();
    return;
  }
  const profilesPath = resolve(
    option(argumentsList, "--profiles") ??
      process.env.AGENT_RUNNER_WORKER_CONFIG ??
      join(homedir(), ".config", "agent-runner", "workers.yml"),
  );
  const timeoutMinutes = positiveOption(argumentsList, "--timeout-minutes", 30);
  const loaded = await loadWorkerProfiles(profilesPath);
  const result = await buildRequirements({
    sourcePaths,
    outputPath: resolve(output),
    worker: loaded.registry.get(profile),
    timeoutMs: timeoutMinutes * 60_000,
  });
  print(result);
}

async function validateCommand(argumentsList: string[]): Promise<void> {
  const input = argumentsList[0];
  if (!input) {
    usage();
    return;
  }
  const plan = parseRequirementsPlan(await readFile(resolve(input), "utf8"));
  const analysis = analyzeRequirementsPlan(plan);
  print({
    valid: true,
    project: plan.project.name,
    requirements: plan.requirements.length,
    tasks: plan.tasks.length,
    ...analysis,
  });
}

async function previewCommand(argumentsList: string[]): Promise<void> {
  const input = argumentsList[0];
  if (!input) {
    usage();
    return;
  }
  const plan = parseRequirementsPlan(await readFile(resolve(input), "utf8"));
  const preview = renderRequirementsPreview(plan);
  const output = option(argumentsList, "--output");
  if (output) {
    const outputPath = resolve(output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, preview, "utf8");
    const analysis = analyzeRequirementsPlan(plan);
    print({
      previewPath: outputPath,
      issueDrafts: renderGitHubIssueDrafts(plan).length,
      readyForPublishing: analysis.readyForPublishing,
    });
    return;
  }
  process.stdout.write(preview);
}

function repeatedOption(argumentsList: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argumentsList.length; index += 1) {
    if (argumentsList[index] === name) {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${name} requires a value`);
      }
      values.push(value);
      index += 1;
    }
  }
  return values;
}

function option(argumentsList: string[], name: string): string | null {
  const index = argumentsList.indexOf(name);
  const value = index === -1 ? undefined : argumentsList[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function positiveOption(argumentsList: string[], name: string, fallback: number): number {
  const raw = option(argumentsList, name);
  if (raw === null) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function usage(): void {
  console.error(`Usage:
  requirements-builder build --source <file|directory|zip> [--source <path> ...]
    --output <directory> --worker <profile> [--profiles <worker-config>]
    [--timeout-minutes <count>]
  requirements-builder validate <requirements-plan.json>
  requirements-builder preview <requirements-plan.json> [--output <preview.md>]`);
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
