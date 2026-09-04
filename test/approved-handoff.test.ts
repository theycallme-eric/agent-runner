import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseApprovedHandoff } from "../src/github/approved-handoff.js";
import { GitHubIssueTaskProvider } from "../src/github/issue-task-provider.js";
import { GitHubNativeDependencyResolver } from "../src/github/native-dependency-resolver.js";
import type { GitHubClient, GitHubIssue } from "../src/github/types.js";
import { parseProjectContract } from "../src/project-contract.js";
import type { ProjectRegistration } from "../src/projects/types.js";
import { analyzeTaskGraph } from "../src/tasks/graph.js";

test("consumes one active exact handoff while preserving requirements task identity", async () => {
  const fixture = approvedFixture();
  try {
    const client = clientFor(fixture.issues, new Map([[2, [1]]]));
    const provider = new GitHubIssueTaskProvider(client);
    const resolver = new GitHubNativeDependencyResolver(client);
    const tasks = await provider.listTasks(fixture.project, fixture.contract);
    const resolved = await resolver.resolve(tasks, fixture.project, fixture.contract);
    const graph = analyzeTaskGraph(resolved);

    assert.deepEqual(resolved.map(({ id }) => id), ["TASK-001", "TASK-002"]);
    assert.deepEqual(resolved[1]?.dependencies, ["TASK-001"]);
    assert.deepEqual(graph.ready.map(({ id }) => id), ["TASK-001"]);
    assert.deepEqual(graph.waiting.map(({ id }) => id), ["TASK-002"]);
    assert.deepEqual(resolved[0]?.requirementIds, ["REQ-001"]);
    assert.deepEqual(resolved[0]?.sourceRefs, ["sources/design.md"]);
    assert.match(resolved[0]?.prompt ?? "", /independently/);
    assert.match(resolved[0]?.revision ?? "", /^([a-f0-9]{64}):TASK-001$/);
  } finally {
    fixture.remove();
  }
});

test("fails closed on inactive approval, issue drift, and native dependency drift", async () => {
  const inactive = approvedFixture({ active: false });
  try {
    await assert.rejects(
      () => new GitHubIssueTaskProvider(clientFor(inactive.issues, new Map([[2, [1]]])))
        .listTasks(inactive.project, inactive.contract),
      /not the active external owner approval/,
    );
  } finally {
    inactive.remove();
  }

  const edited = approvedFixture();
  try {
    edited.issues[0]!.title = "Changed after approval";
    await assert.rejects(
      () => new GitHubIssueTaskProvider(clientFor(edited.issues, new Map([[2, [1]]])))
        .listTasks(edited.project, edited.contract),
      /drifted from approved task TASK-001/,
    );
  } finally {
    edited.remove();
  }

  const dependency = approvedFixture();
  try {
    const client = clientFor(dependency.issues, new Map());
    const provider = new GitHubIssueTaskProvider(client);
    const tasks = await provider.listTasks(dependency.project, dependency.contract);
    await assert.rejects(
      () => new GitHubNativeDependencyResolver(client).resolve(
        tasks,
        dependency.project,
        dependency.contract,
      ),
      /dependencies for TASK-002 drifted/,
    );
  } finally {
    dependency.remove();
  }
});

test("rejects modified, unknown-version, and product-injected handoffs", async () => {
  const fixture = approvedFixture();
  try {
    const handoff = JSON.parse(fixture.handoffText) as { version: number; tasks: Array<{ title: string }> };
    handoff.tasks[0]!.title = "Tampered";
    assert.throws(() => parseApprovedHandoff(JSON.stringify(handoff)), /hash does not match/);
    handoff.version = 3;
    assert.throws(() => parseApprovedHandoff(JSON.stringify(handoff)), /handoff.version must be 2/);

    const injectedPath = join(fixture.productRoot, "APPROVED_HANDOFF.json");
    writeFileSync(injectedPath, fixture.handoffText);
    const injectedContract = parseProjectContract(contractText(injectedPath));
    await assert.rejects(
      () => new GitHubIssueTaskProvider(clientFor(fixture.issues, new Map([[2, [1]]])))
        .listTasks(fixture.project, injectedContract),
      /must remain outside the product repository/,
    );
  } finally {
    fixture.remove();
  }
});

