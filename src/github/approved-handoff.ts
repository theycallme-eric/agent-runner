import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { ProjectContract } from "../project-contract.js";
import type { ProjectRegistration } from "../projects/types.js";

export interface ApprovedHandoffTask {
  taskId: string;
  issueNumber: number;
  databaseId: number;
  title: string;
  prompt: string;
  labels: string[];
  requirementIds: string[];
  sourceRefs: string[];
  acceptanceCriteria: string[];
  verificationExpectations: string[];
  dependencies: string[];
  prerequisiteIds: string[];
}

export interface ApprovedHandoff {
  version: 2;
  createdAt: string;
  repository: string;
  baseBranch: string;
  requirementsSetId: string;
  requirementsRevision: number;
  requirementsRevisionSha256: string;
  approval: number;
  approvalSha256: string;
  approvedBy: string;
  graphSha256: string;
  approvalPointerPath: string;
  approvalRecordPath: string;
  repositoryReadiness: {
    runtime: string;
    dependencyInstallCommand: string | null;
    verificationCommands: string[];
  };
  executionPrerequisites: Array<{
    id: string;
    kind: "account" | "credential" | "service" | "permission" | "environment";
    description: string;
    sourceRefs: string[];
    verificationCommand: string;
    affectedTaskIds: string[];
  }>;
  tasks: ApprovedHandoffTask[];
  handoffSha256: string;
}

interface ApprovalPointer {
  version: 1;
  active: boolean;
  approvalPath: string | null;
  approvalSha256: string | null;
  graphSha256: string | null;
}

interface ApprovalGraphIssue {
  taskId: string;
  issueNumber: number;
  databaseId: number;
  title: string;
  body: string;
  labels: string[];
  sourceRefs: string[];
  blockedByTaskIds: string[];
}

interface ApprovalRecord {
  version: 1;
  approval: number;
  approvedAt: string;
  approvedBy: string;
  graph: {
    version: 1;
    repository: string;
    requirementsSetId: string;
    requirementsRevision: number;
    requirementsRevisionSha256: string;
    issues: ApprovalGraphIssue[];
    graphSha256: string;
  };
  approvalSha256: string;
}

export async function loadApprovedHandoff(
  project: ProjectRegistration,
  contract: ProjectContract,
): Promise<ApprovedHandoff | null> {
  const configured = handoffSetting(contract.tasks.config);
  if (configured === null) return null;
  const candidate = isAbsolute(configured)
    ? configured
    : resolve(dirname(project.contractPath), configured);
  const path = await realpath(candidate);
  assertOutsideProduct(path, project.rootPath, "Approved handoff");
  const handoff = parseApprovedHandoff(await readFile(path, "utf8"));
  if (handoff.repository.toLowerCase() !== project.id.toLowerCase()) {
    throw new Error(
      `Approved handoff repository ${handoff.repository} does not match project ${project.id}`,
    );
  }
  if (handoff.baseBranch !== contract.project.baseBranch) {
    throw new Error(
      `Approved handoff base branch ${handoff.baseBranch} does not match ${contract.project.baseBranch}`,
    );
  }
  assertReadinessMatchesContract(handoff, contract);

  const pointerPath = await realpath(handoff.approvalPointerPath);
  const recordPath = await realpath(handoff.approvalRecordPath);
  assertOutsideProduct(pointerPath, project.rootPath, "Approval pointer");
  assertOutsideProduct(recordPath, project.rootPath, "Approval record");
  const pointer = parseApprovalPointer(await readFile(pointerPath, "utf8"));
  if (
    !pointer.active ||
    pointer.approvalPath === null ||
    pointer.approvalSha256 !== handoff.approvalSha256 ||
    pointer.graphSha256 !== handoff.graphSha256 ||
    await realpath(pointer.approvalPath) !== recordPath
  ) {
    throw new Error("Approved handoff is not the active external owner approval");
  }
  const record = parseApprovalRecord(await readFile(recordPath, "utf8"));
  validateRecordMatchesHandoff(record, handoff);
  return handoff;
}

