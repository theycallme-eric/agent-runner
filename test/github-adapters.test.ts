import assert from "node:assert/strict";
import test from "node:test";

import { GitHubIssueTaskProvider } from "../src/github/issue-task-provider.js";
import { GitHubNativeDependencyResolver } from "../src/github/native-dependency-resolver.js";
import type { GitHubClient, GitHubIssue } from "../src/github/types.js";
import { parseProjectContract } from "../src/project-contract.js";
import type { ProjectRegistration } from "../src/projects/types.js";
import { analyzeTaskGraph } from "../src/tasks/graph.js";

const project: ProjectRegistration = {
  id: "example/repo",
  rootPath: "/projects/example/repo",
  contractPath: "/projects/example/repo/.agent-runner.yml",
  workerProfile: "any-worker",
  enabled: true,
  contractVersion: 1,
  registeredAt: 1_000,
  updatedAt: 1_000,
};

const contract = parseProjectContract(`
version: 1
project: { id: example/repo, baseBranch: main }
tasks: { provider: github, dependencies: github-native }
workspace: { setup: [] }
verification:
  required: [npm test]
  protectedPaths: []
execution: { concurrency: 2, attempts: 2, timeoutMinutes: 10 }
delivery: { pullRequest: true, merge: never }
`);

function issue(
  number: number,
  state: GitHubIssue["state"],
  stateReason: GitHubIssue["stateReason"] = null,
  labels: string[] = [],
): GitHubIssue {
  return {
    number,
    databaseId: 1_000 + number,
    nodeId: `I_${number}`,
    repository: "example/repo",
    title: `Issue ${number}`,
    body: `Implement issue ${number}`,
    state,
    stateReason,
    updatedAt: `2026-08-${String(number).padStart(2, "0")}T12:00:00Z`,
    labels,
    url: `https://github.com/example/repo/issues/${number}`,
  };
}

test("turns GitHub issues and native blocked-by relationships into a ready DAG", async () => {
  const client: GitHubClient = {
    listIssues: async () => [issue(1, "closed", "completed"), issue(2, "open")],
    listBlockedBy: async (_repository, number) =>
      number === 2 ? [{ repository: "example/repo", number: 1 }] : [],
  };
  const provider = new GitHubIssueTaskProvider(client);
  const resolver = new GitHubNativeDependencyResolver(client, 2);

  const tasks = await provider.listTasks(project, contract);
  const resolved = await resolver.resolve(tasks, project, contract);
  const graph = analyzeTaskGraph(resolved);

  assert.deepEqual(graph.ready.map(({ id }) => id), ["issue-2"]);
  assert.deepEqual(graph.completed.map(({ id }) => id), ["issue-1"]);
  assert.deepEqual(resolved.find(({ id }) => id === "issue-2")?.dependencies, ["issue-1"]);
  assert.match(resolved[1]?.prompt ?? "", /GitHub issue #2/);
  assert.equal(resolved[1]?.revision, "I_2:2026-08-02T12:00:00Z");
});

test("maps not-planned and explicitly blocked issues to blocked tasks", async () => {
  const client: GitHubClient = {
    listIssues: async () => [
      issue(1, "closed", "not_planned"),
      issue(2, "open", null, ["agent:blocked"]),
    ],
    listBlockedBy: async () => [],
  };
  const tasks = await new GitHubIssueTaskProvider(client).listTasks(project, contract);

  assert.deepEqual(tasks.map(({ status }) => status), ["blocked", "blocked"]);
});

test("only selects issues matching every configured label", async () => {
  const configured = parseProjectContract(`
version: 1
project: { id: example/repo, baseBranch: main }
tasks:
  provider: github
  dependencies: github-native
  config:
    includeLabels: [agent:task, ready]
workspace: { setup: [] }
verification:
  required: [npm test]
  protectedPaths: []
execution: { concurrency: 1, attempts: 2, timeoutMinutes: 10 }
delivery: { pullRequest: true, merge: never }
`);
  const client: GitHubClient = {
    listIssues: async () => [
      issue(1, "open", null, ["agent:task", "ready"]),
      issue(2, "open", null, ["agent:task"]),
    ],
    listBlockedBy: async () => [],
  };

  const tasks = await new GitHubIssueTaskProvider(client).listTasks(project, configured);

  assert.deepEqual(tasks.map(({ id }) => id), ["issue-1"]);
});

test("fails closed on cross-repository dependencies", async () => {
  const client: GitHubClient = {
    listIssues: async () => [issue(1, "open")],
    listBlockedBy: async () => [{ repository: "example/other", number: 9 }],
  };
  const tasks = await new GitHubIssueTaskProvider(client).listTasks(project, contract);

  await assert.rejects(
    new GitHubNativeDependencyResolver(client).resolve(tasks, project, contract),
    /unsupported cross-repository dependency example\/other#9/,
  );
});
