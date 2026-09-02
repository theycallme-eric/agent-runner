import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { WorkerAdapter } from "../workers/types.js";
import { intakeSources, verifySourcesUnchanged } from "./intake.js";
import { renderGitHubIssueDrafts, renderRequirementsPreview } from "./render.js";
import {
  analyzeRequirementsPlan,
  parseRequirementsPlan,
  validateSourceReferences,
} from "./schema.js";
import type { RequirementsBuildResult } from "./types.js";

export interface BuildRequirementsRequest {
  sourcePaths: string[];
  outputPath: string;
  worker: WorkerAdapter;
  timeoutMs: number;
  now?: Date;
  unzipExecutable?: string;
}

export async function buildRequirements(
  request: BuildRequirementsRequest,
): Promise<RequirementsBuildResult> {
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1) {
    throw new Error("Requirements writer timeout must be a positive integer");
  }
  const workspacePath = resolve(request.outputPath);
  await assertEmptyDirectory(workspacePath);
  await mkdir(workspacePath, { recursive: true });
  const manifest = await intakeSources(request.sourcePaths, workspacePath, {
    ...(request.now ? { now: request.now } : {}),
    ...(request.unzipExecutable ? { unzipExecutable: request.unzipExecutable } : {}),
  });
  await writeFile(join(workspacePath, "REQUIREMENTS_INSTRUCTIONS.md"), writerInstructions(), "utf8");

  const worker = await request.worker.run({
    workspacePath,
    prompt: [
      "Build an implementation-ready requirements plan from the supplied design materials.",
      "Read REQUIREMENTS_INSTRUCTIONS.md and SOURCE_MANIFEST.json, inspect every relevant file under sources/,",
      "and write requirements-plan.json. Do not implement product code or change anything under sources/.",
    ].join(" "),
    timeoutMs: request.timeoutMs,
  });
  await writeFile(
    join(workspacePath, "requirements-run.json"),
    `${JSON.stringify({ version: 1, worker }, null, 2)}\n`,
    "utf8",
  );
  if (worker.status !== "succeeded") {
    throw new Error(`Requirements worker ${worker.status}: ${worker.summary}`);
  }

  await verifySourcesUnchanged(workspacePath, manifest);
  const planPath = join(workspacePath, "requirements-plan.json");
  const plan = parseRequirementsPlan(await readFile(planPath, "utf8"));
  validateSourceReferences(plan, manifest);
  const analysis = analyzeRequirementsPlan(plan);
  const previewPath = join(workspacePath, "requirements-preview.md");
  const issueDraftsPath = join(workspacePath, "github-issue-drafts.json");
  await writeFile(previewPath, renderRequirementsPreview(plan), "utf8");
  await writeFile(
    issueDraftsPath,
    `${JSON.stringify({
      version: 1,
      project: plan.project.name,
      readyForPublishing: analysis.readyForPublishing,
      blockingQuestionIds: analysis.blockingQuestionIds,
      issues: renderGitHubIssueDrafts(plan),
    }, null, 2)}\n`,
    "utf8",
  );
  return {
    workspacePath,
    planPath,
    previewPath,
    issueDraftsPath,
    readyForPublishing: analysis.readyForPublishing,
    blockingQuestionIds: analysis.blockingQuestionIds,
    rootTaskIds: analysis.rootTaskIds,
    taskCount: plan.tasks.length,
    requirementCount: plan.requirements.length,
    worker,
  };
}

async function assertEmptyDirectory(path: string): Promise<void> {
  try {
    const entries = await readdir(path);
    if (entries.length > 0) {
      throw new Error(`Requirements output directory is not empty: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function writerInstructions(): string {
  return `# Requirements writer instructions

Your only output is \`requirements-plan.json\` in this directory. Read the copied design inputs under
\`sources/\` and use the exact paths in \`SOURCE_MANIFEST.json\` when citing evidence.

Write strict JSON with this shape:

\`\`\`json
{
  "version": 1,
  "project": { "name": "Project name", "summary": "What is being built and for whom" },
  "assumptions": ["Explicit, evidence-based assumption"],
  "openQuestions": [
    { "id": "Q-001", "question": "A decision the source does not answer", "blocking": true }
  ],
  "requirements": [
    {
      "id": "REQ-001",
      "title": "Observable capability",
      "description": "Complete behavior, states, constraints, and user value",
      "acceptanceCriteria": ["Specific observable outcome"],
      "sourceRefs": ["sources/source-01-design/design.md"]
    }
  ],
  "tasks": [
    {
      "id": "TASK-001",
      "title": "Reviewable implementation unit",
      "objective": "A coding agent's complete bounded objective",
      "requirementIds": ["REQ-001"],
      "dependencies": [],
      "acceptanceCriteria": ["Specific completion condition"],
      "verification": ["Concrete test or inspection command/outcome"]
    }
  ]
}
\`\`\`

Rules:

- Capture functional behavior, important states, error/empty/loading cases, data rules, responsive
  behavior, accessibility, security, and operational constraints when supported by the sources.
- Do not invent missing product decisions. Record them as open questions; mark a question blocking
  only when implementation cannot safely proceed without the answer.
- Every requirement needs observable acceptance criteria and exact source references.
- Every requirement must be covered by at least one implementation task.
- Each task must be small enough for one reviewable pull request and independently verifiable.
- Add dependencies only for genuine prerequisites. Keep unrelated tasks independent so agents can
  run them in parallel.
- Dependency ids must refer to tasks in this same plan. The graph must not contain cycles.
- Do not edit, rename, or add files under \`sources/\`. Do not implement product code.
`;
}
