import { analyzeRequirementsPlan } from "./schema.js";
import type { GitHubIssueDraft, RequirementsPlan } from "./types.js";

export function renderRequirementsPreview(plan: RequirementsPlan): string {
  const analysis = analyzeRequirementsPlan(plan);
  const lines = [
    `# ${plan.project.name} requirements`,
    "",
    plan.project.summary,
    "",
    `**Status:** ${analysis.readyForPublishing ? "Ready for issue review" : "Blocked by open questions"}`,
    "",
    `**Coverage:** ${plan.requirements.length} requirements → ${plan.tasks.length} implementation tasks → ${analysis.edgeCount} dependency edges`,
    "",
    "## Open questions",
    "",
  ];
  if (plan.openQuestions.length === 0) {
    lines.push("None.", "");
  } else {
    for (const question of plan.openQuestions) {
      lines.push(`- ${question.blocking ? "**Blocking:** " : ""}${question.id} — ${question.question}`);
    }
    lines.push("");
  }

  lines.push("## Assumptions", "");
  if (plan.assumptions.length === 0) {
    lines.push("None.", "");
  } else {
    lines.push(...plan.assumptions.map((assumption) => `- ${assumption}`), "");
  }

  lines.push("## Requirements", "");
  for (const requirement of plan.requirements) {
    lines.push(
      `### ${requirement.id} — ${requirement.title}`,
      "",
      requirement.description,
      "",
      "Acceptance criteria:",
      "",
      ...requirement.acceptanceCriteria.map((criterion) => `- ${criterion}`),
      "",
      `Sources: ${requirement.sourceRefs.map((reference) => `\`${reference}\``).join(", ")}`,
      "",
    );
  }

  lines.push("## Implementation graph", "", "| Task | Requirements | Blocked by |", "|---|---|---|");
  for (const task of plan.tasks) {
    lines.push(
      `| ${task.id} — ${escapeTable(task.title)} | ${task.requirementIds.join(", ")} | ${task.dependencies.join(", ") || "—"} |`,
    );
  }
  lines.push("", `Ready first: ${analysis.rootTaskIds.join(", ")}`, "", "## Task details", "");

  for (const task of plan.tasks) {
    lines.push(
      `### ${task.id} — ${task.title}`,
      "",
      task.objective,
      "",
      `Covers: ${task.requirementIds.join(", ")}`,
      "",
      `Blocked by: ${task.dependencies.join(", ") || "None"}`,
      "",
      "Acceptance criteria:",
      "",
      ...task.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`),
      "",
      "Verification:",
      "",
      ...task.verification.map((step) => `- ${step}`),
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderGitHubIssueDrafts(plan: RequirementsPlan): GitHubIssueDraft[] {
  const requirements = new Map(plan.requirements.map((requirement) => [requirement.id, requirement]));
  return plan.tasks.map((task) => {
    const requirementContext = task.requirementIds.flatMap((requirementId) => {
      const requirement = requirements.get(requirementId);
      if (!requirement) {
        throw new Error(`Task ${task.id} references missing requirement ${requirementId}`);
      }
      return [
        `### ${requirement.id} — ${requirement.title}`,
        "",
        requirement.description,
        "",
        ...requirement.acceptanceCriteria.map((criterion) => `- ${criterion}`),
        "",
        `Design evidence: ${requirement.sourceRefs.map((reference) => `\`${reference}\``).join(", ")}`,
        "",
      ];
    });
    return {
      taskId: task.id,
      title: `[${task.id}] ${task.title}`,
      blockedBy: [...task.dependencies],
      body: [
      "## Objective",
      "",
      task.objective,
      "",
      "## Requirements context",
      "",
      ...requirementContext,
      "",
      "## Acceptance criteria",
      "",
      ...task.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`),
      "",
      "## Verification",
      "",
      ...task.verification.map((step) => `- ${step}`),
      "",
      "## Dependencies",
      "",
      task.dependencies.length === 0
        ? "None."
        : `Blocked by requirements tasks: ${task.dependencies.join(", ")}`,
      "",
      `<!-- requirements-builder:v1 task=${task.id} -->`,
      ].join("\n"),
    };
  });
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
