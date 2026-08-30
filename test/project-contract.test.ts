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
});

test("rejects unknown fields so configuration typos fail closed", () => {
  const withTypo = fixture.replace("concurrency: 2", "concurency: 2");

  assert.throws(() => parseProjectContract(withTypo), /execution has unknown fields: concurency/);
});

test("rejects projects that attempt to opt into automatic merging", () => {
  const autoMerge = fixture.replace("merge: never", "merge: always");

  assert.throws(() => parseProjectContract(autoMerge), /delivery\.merge must be "never"/);
});
