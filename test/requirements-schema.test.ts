import assert from "node:assert/strict";
import test from "node:test";

import { renderGitHubIssueDrafts, renderRequirementsPreview } from "../src/requirements/render.js";
import { analyzeRequirementsPlan, parseRequirementsPlan } from "../src/requirements/schema.js";

test("validates and previews implementation-ready requirements with a dependency graph", () => {
  const plan = parseRequirementsPlan(JSON.stringify(validPlan()));
  const analysis = analyzeRequirementsPlan(plan);
  const preview = renderRequirementsPreview(plan);
  const issues = renderGitHubIssueDrafts(plan);

  assert.deepEqual(analysis, {
    readyForPublishing: true,
    blockingQuestionIds: [],
    rootTaskIds: ["TASK-001"],
    waitingTaskIds: ["TASK-002"],
    edgeCount: 1,
  });
  assert.match(preview, /REQ-001 — Account setup/);
  assert.match(preview, /TASK-002 — Add dashboard/);
  assert.equal(issues.length, 2);
  assert.deepEqual(issues[1]?.blockedBy, ["TASK-001"]);
  assert.match(issues[1]?.body ?? "", /An authenticated user sees their dashboard/);
  assert.match(issues[1]?.body ?? "", /sources\/source-01-design\/design\.md/);
  assert.match(issues[1]?.body ?? "", /requirements-builder:v1 task=TASK-002/);
});

test("keeps a valid plan blocked while a required product decision is open", () => {
  const value = validPlan();
  value.openQuestions.push({
    id: "Q-001",
    question: "Which identity provider is approved?",
    blocking: true,
  });
  const analysis = analyzeRequirementsPlan(parseRequirementsPlan(JSON.stringify(value)));

  assert.equal(analysis.readyForPublishing, false);
  assert.deepEqual(analysis.blockingQuestionIds, ["Q-001"]);
});

test("rejects missing coverage, unknown dependencies, and cycles", () => {
  const uncovered = validPlan();
  uncovered.tasks[0]!.requirementIds = [];
  assert.throws(
    () => parseRequirementsPlan(JSON.stringify(uncovered)),
    /requirementIds must not be empty/,
  );

  const missing = validPlan();
  missing.tasks[1]!.dependencies = ["TASK-999"];
  assert.throws(
    () => parseRequirementsPlan(JSON.stringify(missing)),
    /depends on missing task TASK-999/,
  );

  const cyclic = validPlan();
  cyclic.tasks[0]!.dependencies = ["TASK-002"];
  assert.throws(
    () => parseRequirementsPlan(JSON.stringify(cyclic)),
    /TASK-001 -> TASK-002 -> TASK-001/,
  );
});

function validPlan() {
  return {
    version: 1,
    project: {
      name: "Fixture product",
      summary: "A focused product used to prove requirements planning.",
    },
    assumptions: ["The supplied desktop layout is authoritative."],
    openQuestions: [] as Array<{ id: string; question: string; blocking: boolean }>,
    requirements: [
      {
        id: "REQ-001",
        title: "Account setup",
        description: "A new user can create their account.",
        acceptanceCriteria: ["A valid submission creates an account."],
        sourceRefs: ["sources/source-01-design/design.md"],
      },
      {
        id: "REQ-002",
        title: "Dashboard",
        description: "An authenticated user sees their dashboard.",
        acceptanceCriteria: ["The dashboard loads after authentication."],
        sourceRefs: ["sources/source-01-design/design.md"],
      },
    ],
    tasks: [
      {
        id: "TASK-001",
        title: "Implement account setup",
        objective: "Build the account setup path.",
        requirementIds: ["REQ-001"],
        dependencies: [] as string[],
        acceptanceCriteria: ["Account setup meets REQ-001."],
        verification: ["Run the account setup integration test."],
      },
      {
        id: "TASK-002",
        title: "Add dashboard",
        objective: "Build the authenticated dashboard.",
        requirementIds: ["REQ-002"],
        dependencies: ["TASK-001"],
        acceptanceCriteria: ["Dashboard meets REQ-002."],
        verification: ["Run the dashboard browser test."],
      },
    ],
  };
}
