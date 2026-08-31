import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { parseProjectContract } from "../src/project-contract.js";

const fixture = readFileSync(resolve("fixtures/project/.agent-runner.yml"), "utf8");

test("accepts the fixture project contract", () => {
  const contract = parseProjectContract(fixture);

  assert.equal(contract.version, 1);
  assert.equal(contract.project.id, "fixture/example");
  assert.deepEqual(contract.verification.required, [
    "npm run check",
    "npm test",
    "npm run build",
  ]);
  assert.equal(contract.delivery.merge, "never");
  assert.equal(contract.delivery.provider, "github");
});

test("delivery providers are replaceable without changing lifecycle policy", () => {
  const configured = fixture.replace(
    "delivery:\n  pullRequest: true",
    "delivery:\n  provider: gitlab\n  pullRequest: true",
  );

  assert.equal(parseProjectContract(configured).delivery.provider, "gitlab");
});

test("rejects unknown fields so configuration typos fail closed", () => {
  const withTypo = fixture.replace("concurrency: 2", "concurency: 2");

  assert.throws(() => parseProjectContract(withTypo), /execution has unknown fields: concurency/);
});

test("rejects projects that attempt to opt into automatic merging", () => {
  const autoMerge = fixture.replace("merge: never", "merge: always");

  assert.throws(() => parseProjectContract(autoMerge), /delivery\.merge must be "never"/);
});

test("accepts task providers and dependency adapters without changing the contract schema", () => {
  const customProvider = fixture
    .replace("provider: github", "provider: local-json")
    .replace("dependencies: github-native", "dependencies: embedded-dag");

  const contract = parseProjectContract(customProvider);

  assert.equal(contract.tasks.provider, "local-json");
  assert.equal(contract.tasks.dependencies, "embedded-dag");
  assert.deepEqual(contract.tasks.config, {});
});

test("preserves provider-specific task configuration without coupling the core schema", () => {
  const configured = fixture.replace(
    "  dependencies: github-native",
    "  dependencies: github-native\n  config:\n    includeLabels: [agent:task]",
  );

  const contract = parseProjectContract(configured);

  assert.deepEqual(contract.tasks.config, { includeLabels: ["agent:task"] });
});

test("rejects unsafe task provider identifiers", () => {
  const unsafeProvider = fixture.replace("provider: github", "provider: GitHub Provider");

  assert.throws(
    () => parseProjectContract(unsafeProvider),
    /tasks\.provider must be a lowercase plugin identifier/,
  );
});