function approvedFixture(options: { active?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "approved-handoff-"));
  const productRoot = join(root, "product");
  const controllerRoot = join(root, "controller");
  mkdirSync(productRoot, { recursive: true });
  mkdirSync(controllerRoot, { recursive: true });
  const setId = "a".repeat(64);
  const labels = ["agent:task", "requirements:approved"];
  const bodies = [1, 2].map((number) => [
    "## Requirements context",
    "",
    "### REQ-001 — Synthetic capability",
    "",
    "Design evidence: `sources/design.md`",
    "",
    "## Acceptance criteria",
    "",
    `- [ ] Task ${number} works.`,
    "",
    "## Verification",
    "",
    `- npm test -- task-${number}`,
    "",
    `<!-- requirements-builder:managed set=${setId} task=TASK-00${number} -->`,
  ].join("\n"));
  const issues = [
    githubIssue(1, 101, "[TASK-001] First", bodies[0]!, labels),
    githubIssue(2, 102, "[TASK-002] Second", bodies[1]!, labels),
  ];
  const graphUnsigned = {
    version: 1,
    repository: "example/repo",
    requirementsSetId: setId,
    requirementsRevision: 1,
    requirementsRevisionSha256: "b".repeat(64),
    issues: issues.map((issue, index) => ({
      taskId: `TASK-00${index + 1}`,
      issueNumber: issue.number,
      databaseId: issue.databaseId,
      title: issue.title,
      body: issue.body,
      labels: [...labels],
      sourceRefs: ["sources/design.md"],
      blockedByTaskIds: index === 0 ? [] : ["TASK-001"],
    })),
  };
  const graph = { ...graphUnsigned, graphSha256: hash(graphUnsigned) };
  const approvalUnsigned = {
    version: 1,
    approval: 1,
    approvedAt: "2026-09-02T22:05:00.000Z",
    approvedBy: "fixture-owner",
    graph,
  };
  const approval = { ...approvalUnsigned, approvalSha256: hash(approvalUnsigned) };
  const approvalRecordPath = join(controllerRoot, "approval.json");
  const approvalPointerPath = join(controllerRoot, "CURRENT_APPROVAL.json");
  writeFileSync(approvalRecordPath, `${JSON.stringify(approval, null, 2)}\n`);
  writeFileSync(approvalPointerPath, `${JSON.stringify({
    version: 1,
    active: options.active ?? true,
    approvalPath: approvalRecordPath,
    approvalSha256: approval.approvalSha256,
    graphSha256: graph.graphSha256,
    reason: "fixture",
  }, null, 2)}\n`);
  const handoffUnsigned = {
    version: 2,
    createdAt: "2026-09-02T22:06:00.000Z",
    repository: "example/repo",
    baseBranch: "main",
    requirementsSetId: setId,
    requirementsRevision: 1,
    requirementsRevisionSha256: "b".repeat(64),
    approval: 1,
    approvalSha256: approval.approvalSha256,
    approvedBy: "fixture-owner",
    graphSha256: graph.graphSha256,
    approvalPointerPath,
    approvalRecordPath,
    repositoryReadiness: {
      runtime: "Node.js 24",
      dependencyInstallCommand: null,
      verificationCommands: ["npm test"],
    },
    executionPrerequisites: [],
    tasks: graph.issues.map((issue) => ({
      taskId: issue.taskId,
      issueNumber: issue.issueNumber,
      databaseId: issue.databaseId,
      title: issue.title,
      prompt: issue.body,
      labels: issue.labels,
      requirementIds: ["REQ-001"],
      sourceRefs: issue.sourceRefs,
      acceptanceCriteria: [`Task ${issue.issueNumber} works.`],
      verificationExpectations: [`npm test -- task-${issue.issueNumber}`],
      dependencies: issue.blockedByTaskIds,
      prerequisiteIds: [],
    })),
  };
  const handoff = { ...handoffUnsigned, handoffSha256: hash(handoffUnsigned) };
  const handoffText = `${JSON.stringify(handoff, null, 2)}\n`;
  const handoffPath = join(controllerRoot, "APPROVED_HANDOFF.json");
  const contractPath = join(controllerRoot, "project.yml");
  writeFileSync(handoffPath, handoffText);
  writeFileSync(contractPath, contractText(handoffPath));
  const contract = parseProjectContract(contractText(handoffPath));
  const project: ProjectRegistration = {
    id: "example/repo",
    rootPath: realpathSync(productRoot),
    contractPath: realpathSync(contractPath),
    workerProfile: "fixture-worker",
    enabled: true,
    contractVersion: 1,
    registeredAt: 1,
    updatedAt: 1,
  };
  return {
    root,
    productRoot,
    issues,
    handoffText,
    contract,
    project,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

function contractText(handoffPath: string): string {
  return `version: 1
project: { id: example/repo, baseBranch: main }
tasks:
  provider: github
  dependencies: github-native
  config:
    includeLabels: [agent:task]
    approvedHandoff: ${JSON.stringify(handoffPath)}
workspace: { setup: [] }
verification:
  required: [npm test]
  protectedPaths: []
execution: { concurrency: 2, attempts: 2, timeoutMinutes: 10 }
delivery: { pullRequest: true, merge: never }
`;
}

function githubIssue(
  number: number,
  databaseId: number,
  title: string,
  body: string,
  labels: string[],
): GitHubIssue {
  return {
    number,
    databaseId,
    nodeId: `I_${number}`,
    repository: "example/repo",
    title,
    body,
    state: "open",
    stateReason: null,
    updatedAt: "2026-09-02T22:05:00Z",
    labels: [...labels],
    url: `https://github.com/example/repo/issues/${number}`,
  };
}

function clientFor(issues: GitHubIssue[], dependencies: Map<number, number[]>): GitHubClient {
  return {
    listIssues: async () => structuredClone(issues),
    listBlockedBy: async (repository, number) =>
      (dependencies.get(number) ?? []).map((dependency) => ({ repository, number: dependency })),
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}