export function parseApprovedHandoff(source: string): ApprovedHandoff {
  const value = objectAt(parseJson(source, "Approved handoff"), "handoff");
  exactKeys(value, [
    "version", "createdAt", "repository", "baseBranch", "requirementsSetId",
    "requirementsRevision", "requirementsRevisionSha256", "approval", "approvalSha256",
    "approvedBy", "graphSha256", "approvalPointerPath", "approvalRecordPath", "tasks",
    "repositoryReadiness", "executionPrerequisites",
    "handoffSha256",
  ], "handoff");
  literal(value.version, 2, "handoff.version");
  const readiness = objectAt(value.repositoryReadiness, "handoff.repositoryReadiness");
  exactKeys(
    readiness,
    ["runtime", "dependencyInstallCommand", "verificationCommands"],
    "handoff.repositoryReadiness",
  );
  const repositoryReadiness = {
    runtime: stringAt(readiness.runtime, "handoff.repositoryReadiness.runtime"),
    dependencyInstallCommand: nullableStringAt(
      readiness.dependencyInstallCommand,
      "handoff.repositoryReadiness.dependencyInstallCommand",
    ),
    verificationCommands: uniqueStrings(
      readiness.verificationCommands,
      "handoff.repositoryReadiness.verificationCommands",
      false,
    ),
  };
  const executionPrerequisites = arrayAt(
    value.executionPrerequisites,
    "handoff.executionPrerequisites",
  ).map((entry, index) => {
    const prerequisite = objectAt(entry, `handoff.executionPrerequisites[${index}]`);
    exactKeys(
      prerequisite,
      ["id", "kind", "description", "sourceRefs", "verificationCommand", "affectedTaskIds"],
      `handoff.executionPrerequisites[${index}]`,
    );
    return {
      id: stringAt(prerequisite.id, `handoff.executionPrerequisites[${index}].id`),
      kind: enumAt(
        prerequisite.kind,
        ["account", "credential", "service", "permission", "environment"] as const,
        `handoff.executionPrerequisites[${index}].kind`,
      ),
      description: stringAt(
        prerequisite.description,
        `handoff.executionPrerequisites[${index}].description`,
      ),
      sourceRefs: uniqueStrings(
        prerequisite.sourceRefs,
        `handoff.executionPrerequisites[${index}].sourceRefs`,
        false,
      ),
      verificationCommand: stringAt(
        prerequisite.verificationCommand,
        `handoff.executionPrerequisites[${index}].verificationCommand`,
      ),
      affectedTaskIds: uniqueStrings(
        prerequisite.affectedTaskIds,
        `handoff.executionPrerequisites[${index}].affectedTaskIds`,
        false,
      ),
    };
  });
  const tasks = nonEmptyArrayAt(value.tasks, "handoff.tasks").map((entry, index) => {
    const task = objectAt(entry, `handoff.tasks[${index}]`);
    exactKeys(task, [
      "taskId", "issueNumber", "databaseId", "title", "prompt", "labels",
      "requirementIds", "sourceRefs", "acceptanceCriteria", "verificationExpectations",
      "dependencies",
      "prerequisiteIds",
    ], `handoff.tasks[${index}]`);
    return {
      taskId: stringAt(task.taskId, `handoff.tasks[${index}].taskId`),
      issueNumber: positiveIntegerAt(task.issueNumber, `handoff.tasks[${index}].issueNumber`),
      databaseId: positiveIntegerAt(task.databaseId, `handoff.tasks[${index}].databaseId`),
      title: stringAt(task.title, `handoff.tasks[${index}].title`),
      prompt: stringAt(task.prompt, `handoff.tasks[${index}].prompt`),
      labels: uniqueStrings(task.labels, `handoff.tasks[${index}].labels`, true),
      requirementIds: uniqueStrings(task.requirementIds, `handoff.tasks[${index}].requirementIds`, false),
      sourceRefs: uniqueStrings(task.sourceRefs, `handoff.tasks[${index}].sourceRefs`, false),
      acceptanceCriteria: uniqueStrings(task.acceptanceCriteria, `handoff.tasks[${index}].acceptanceCriteria`, false),
      verificationExpectations: uniqueStrings(
        task.verificationExpectations,
        `handoff.tasks[${index}].verificationExpectations`,
        false,
      ),
      dependencies: uniqueStrings(task.dependencies, `handoff.tasks[${index}].dependencies`, true),
      prerequisiteIds: uniqueStrings(
        task.prerequisiteIds,
        `handoff.tasks[${index}].prerequisiteIds`,
        true,
      ),
    };
  });
  assertUnique(tasks.map(({ taskId }) => taskId), "handoff task ids");
  assertUnique(tasks.map(({ issueNumber }) => String(issueNumber)), "handoff issue numbers");
  assertUnique(tasks.map(({ databaseId }) => String(databaseId)), "handoff database ids");
  const taskIds = new Set(tasks.map(({ taskId }) => taskId));
  const prerequisites = new Map(executionPrerequisites.map((entry) => [entry.id, entry]));
  assertUnique([...prerequisites.keys()], "handoff prerequisite ids");
  for (const task of tasks) {
    const missing = task.dependencies.filter((dependency) => !taskIds.has(dependency));
    if (missing.length > 0) {
      throw new Error(`Approved task ${task.taskId} has missing dependencies: ${missing.join(", ")}`);
    }
    requireWorkflowLabels(task);
    const unknownPrerequisites = task.prerequisiteIds.filter((id) => !prerequisites.has(id));
    if (unknownPrerequisites.length > 0) {
      throw new Error(`Approved task ${task.taskId} has missing prerequisites: ${unknownPrerequisites.join(", ")}`);
    }
  }
  for (const prerequisite of executionPrerequisites) {
    const declared = [...prerequisite.affectedTaskIds].sort();
    const referenced = tasks.filter((task) => task.prerequisiteIds.includes(prerequisite.id))
      .map((task) => task.taskId).sort();
    if (!sameStrings(declared, referenced, false)) {
      throw new Error(`Approved prerequisite ${prerequisite.id} task linkage is inconsistent`);
    }
  }
  const handoff: ApprovedHandoff = {
    version: 2,
    createdAt: stringAt(value.createdAt, "handoff.createdAt"),
    repository: stringAt(value.repository, "handoff.repository"),
    baseBranch: stringAt(value.baseBranch, "handoff.baseBranch"),
    requirementsSetId: hexAt(value.requirementsSetId, "handoff.requirementsSetId"),
    requirementsRevision: positiveIntegerAt(value.requirementsRevision, "handoff.requirementsRevision"),
    requirementsRevisionSha256: hexAt(value.requirementsRevisionSha256, "handoff.requirementsRevisionSha256"),
    approval: positiveIntegerAt(value.approval, "handoff.approval"),
    approvalSha256: hexAt(value.approvalSha256, "handoff.approvalSha256"),
    approvedBy: stringAt(value.approvedBy, "handoff.approvedBy"),
    graphSha256: hexAt(value.graphSha256, "handoff.graphSha256"),
    approvalPointerPath: absolutePathAt(value.approvalPointerPath, "handoff.approvalPointerPath"),
    approvalRecordPath: absolutePathAt(value.approvalRecordPath, "handoff.approvalRecordPath"),
    repositoryReadiness,
    executionPrerequisites,
    tasks,
    handoffSha256: hexAt(value.handoffSha256, "handoff.handoffSha256"),
  };
  const { handoffSha256, ...unsigned } = handoff;
  if (handoffSha256 !== sha256(stableJson(unsigned))) {
    throw new Error("Approved handoff hash does not match its contents");
  }
  return handoff;
}

