#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
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
    case "create-project":
      await createProjectCommand(argumentsList);
      return;
    case "projects":
    case "status":
      await projectsCommand(argumentsList);
      return;
    case "ready":
      await readyCommand(argumentsList);
      return;
    case "profiles":
      await profilesCommand(argumentsList);
      return;
    case "run-once":
      await runOnceCommand(argumentsList);
      return;
    case "autopilot":
      await autopilotCommand(argumentsList);
      return;
    default:
      usage();
  }
}

async function createProjectCommand(argumentsList: string[]): Promise<void> {
  const rootPath = argumentsList[0];
  const contractPath = option(argumentsList, "--contract");
  const workerProfile = option(argumentsList, "--worker");
  const visibility = option(argumentsList, "--visibility");
  if (
    !rootPath ||
    !contractPath ||
    !workerProfile ||
    (visibility !== "public" && visibility !== "private") ||
    !argumentsList.includes("--confirm-create")
  ) {
    usage();
    return;
  }
  const statePath = statePathFrom(argumentsList);
  await mkdir(dirname(statePath), { recursive: true });
  const [{ createProjectRepository }, { ProjectRegistryStore }] = await Promise.all([
    import("./projects/onboarding.js"),
    import("./projects/registry.js"),
  ]);
  const registry = new ProjectRegistryStore(statePath);
  try {
    const result = await createProjectRepository(registry, {
      rootPath,
      contractPath,
      workerProfile,
      visibility,
      confirmed: true,
      now: Date.now(),
      gitExecutable: process.env.AGENT_RUNNER_GIT_BIN ?? "git",
      ghExecutable: process.env.AGENT_RUNNER_GH_BIN ?? "gh",
    });
    print({
      created: result.created,
      repositoryCreated: result.repositoryCreated,
      initialBranchPushed: result.initialBranchPushed,
      project: result.project.id,
      repositoryPath: result.project.rootPath,
      contractPath: result.project.contractPath,
      workerProfile: result.project.workerProfile,
      enabled: result.project.enabled,
    });
  } finally {
    registry.close();
  }
}

