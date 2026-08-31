import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePaginatedIssues,
  parsePaginatedReferences,
} from "../src/github/gh-cli-client.js";

test("normalizes paginated GitHub issues and excludes pull requests", () => {
  const issues = parsePaginatedIssues(
    JSON.stringify([
      [
        {
          number: 2,
          id: 102,
          node_id: "I_2",
          repository_url: "https://api.github.com/repos/example/repo",
          title: "Second",
          body: null,
          state: "open",
          state_reason: null,
          updated_at: "2026-08-31T12:00:00Z",
          labels: [{ name: "agent:ready" }],
          html_url: "https://github.com/example/repo/issues/2",
        },
        {
          number: 9,
          id: 109,
          node_id: "PR_9",
          title: "A pull request",
          pull_request: { url: "https://api.github.com/repos/example/repo/pulls/9" },
        },
      ],
      [
        {
          number: 1,
          id: 101,
          node_id: "I_1",
          repository_url: "https://api.github.com/repos/example/repo",
          title: "First",
          body: "Do the first task",
          state: "closed",
          state_reason: "completed",
          updated_at: "2026-08-30T12:00:00Z",
          labels: ["feature"],
          html_url: "https://github.com/example/repo/issues/1",
        },
      ],
    ]),
    "example/repo",
  );

  assert.deepEqual(issues.map(({ number }) => number), [1, 2]);
  assert.equal(issues[0]?.body, "Do the first task");
  assert.deepEqual(issues[1]?.labels, ["agent:ready"]);
});

test("normalizes paginated blocked-by references including repository identity", () => {
  const dependencies = parsePaginatedReferences(
    JSON.stringify([
      [
        {
          number: 7,
          repository_url: "https://api.github.com/repos/example/dependency-repo",
        },
      ],
    ]),
  );

  assert.deepEqual(dependencies, [{ number: 7, repository: "example/dependency-repo" }]);
});

test("fails closed on malformed GitHub pagination", () => {
  assert.throws(
    () => parsePaginatedIssues(JSON.stringify({ items: [] }), "example/repo"),
    /array of pages/,
  );
});