export function handoffSetting(config: Record<string, unknown>): string | null {
  const unknown = Object.keys(config).filter((key) =>
    key !== "includeLabels" && key !== "approvedHandoff"
  );
  if (unknown.length > 0) {
    throw new Error(`GitHub tasks.config has unknown fields: ${unknown.join(", ")}`);
  }
  if (config.approvedHandoff === undefined) return null;
  return stringAt(config.approvedHandoff, "GitHub tasks.config.approvedHandoff");
}

function validateRecordMatchesHandoff(record: ApprovalRecord, handoff: ApprovedHandoff): void {
  if (
    record.approval !== handoff.approval ||
    record.approvalSha256 !== handoff.approvalSha256 ||
    record.approvedBy !== handoff.approvedBy ||
    record.graph.repository.toLowerCase() !== handoff.repository.toLowerCase() ||
    record.graph.requirementsSetId !== handoff.requirementsSetId ||
    record.graph.requirementsRevision !== handoff.requirementsRevision ||
    record.graph.requirementsRevisionSha256 !== handoff.requirementsRevisionSha256 ||
    record.graph.graphSha256 !== handoff.graphSha256
  ) {
    throw new Error("Approved handoff identity does not match its immutable approval record");
  }
  const byTask = new Map(record.graph.issues.map((issue) => [issue.taskId, issue]));
  if (byTask.size !== handoff.tasks.length) {
    throw new Error("Approved handoff task set does not match its approval record");
  }
  for (const task of handoff.tasks) {
    const issue = byTask.get(task.taskId);
    if (
      !issue ||
      issue.issueNumber !== task.issueNumber ||
      issue.databaseId !== task.databaseId ||
      issue.title !== task.title ||
      issue.body !== task.prompt ||
      !sameStrings(issue.labels, task.labels, true) ||
      !sameStrings(issue.sourceRefs, task.sourceRefs, false) ||
      !sameStrings(issue.blockedByTaskIds, task.dependencies, false)
    ) {
      throw new Error(`Approved handoff task ${task.taskId} does not match its approval record`);
    }
  }
}

