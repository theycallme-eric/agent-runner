import { analyzeTaskGraph } from "../tasks/graph.js";
import type { TaskNode } from "../tasks/types.js";
import type { RequirementsAnalysis, RequirementsPlan, SourceManifest } from "./types.js";

const ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;

export function parseRequirementsPlan(source: string): RequirementsPlan {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Requirements plan must be valid JSON: ${message(error)}`);
  }
  const root = objectAt(value, "plan");
  exactKeys(
    root,
    ["version", "project", "assumptions", "openQuestions", "requirements", "tasks"],
    "plan",
  );
  literal(root.version, 1, "plan.version");

  const project = objectAt(root.project, "plan.project");
  exactKeys(project, ["name", "summary"], "plan.project");

  const openQuestions = arrayAt(root.openQuestions, "plan.openQuestions").map((entry, index) => {
    const question = objectAt(entry, `plan.openQuestions[${index}]`);
    exactKeys(question, ["id", "question", "blocking"], `plan.openQuestions[${index}]`);
    return {
      id: idAt(question.id, `plan.openQuestions[${index}].id`),
      question: stringAt(question.question, `plan.openQuestions[${index}].question`),
      blocking: booleanAt(question.blocking, `plan.openQuestions[${index}].blocking`),
    };
  });

  const requirements = nonEmptyArrayAt(root.requirements, "plan.requirements").map((entry, index) => {
    const requirement = objectAt(entry, `plan.requirements[${index}]`);
    exactKeys(
      requirement,
      ["id", "title", "description", "acceptanceCriteria", "sourceRefs"],
      `plan.requirements[${index}]`,
    );
    return {
      id: idAt(requirement.id, `plan.requirements[${index}].id`),
      title: stringAt(requirement.title, `plan.requirements[${index}].title`),
      description: stringAt(requirement.description, `plan.requirements[${index}].description`),
      acceptanceCriteria: uniqueNonEmptyStrings(
        requirement.acceptanceCriteria,
        `plan.requirements[${index}].acceptanceCriteria`,
      ),
      sourceRefs: uniqueNonEmptyStrings(
        requirement.sourceRefs,
        `plan.requirements[${index}].sourceRefs`,
      ),
    };
  });

  const tasks = nonEmptyArrayAt(root.tasks, "plan.tasks").map((entry, index) => {
    const task = objectAt(entry, `plan.tasks[${index}]`);
    exactKeys(
      task,
      [
        "id",
        "title",
        "objective",
        "requirementIds",
        "dependencies",
        "acceptanceCriteria",
        "verification",
      ],
      `plan.tasks[${index}]`,
    );
    return {
      id: idAt(task.id, `plan.tasks[${index}].id`),
      title: stringAt(task.title, `plan.tasks[${index}].title`),
      objective: stringAt(task.objective, `plan.tasks[${index}].objective`),
      requirementIds: uniqueNonEmptyStrings(
        task.requirementIds,
        `plan.tasks[${index}].requirementIds`,
      ),
      dependencies: uniqueStrings(task.dependencies, `plan.tasks[${index}].dependencies`),
      acceptanceCriteria: uniqueNonEmptyStrings(
        task.acceptanceCriteria,
        `plan.tasks[${index}].acceptanceCriteria`,
      ),
      verification: uniqueNonEmptyStrings(
        task.verification,
        `plan.tasks[${index}].verification`,
      ),
    };
  });

  const plan: RequirementsPlan = {
    version: 1,
    project: {
      name: stringAt(project.name, "plan.project.name"),
      summary: stringAt(project.summary, "plan.project.summary"),
    },
    assumptions: uniqueStrings(root.assumptions, "plan.assumptions"),
    openQuestions,
    requirements,
    tasks,
  };
  validateReferences(plan);
  return plan;
}

export function analyzeRequirementsPlan(plan: RequirementsPlan): RequirementsAnalysis {
  const graph = analyzeTaskGraph(plan.tasks.map(toTaskNode));
  const blockingQuestionIds = plan.openQuestions
    .filter((question) => question.blocking)
    .map((question) => question.id)
    .sort();
  return {
    readyForPublishing: blockingQuestionIds.length === 0,
    blockingQuestionIds,
    rootTaskIds: graph.ready.map((task) => task.id),
    waitingTaskIds: graph.waiting.map((task) => task.id),
    edgeCount: graph.edgeCount,
  };
}

export function validateSourceReferences(
  plan: RequirementsPlan,
  manifest: SourceManifest,
): void {
  const files = new Set(manifest.files.map((file) => file.path));
  const missing = plan.requirements.flatMap((requirement) =>
    requirement.sourceRefs
      .filter((reference) => !files.has(reference))
      .map((reference) => `${requirement.id}:${reference}`),
  );
  if (missing.length > 0) {
    throw new Error(`Requirements reference unknown source files: ${missing.join(", ")}`);
  }
}

function validateReferences(plan: RequirementsPlan): void {
  assertUnique(plan.openQuestions.map((question) => question.id), "question id");
  assertUnique(plan.requirements.map((requirement) => requirement.id), "requirement id");
  assertUnique(plan.tasks.map((task) => task.id), "task id");

  const requirements = new Set(plan.requirements.map((requirement) => requirement.id));
  const unknownRequirements = plan.tasks.flatMap((task) =>
    task.requirementIds
      .filter((requirementId) => !requirements.has(requirementId))
      .map((requirementId) => `${task.id}:${requirementId}`),
  );
  if (unknownRequirements.length > 0) {
    throw new Error(`Tasks reference unknown requirements: ${unknownRequirements.join(", ")}`);
  }

  const covered = new Set(plan.tasks.flatMap((task) => task.requirementIds));
  const uncovered = plan.requirements
    .map((requirement) => requirement.id)
    .filter((requirementId) => !covered.has(requirementId));
  if (uncovered.length > 0) {
    throw new Error(`Requirements are not covered by implementation tasks: ${uncovered.join(", ")}`);
  }

  analyzeTaskGraph(plan.tasks.map(toTaskNode));
}

function toTaskNode(task: RequirementsPlan["tasks"][number]): TaskNode {
  return {
    id: task.id,
    sourceId: task.id,
    revision: "requirements-draft-v1",
    title: task.title,
    prompt: task.objective,
    status: "pending",
    dependencies: task.dependencies,
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

function nonEmptyArrayAt(value: unknown, path: string): unknown[] {
  const result = arrayAt(value, path);
  if (result.length === 0) {
    throw new Error(`${path} must not be empty`);
  }
  return result;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error(`${path} must be a non-empty string without NUL bytes`);
  }
  return value.trim();
}

function idAt(value: unknown, path: string): string {
  const result = stringAt(value, path);
  if (!ID.test(result)) {
    throw new Error(`${path} must be an uppercase identifier such as REQ-001 or TASK-001`);
  }
  return result;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function uniqueStrings(value: unknown, path: string): string[] {
  const result = arrayAt(value, path).map((entry, index) => stringAt(entry, `${path}[${index}]`));
  assertUnique(result, path);
  return result;
}

function uniqueNonEmptyStrings(value: unknown, path: string): string[] {
  const result = uniqueStrings(value, path);
  if (result.length === 0) {
    throw new Error(`${path} must not be empty`);
  }
  return result;
}

function assertUnique(values: string[], path: string): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  if (duplicates.size > 0) {
    throw new Error(`${path} contains duplicates: ${[...duplicates].sort().join(", ")}`);
  }
}

function literal(value: unknown, expected: number, path: string): void {
  if (value !== expected) {
    throw new Error(`${path} must be ${expected}`);
  }
}

function exactKeys(value: Record<string, unknown>, expected: string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !(key in value));
  if (unknown.length > 0) {
    throw new Error(`${path} has unknown fields: ${unknown.join(", ")}`);
  }
  if (missing.length > 0) {
    throw new Error(`${path} is missing fields: ${missing.join(", ")}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
