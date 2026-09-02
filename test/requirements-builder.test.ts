import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { buildRequirements } from "../src/requirements/builder.js";
import { intakeSources } from "../src/requirements/intake.js";
import type { WorkerAdapter, WorkerOutcome, WorkerRequest } from "../src/workers/types.js";

test("copies design inputs, invokes a model-neutral writer, and emits reviewed artifacts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "requirements-builder-"));
  const design = join(directory, "design");
  const output = join(directory, "output");
  mkdirSync(join(design, "node_modules"), { recursive: true });
  writeFileSync(join(design, "design.md"), "# Account and dashboard\n");
  writeFileSync(join(design, "node_modules", "ignored.js"), "ignored");

  try {
    const result = await buildRequirements({
      sourcePaths: [design],
      outputPath: output,
      worker: new FixtureRequirementsWriter(),
      timeoutMs: 1_000,
      now: new Date("2026-09-02T12:00:00.000Z"),
    });

    assert.equal(result.readyForPublishing, true);
    assert.deepEqual(result.rootTaskIds, ["TASK-001"]);
    assert.equal(result.requirementCount, 1);
    assert.equal(result.taskCount, 1);
    assert.match(readFileSync(result.previewPath, "utf8"), /Fixture requirements/);
    const issueDrafts = JSON.parse(readFileSync(result.issueDraftsPath, "utf8")) as {
      readyForPublishing: boolean;
      issues: unknown[];
    };
    assert.equal(issueDrafts.readyForPublishing, true);
    assert.equal(issueDrafts.issues.length, 1);
    assert.equal(readFileSync(join(output, "sources", "source-01-design", "design.md"), "utf8"), "# Account and dashboard\n");
    assert.throws(
      () => readFileSync(join(output, "sources", "source-01-design", "node_modules", "ignored.js")),
      /ENOENT/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a writer that changes the copied design evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "requirements-builder-mutating-writer-"));
  const design = join(directory, "design.md");
  writeFileSync(design, "# Original design\n");

  try {
    await assert.rejects(
      () => buildRequirements({
        sourcePaths: [design],
        outputPath: join(directory, "output"),
        worker: new MutatingRequirementsWriter(),
        timeoutMs: 1_000,
      }),
      /changed the copied design sources/,
    );
    assert.equal(readFileSync(design, "utf8"), "# Original design\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects unsafe ZIP paths before extraction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "requirements-builder-zip-test-"));
  const archive = join(directory, "design.zip");
  const unzip = join(directory, "fake-unzip");
  writeFileSync(archive, "fixture");
  writeFileSync(
    unzip,
    `#!/usr/bin/env node
if (process.argv[2] === "-Z1") process.stdout.write("../escape.md\\n");
`,
  );
  chmodSync(unzip, 0o755);

  try {
    await assert.rejects(
      () => intakeSources([archive], join(directory, "output"), { unzipExecutable: unzip }),
      /unsafe path: \.\.\/escape\.md/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("extracts a ZIP design into the isolated requirements workspace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "requirements-builder-zip-success-"));
  const archive = join(directory, "prototype.zip");
  const unzip = join(directory, "fake-unzip");
  const output = join(directory, "output");
  writeFileSync(archive, "fixture");
  writeFileSync(
    unzip,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv[2] === "-Z1") {
  process.stdout.write("prototype/design.md\\n");
} else {
  const destination = process.argv[process.argv.indexOf("-d") + 1];
  fs.mkdirSync(path.join(destination, "prototype"), { recursive: true });
  fs.writeFileSync(path.join(destination, "prototype", "design.md"), "# ZIP design\\n");
}
`,
  );
  chmodSync(unzip, 0o755);

  try {
    const manifest = await intakeSources([archive], output, { unzipExecutable: unzip });
    assert.deepEqual(manifest.inputs, [{
      name: "prototype.zip",
      kind: "zip",
      storedPath: "sources/source-01-prototype",
    }]);
    assert.deepEqual(manifest.files.map((file) => file.path), [
      "sources/source-01-prototype/prototype/design.md",
    ]);
    assert.equal(
      readFileSync(join(output, "sources", "source-01-prototype", "prototype", "design.md"), "utf8"),
      "# ZIP design\n",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runs the public requirements-builder CLI with a generic worker profile", () => {
  const directory = mkdtempSync(join(tmpdir(), "requirements-builder-cli-"));
  const source = join(directory, "design.md");
  const output = join(directory, "output");
  const worker = join(directory, "writer");
  const profiles = join(directory, "workers.yml");
  writeFileSync(source, "# Fixture design\n");
  writeFileSync(worker, genericWriterScript());
  chmodSync(worker, 0o755);
  writeFileSync(
    profiles,
    `version: 1
profiles:
  fixture-writer:
    adapter: json-process
    name: fixture-writer
    executable: ${worker}
`,
  );

  try {
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          resolve("dist/src/requirements/cli.js"),
          "build",
          "--source",
          source,
          "--output",
          output,
          "--worker",
          "fixture-writer",
          "--profiles",
          profiles,
          "--timeout-minutes",
          "1",
        ],
        { encoding: "utf8" },
      ),
    ) as { readyForPublishing: boolean; taskCount: number };
    assert.equal(result.readyForPublishing, true);
    assert.equal(result.taskCount, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

class FixtureRequirementsWriter implements WorkerAdapter {
  readonly name = "fixture-writer";

  async run(request: WorkerRequest): Promise<WorkerOutcome> {
    writeFileSync(join(request.workspacePath, "requirements-plan.json"), `${JSON.stringify(plan(), null, 2)}\n`);
    return {
      status: "succeeded",
      worker: this.name,
      model: "fixture-model",
      sessionId: "fixture-session",
      summary: "Wrote requirements-plan.json",
      costUsd: 0,
      durationMs: 1,
    };
  }
}

class MutatingRequirementsWriter implements WorkerAdapter {
  readonly name = "mutating-writer";

  async run(request: WorkerRequest): Promise<WorkerOutcome> {
    writeFileSync(join(request.workspacePath, "sources", "source-01-design.md"), "changed\n");
    writeFileSync(join(request.workspacePath, "requirements-plan.json"), `${JSON.stringify({
      ...plan(),
      requirements: [{
        ...plan().requirements[0],
        sourceRefs: ["sources/source-01-design.md"],
      }],
    }, null, 2)}\n`);
    return {
      status: "succeeded",
      worker: this.name,
      model: "fixture-model",
      sessionId: "mutating-session",
      summary: "Changed the source",
      costUsd: 0,
      durationMs: 1,
    };
  }
}

function plan() {
  return {
    version: 1,
    project: { name: "Fixture", summary: "Fixture requirements builder proof." },
    assumptions: [],
    openQuestions: [],
    requirements: [{
      id: "REQ-001",
      title: "Account entry",
      description: "A user can enter the product.",
      acceptanceCriteria: ["The entry screen is available."],
      sourceRefs: ["sources/source-01-design/design.md"],
    }],
    tasks: [{
      id: "TASK-001",
      title: "Build account entry",
      objective: "Implement the account entry experience.",
      requirementIds: ["REQ-001"],
      dependencies: [],
      acceptanceCriteria: ["Account entry meets REQ-001."],
      verification: ["Run the account entry test."],
    }],
  };
}

function genericWriterScript(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const plan = ${JSON.stringify({
    version: 1,
    project: { name: "CLI fixture", summary: "CLI requirements proof." },
    assumptions: [],
    openQuestions: [],
    requirements: [{
      id: "REQ-001",
      title: "Fixture behavior",
      description: "The fixture behavior is implemented.",
      acceptanceCriteria: ["The behavior is observable."],
      sourceRefs: ["sources/source-01-design.md"],
    }],
    tasks: [{
      id: "TASK-001",
      title: "Implement fixture behavior",
      objective: "Implement the fixture behavior.",
      requirementIds: ["REQ-001"],
      dependencies: [],
      acceptanceCriteria: ["REQ-001 is satisfied."],
      verification: ["Run the fixture test."],
    }],
  })};
  fs.writeFileSync(path.join(request.workspacePath, "requirements-plan.json"), JSON.stringify(plan, null, 2) + "\\n");
  process.stdout.write(JSON.stringify({
    status: "succeeded",
    model: "fixture-model",
    sessionId: "fixture-session",
    summary: "requirements written",
    durationMs: 1
  }));
});
`;
}