async function validateCommand(argumentsList: string[]): Promise<void> {
  const input = argumentsList[0];
  if (!input) {
    usage();
    return;
  }
  const contractPath = resolve(input);
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
  const contractPath = option(argumentsList, "--contract");
  const workerProfile = option(argumentsList, "--worker");
  if (!rootPath || !contractPath || !workerProfile) {
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
      contractPath,
      workerProfile,
      now: Date.now(),
      gitExecutable: process.env.AGENT_RUNNER_GIT_BIN ?? "git",
    });
    print({
      created: result.created,
      project: result.project.id,
      repositoryPath: result.project.rootPath,
      contractPath: result.project.contractPath,
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
        contractPath: project.contractPath,
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

async function profilesCommand(argumentsList: string[]): Promise<void> {
  const path = workerConfigPathFrom(argumentsList);
  const { loadWorkerProfiles } = await import("./workers/config.js");
  const loaded = await loadWorkerProfiles(path, process.env, []);
  print({ path, profiles: loaded.summaries });
}

async function runOnceCommand(argumentsList: string[]): Promise<void> {
  const projectId = argumentsList[0];
  if (!projectId) {
    usage();
    return;
  }
  const statePath = statePathFrom(argumentsList);
  const profilesPath = workerConfigPathFrom(argumentsList);
  const workspaceRoot = option(argumentsList, "--workspace-root")
    ? resolve(option(argumentsList, "--workspace-root") ?? "")
    : join(dirname(statePath), "workspaces");
  const maxClaims = positiveOption(argumentsList, "--limit", 1);
  const targetTaskId = option(argumentsList, "--task");
  const leaseDurationMs = positiveOption(argumentsList, "--lease-seconds", 300) * 1_000;
  const controllerId = option(argumentsList, "--controller") ?? `${hostname()}-${process.pid}`;
  const dryRun = argumentsList.includes("--dry-run");
  const ghExecutable = process.env.AGENT_RUNNER_GH_BIN ?? "gh";
  const gitExecutable = process.env.AGENT_RUNNER_GIT_BIN ?? "git";
  await mkdir(dirname(statePath), { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  const [
    { ProjectRegistryStore },
    { RunStore },
    { TaskProviderRegistry },
    { DependencyResolverRegistry },
    { registerGitHubAdapters },
    { ProjectPlanner },
    { loadWorkerProfiles },
    { GitWorktreeManager },
    { GitWorkspaceRepository },
    { GitRemoteBaseRevisionProvider },
    { PullRequestPublisherRegistry },
    { GitHubPullRequestPublisher },
    { ShellCommandRunner },
    { RunOnceController },
  ] = await Promise.all([
    import("./projects/registry.js"),
    import("./core/store.js"),
    import("./tasks/provider-registry.js"),
    import("./tasks/dependency-registry.js"),
    import("./github/register.js"),
    import("./planning/project-planner.js"),
    import("./workers/config.js"),
    import("./workspaces/git-worktree.js"),
    import("./workspaces/git-repository.js"),
    import("./workspaces/base-revision.js"),
    import("./delivery/registry.js"),
    import("./github/pull-request-publisher.js"),
    import("./execution/command-runner.js"),
    import("./runtime/run-once.js"),
  ]);
  const projects = new ProjectRegistryStore(statePath);
  const runs = new RunStore(statePath);
  try {
    const providers = new TaskProviderRegistry();
    const dependencies = new DependencyResolverRegistry();
    registerGitHubAdapters(providers, dependencies, ghExecutable);
    const planner = new ProjectPlanner(runs, providers, dependencies);
    const selectedProject = projects.get(projectId);
    const workers = await loadWorkerProfiles(
      profilesPath,
      process.env,
      selectedProject ? [selectedProject.workerProfile] : [],
    );
    const publishers = new PullRequestPublisherRegistry();
    publishers.register(new GitHubPullRequestPublisher({ ghExecutable, gitExecutable }));
    const repository = new GitWorkspaceRepository(gitExecutable);
    const baseRevisions = new GitRemoteBaseRevisionProvider(gitExecutable);
    const controller = new RunOnceController(
      projects,
      runs,
      planner,
      workers.registry,
      new GitWorktreeManager(workspaceRoot, gitExecutable),
      repository,
      baseRevisions,
      publishers,
      new ShellCommandRunner(),
    );
    const result = await controller.run({
      projectId,
      controllerId,
      leaseDurationMs,
      maxClaims,
      dryRun,
      targetTaskId,
    });
    print(result);
    if (!result.ok) {
      process.exitCode = 1;
    }
  } finally {
    runs.close();
    projects.close();
  }
}

async function autopilotCommand(argumentsList: string[]): Promise<void> {
  const statePath = statePathFrom(argumentsList);
  const profilesPath = workerConfigPathFrom(argumentsList);
  const workspaceRoot = option(argumentsList, "--workspace-root")
    ? resolve(option(argumentsList, "--workspace-root") ?? "")
    : join(dirname(statePath), "workspaces");
  const enabled = argumentsList.includes("--enable");
  const minutes = positiveOption(argumentsList, "--minutes", 480);
  const maxNewClaims = positiveOption(argumentsList, "--max-new-claims", 10);
  const maxNoProgressPasses = positiveOption(argumentsList, "--no-progress-passes", 3);
  const pollIntervalMs = positiveOption(argumentsList, "--poll-seconds", 60) * 1_000;
  const globalConcurrency = positiveOption(argumentsList, "--concurrency", 1);
  const leaseDurationMs = positiveOption(argumentsList, "--lease-seconds", 300) * 1_000;
  const controllerId = option(argumentsList, "--controller") ?? `${hostname()}-${process.pid}`;
  const ghExecutable = process.env.AGENT_RUNNER_GH_BIN ?? "gh";
  const gitExecutable = process.env.AGENT_RUNNER_GIT_BIN ?? "git";
  await mkdir(dirname(statePath), { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  const [
    { ProjectRegistryStore },
    { RunStore },
    { TaskProviderRegistry },
    { DependencyResolverRegistry },
    { registerGitHubAdapters },
    { ProjectPlanner },
    { loadWorkerProfiles },
    { GitWorktreeManager },
    { GitWorkspaceRepository },
    { GitRemoteBaseRevisionProvider },
    { PullRequestPublisherRegistry },
    { GitHubPullRequestPublisher },
    { ShellCommandRunner },
    { RunOnceController },
    { AutopilotController },
  ] = await Promise.all([
    import("./projects/registry.js"),
    import("./core/store.js"),
    import("./tasks/provider-registry.js"),
    import("./tasks/dependency-registry.js"),
    import("./github/register.js"),
    import("./planning/project-planner.js"),
    import("./workers/config.js"),
    import("./workspaces/git-worktree.js"),
    import("./workspaces/git-repository.js"),
    import("./workspaces/base-revision.js"),
    import("./delivery/registry.js"),
    import("./github/pull-request-publisher.js"),
    import("./execution/command-runner.js"),
    import("./runtime/run-once.js"),
    import("./autopilot/controller.js"),
  ]);
  const projects = new ProjectRegistryStore(statePath);
  const runs = new RunStore(statePath);
  try {
    const providers = new TaskProviderRegistry();
    const dependencies = new DependencyResolverRegistry();
    registerGitHubAdapters(providers, dependencies, ghExecutable);
    const selectedProfiles = [...new Set(
      projects.list().filter((project) => project.enabled).map((project) => project.workerProfile),
    )];
    const workers = await loadWorkerProfiles(profilesPath, process.env, selectedProfiles);
    const publishers = new PullRequestPublisherRegistry();
    publishers.register(new GitHubPullRequestPublisher({ ghExecutable, gitExecutable }));
    const repository = new GitWorkspaceRepository(gitExecutable);
    const baseRevisions = new GitRemoteBaseRevisionProvider(gitExecutable);
    const runOnce = new RunOnceController(
      projects,
      runs,
      new ProjectPlanner(runs, providers, dependencies),
      workers.registry,
      new GitWorktreeManager(workspaceRoot, gitExecutable),
      repository,
      baseRevisions,
      publishers,
      new ShellCommandRunner(),
    );
    const startedAt = Date.now();
    const result = await new AutopilotController(projects, runs, runOnce).run({
      enabled,
      controllerId,
      leaseDurationMs,
      deadlineAt: startedAt + minutes * 60_000,
      maxNewClaims,
      maxNoProgressPasses,
      pollIntervalMs,
      globalConcurrency,
    });
    print(result);
    if (["run-failure", "worker-unavailable", "quota-unavailable"].includes(result.stopReason)) {
      process.exitCode = 1;
    }
  } finally {
    runs.close();
    projects.close();
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

function workerConfigPathFrom(argumentsList: string[]): string {
  const explicit = option(argumentsList, "--profiles");
  if (explicit) {
    return resolve(explicit);
  }
  const configured = process.env.AGENT_RUNNER_WORKER_CONFIG;
  return configured
    ? resolve(configured)
    : join(homedir(), ".config", "agent-runner", "workers.yml");
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
  agent-runner validate <external-project-contract>
  agent-runner register <product-repository> --contract <external-project-contract>
    --worker <profile> [--state <database>]
  agent-runner create-project <new-product-directory> --contract <external-project-contract>
    --worker <profile> --visibility <public|private> --confirm-create [--state <database>]
  agent-runner projects [--state <database>]
  agent-runner status [--state <database>]
  agent-runner ready <project-id> [--state <database>]
  agent-runner profiles [--profiles <worker-config>]
  agent-runner run-once <project-id> [--dry-run] [--limit <count>] [--task <task-id>]
    [--state <database>] [--profiles <worker-config>] [--workspace-root <directory>]
    [--controller <id>] [--lease-seconds <seconds>]
  agent-runner autopilot --enable [--minutes <count>] [--max-new-claims <count>]
    [--concurrency <count>] [--no-progress-passes <count>] [--poll-seconds <seconds>]
    [--state <database>]
    [--profiles <worker-config>] [--workspace-root <directory>] [--controller <id>]
    [--lease-seconds <seconds>]`);
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
