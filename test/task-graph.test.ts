import assert from "node:assert/strict";
import test from "node:test";

import { analyzeTaskGraph } from "../src/tasks/graph.js";
import type { TaskNode } from "../src/tasks/types.js";

function task(
  id: string,
  status: TaskNode["status"],
  dependencies: string[] = [],
): TaskNode {
  return {
    id,
    revision: `${id}-revision`,
    title: id,
    prompt: `Implement ${id}`,
    status,
    dependencies,
  };
}

test("selects only pending tasks whose dependencies are complete", () => {
  const graph = analyzeTaskGraph([
    task("ENV-01", "completed"),
    task("APP-01", "pending", ["ENV-01"]),
    task("APP-02", "pending", ["APP-01"]),
    task("HOLD-01", "blocked"),
  ]);

  assert.deepEqual(graph.ready.map(({ id }) => id), ["APP-01"]);
  assert.deepEqual(graph.waiting.map(({ id }) => id), ["APP-02"]);
  assert.deepEqual(graph.blocked.map(({ id }) => id), ["HOLD-01"]);
  assert.deepEqual(graph.completed.map(({ id }) => id), ["ENV-01"]);
  assert.equal(graph.edgeCount, 2);
});

test("rejects cycles with the concrete dependency path", () => {
  assert.throws(
    () =>
      analyzeTaskGraph([
        task("A", "pending", ["C"]),
        task("B", "pending", ["A"]),
        task("C", "pending", ["B"]),
      ]),
    /Task graph contains a cycle: A -> C -> B -> A/,
  );
});

test("rejects missing and duplicate dependencies", () => {
  assert.throws(
    () => analyzeTaskGraph([task("A", "pending", ["missing"])]),
    /depends on missing task missing/,
  );
  assert.throws(
    () => analyzeTaskGraph([task("A", "pending"), task("B", "pending", ["A", "A"])]),
    /contains duplicate dependencies/,
  );
});