function assertReadinessMatchesContract(
  handoff: ApprovedHandoff,
  contract: ProjectContract,
): void {
  if (!sameStrings(
    handoff.repositoryReadiness.verificationCommands,
    contract.verification.required,
    false,
  )) {
    throw new Error(
      "Approved repository verification commands do not match the external Runner contract",
    );
  }
  const install = handoff.repositoryReadiness.dependencyInstallCommand;
  if (install !== null && !contract.workspace.setup.includes(install)) {
    throw new Error(
      `Approved dependency-install command is absent from the external Runner contract: ${install}`,
    );
  }
}

function parseApprovalPointer(source: string): ApprovalPointer {
  const value = objectAt(parseJson(source, "Approval pointer"), "approval pointer");
  if (value.version !== 1 || typeof value.active !== "boolean") {
    throw new Error("Approval pointer is unsupported");
  }
  return value as unknown as ApprovalPointer;
}

function parseApprovalRecord(source: string): ApprovalRecord {
  const value = parseJson(source, "Approval record") as ApprovalRecord;
  if (
    value.version !== 1 ||
    !Number.isInteger(value.approval) ||
    typeof value.approvalSha256 !== "string" ||
    typeof value.graph !== "object" ||
    value.graph === null
  ) {
    throw new Error("Approval record is unsupported");
  }
  const { approvalSha256, ...unsigned } = value;
  if (approvalSha256 !== sha256(stableJson(unsigned))) {
    throw new Error(`Approval ${value.approval} has been modified`);
  }
  const { graphSha256, ...unsignedGraph } = value.graph;
  if (graphSha256 !== sha256(stableJson(unsignedGraph))) {
    throw new Error(`Approval ${value.approval} graph hash does not match`);
  }
  return value;
}

function requireWorkflowLabels(task: ApprovedHandoffTask): void {
  const labels = new Set(task.labels.map((label) => label.toLowerCase()));
  if (
    !labels.has("requirements:approved") ||
    !labels.has("agent:task") ||
    labels.has("requirements:review") ||
    labels.has("agent:blocked")
  ) {
    throw new Error(`Approved task ${task.taskId} does not have execution-eligible approval labels`);
  }
}

function assertOutsideProduct(path: string, productRoot: string, label: string): void {
  const relation = relative(resolve(productRoot), path);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    throw new Error(`${label} must remain outside the product repository`);
  }
}

function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${message(error)}`);
  }
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyArrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${path} must be a non-empty array`);
  return value;
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error(`${path} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function nullableStringAt(value: unknown, path: string): string | null {
  return value === null ? null : stringAt(value, path);
}

function enumAt<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${path} must be one of: ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function absolutePathAt(value: unknown, path: string): string {
  const result = stringAt(value, path);
  if (!isAbsolute(result)) throw new Error(`${path} must be absolute`);
  return result;
}

function hexAt(value: unknown, path: string): string {
  const result = stringAt(value, path);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${path} must be a SHA-256 hex digest`);
  return result;
}

function positiveIntegerAt(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${path} must be a positive integer`);
  return value as number;
}

function uniqueStrings(value: unknown, path: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${path} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  const result = value.map((entry, index) => stringAt(entry, `${path}[${index}]`));
  assertUnique(result, path);
  return result;
}

function assertUnique(values: string[], path: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${path} contains duplicates`);
}

function exactKeys(value: Record<string, unknown>, expected: string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !(key in value));
  if (unknown.length > 0) throw new Error(`${path} has unknown fields: ${unknown.join(", ")}`);
  if (missing.length > 0) throw new Error(`${path} is missing fields: ${missing.join(", ")}`);
}

function literal(value: unknown, expected: unknown, path: string): void {
  if (value !== expected) throw new Error(`${path} must be ${JSON.stringify(expected)}`);
}

function sameStrings(left: string[], right: string[], caseInsensitive: boolean): boolean {
  const normalize = (value: string) => caseInsensitive ? value.toLowerCase() : value;
  const a = left.map(normalize).sort();
  const b = right.map(normalize).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
