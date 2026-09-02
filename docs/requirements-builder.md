# Requirements Builder

Requirements Builder is the first stage of the local project-support workflow:

```text
design files / design ZIP / prototype
  → requirements and open questions
  → reviewable implementation tasks
  → validated dependency graph
  → self-contained GitHub issue drafts
  → Agent Runner
```

It runs from this support repository and never writes into the product repository.

## Current command

```text
npm run build
node dist/src/requirements/cli.js build \
  --source /path/to/design.zip \
  --source /path/to/design-document.pdf \
  --source /path/to/prototype \
  --output /path/to/requirements-workspace \
  --worker claude-fable \
  --profiles /path/to/workers.yml \
  --timeout-minutes 30
```

`--source` may be repeated. Each source can be a file, a folder, or a ZIP archive. Common generated
folders such as `.git`, `node_modules`, `dist`, and `.next` are omitted from copied prototypes. ZIP
paths are checked before extraction, symbolic links are rejected, and input size is bounded.

The output directory must be empty. Requirements Builder creates:

- `sources/`: copied or extracted design inputs;
- `SOURCE_MANIFEST.json`: exact input inventory, sizes, and SHA-256 hashes;
- `REQUIREMENTS_INSTRUCTIONS.md`: the worker's bounded assignment and output contract;
- `requirements-run.json`: non-secret worker/model/session evidence;
- `requirements-plan.json`: strict requirements, questions, tasks, and dependencies;
- `requirements-preview.md`: the human review document;
- `github-issue-drafts.json`: self-contained issue bodies and task dependency identifiers.

## Deterministic gates

The coding model does not decide whether its plan is valid. The tool independently rejects:

- malformed or schema-drifting output;
- duplicate or missing identifiers;
- requirements without acceptance criteria or source evidence;
- requirements not covered by implementation tasks;
- tasks referring to missing requirements or dependencies;
- duplicate dependency edges, self-dependencies, and cycles;
- source references that are not present in the copied input manifest;
- changes made by the worker to copied design sources.

Blocking product questions keep a valid draft in `readyForPublishing: false`. Dependencies are added
only for true prerequisites so unrelated root tasks remain available for parallel work.

## Model boundary

Requirements Builder uses the same controller-owned worker profiles as Agent Runner. The first local
profile selects Fable through Claude Code, while the versioned JSON-process adapter allows another
CLI, SDK wrapper, or model to perform the same assignment. No model selection or secret is stored in
a product repository.

## Review and handoff

The current slice stops after local review artifacts. It does not create or update GitHub issues.
The next bridge will take an approved `github-issue-drafts.json`, create or update issues
idempotently, apply their native dependency relationships, and then let Agent Runner consume the
resulting ready DAG.

Before that bridge is enabled, the real acceptance test is one supervised run against an actual
design archive. Review the requirements, missing questions, task sizing, dependency edges, and issue
bodies. A fixture-only pass proves mechanics; it does not prove that a chosen model interpreted a
specific design correctly.
