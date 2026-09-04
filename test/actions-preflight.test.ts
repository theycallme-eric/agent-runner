import assert from "node:assert/strict";
import test from "node:test";

import {
  GITHUB_ACTIONS_APP_ID,
  preflightGitHubActions,
} from "../src/github/actions-preflight.js";

const required = [{ context: "project-verification", appId: GITHUB_ACTIONS_APP_ID }];

test("proves one static required-check producer on ordinary pull requests", () => {
  const result = preflightGitHubActions(required, [{
    path: ".github/workflows/project-verification.yml",
    source: `
on:
  pull_request:
    types: [opened, synchronize, reopened]
jobs:
  verify:
    name: project-verification
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`,
  }]);

  assert.deepEqual(result.failures, []);
  assert.equal(result.evidence.length, 1);
});

test("refuses ready-only, filtered, and extra-trigger workflows", () => {
  for (const source of [
    `on:\n  pull_request:\n    types: [ready_for_review]\njobs:\n  verify:\n    name: project-verification`,
    `on:\n  pull_request:\n    paths: [src/**]\njobs:\n  verify:\n    name: project-verification`,
    `on: [pull_request, push]\njobs:\n  verify:\n    name: project-verification`,
  ]) {
    const result = preflightGitHubActions(required, [{ path: ".github/workflows/ci.yml", source }]);
    assert.ok(result.failures.length > 0, source);
  }
});

test("refuses multiple producers for the same required context", () => {
  const source = (job: string) =>
    `on: pull_request\njobs:\n  ${job}:\n    name: project-verification`;
  const result = preflightGitHubActions(required, [
    { path: ".github/workflows/a.yml", source: source("a") },
    { path: ".github/workflows/b.yml", source: source("b") },
  ]);

  assert.match(result.failures.join("\n"), /multiple possible producers/);
});

test("refuses indeterminate matrix or dynamic job names", () => {
  const result = preflightGitHubActions(required, [{
    path: ".github/workflows/ci.yml",
    source: `
on: pull_request
jobs:
  verify:
    name: \${{ matrix.name }}
    strategy:
      matrix:
        name: [project-verification]
`,
  }]);

  assert.match(result.failures.join("\n"), /indeterminate/);
});

test("refuses unknown applications, malformed workflows, and absent workflows", () => {
  assert.match(
    preflightGitHubActions([{ context: "project-verification", appId: 99 }], [{
      path: ".github/workflows/ci.yml",
      source: "on: pull_request\njobs:\n  verify:\n    name: project-verification",
    }]).failures.join("\n"),
    /unsupported application 99/,
  );
  assert.match(
    preflightGitHubActions(required, [{ path: ".github/workflows/broken.yml", source: "jobs: [" }])
      .failures.join("\n"),
    /cannot be parsed unambiguously/,
  );
  assert.match(preflightGitHubActions(required, []).failures.join("\n"), /no GitHub Actions/);
});
