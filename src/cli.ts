#!/usr/bin/env node

import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { loadProjectContract } from "./project-contract.js";

async function main(): Promise<void> {
  const [command, ...argumentsList] = process.argv.slice(2);
  switch (command) {
    case "validate":
      await validateCommand(argumentsList);
      return;
    case "register":
      await registerCommand(argumentsList);
      return;
    case "projects":
    case "status":
      await projectsCommand(argumentsList);
      return;
    case "ready":
      await readyCommand(argumentsList);
      return;
    default:
      usage();
  }
}

async function validateCommand(argumentsList: string[]): Promise<void> {
  const input = argumentsList[0];
  if (!input) {
    usage();
    return;
  }
  const contractPath = await resolveContractPath(input);
  const contract = await loadProjectContract(contractPath);
  print({
    valid: true,
    project: contract.project.id,
    taskProvider: contract.tasks.provider,
    verificationCommands: contract.verification.required.length,
    mergePolicy: contract.delivery.merge,
  });
}

async function registerCommand(argumentsList: string[]): Promise<void> {
  const rootPath = argumentsList[0];
  const workerProfile = option(argumentsList, "--worker");
  if (!rootPath || !workerProfile) {
    usage();
    return;
  }
  const statePath = statePathFrom(argumentsList);
  await mkdir(dirname(statePath), { recursive: true });
  const [{ onboardProject }, { ProjectRegistryStore }] = await Promise.all([
    import("./projects/onboarding.js"),
    import("./projects/registry.js"),
  ]);
  const registry = new ProjectRegistryStore(statePath);
  try {
    const result = await onboardProject(registry, {
      rootPath,
      workerProfile,
      now: Date.now(),
    });
    print({
      created: result.created,
      project: result.project.id,
      workerProfile: result.project.workerProfile,
      enabled: result.project.enabled,
    });
  } finally {
    registry.close();
  }
}

async function projectsCommand(argumentsList: string[]): Promise<void> {
  const statePath = statePathFrom(argumentsList);
  await mkdir(dirname(statePath), { recursive: true });
  const { ProjectRegistryStore } = await import("./projects/registry.js");
  const registry = new ProjectRegistryStore(statePath);
  try {
    print({
      projects: registry.list().map((project) => ({
        id: project.id,
        rootPath: project.rootPath,
        workerProfile: project.workerProfile,
        enabled: project.enabled,
        contractVersion: project.contractVersion,
      })),
    });
  } finally {
    registry.close();
  }
}

async function readyCommand(argumentsList: string[]): Promise<void> {
  const projectId = argumentsList[0];
  if (!projectId) {
    usage();
    return;
  }
  const statePath = statePathFrom(argumentsList);
  const [
    { ProjectRegistryStore },
    { TaskProviderRegistry },
    { DependencyResolverRegistry },
    { registerGitHubAdapters },
    { analyzeTaskGraph },
  ] = await Promise.all([
    import("./projects/registry.js"),
    import("./tasks/provider-registry.js"),
    import("./tasks/dependency-registry.js"),
    import("./github/register.js"),
    import("./tasks/graph.js"),
  ]);
  const registry = new ProjectRegistryStore(statePath);
  try {
    const project = registry.get(projectId);
    if (!project) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    if (!project.enabled) {
      throw new Error(`Project ${projectId} is disabled`);
    }
    const contract = await loadProjectContract(project.contractPath);
    const providers = new TaskProviderRegistry();
    const dependencies = new DependencyResolverRegistry();
    registerGitHubAdapters(
      providers,
      dependencies,
      process.env.AGENT_RUNNER_GH_BIN ?? "gh",
    );
    const provider = providers.get(contract.tasks.provider);
    const dependencyResolver = dependencies.get(contract.tasks.dependencies);
    const discovered = await provider.listTasks(project, contract);
    const graph = analyzeTaskGraph(
      await dependencyResolver.resolve(discovered, project, contract),
    );
    print({
      project: project.id,
      provider: provider.name,
      dependencies: dependencyResolver.name,
      ready: graph.ready.map((task) => ({ id: task.id, title: task.title })),
      waiting: graph.waiting.map((task) => task.id),
      blocked: graph.blocked.map((task) => task.id),
      completed: graph.completed.map((task) => task.id),
      edges: graph.edgeCount,
    });
  } finally {
    registry.close();
  }
}

async function resolveContractPath(input: string): Promise<string> {
  const path = resolve(input);
  try {
    return (await stat(path)).isDirectory() ? join(path, ".agent-runner.yml") : path;
  } catch {
    return path;
  }
}

function statePathFrom(argumentsList: string[]): string {
  const explicit = option(argumentsList, "--state");
  if (explicit) {
    return resolve(explicit);
  }
  const configured = process.env.AGENT_RUNNER_STATE_PATH;
  return configured
    ? resolve(configured)
    : join(homedir(), ".local", "state", "agent-runner", "state.sqlite");
}

function option(argumentsList: string[], name: string): string | null {
  const index = argumentsList.indexOf(name);
  const value = index === -1 ? undefined : argumentsList[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function usage(): void {
  console.error(`Usage:
  agent-runner validate <project-or-contract>
  agent-runner register <project-root> --worker <profile> [--state <database>]
  agent-runner projects [--state <database>]
  agent-runner status [--state <database>]
  agent-runner ready <project-id> [--state <database>]`);
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
