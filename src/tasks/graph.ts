import type { TaskGraphSnapshot, TaskNode } from "./types.js";

export function analyzeTaskGraph(tasks: readonly TaskNode[]): TaskGraphSnapshot {
  const byId = new Map<string, TaskNode>();
  for (const task of tasks) {
    validateTask(task);
    if (byId.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`);
    }
    byId.set(task.id, task);
  }

  let edgeCount = 0;
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      edgeCount += 1;
      if (!byId.has(dependency)) {
        throw new Error(`Task ${task.id} depends on missing task ${dependency}`);
      }
      if (dependency === task.id) {
        throw new Error(`Task graph contains a cycle: ${task.id} -> ${task.id}`);
      }
    }
  }
  assertAcyclic(byId);

  const completed = sortTasks(tasks.filter((task) => task.status === "completed"));
  const blocked = sortTasks(tasks.filter((task) => task.status === "blocked"));
  const pending = tasks.filter((task) => task.status === "pending");
  const ready = sortTasks(
    pending.filter((task) =>
      task.dependencies.every((dependency) => byId.get(dependency)?.status === "completed"),
    ),
  );
  const readyIds = new Set(ready.map((task) => task.id));
  const waiting = sortTasks(pending.filter((task) => !readyIds.has(task.id)));
  return { ready, waiting, blocked, completed, edgeCount };
}

function assertAcyclic(tasks: ReadonlyMap<string, TaskNode>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (id: string): void => {
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      throw new Error(`Task graph contains a cycle: ${[...path.slice(start), id].join(" -> ")}`);
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    path.push(id);
    for (const dependency of tasks.get(id)?.dependencies ?? []) {
      visit(dependency);
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of [...tasks.keys()].sort()) {
    visit(id);
  }
}

function validateTask(task: TaskNode): void {
  for (const [path, value] of [
    ["id", task.id],
    ["sourceId", task.sourceId],
    ["revision", task.revision],
    ["title", task.title],
    ["prompt", task.prompt],
  ] as const) {
    if (value.trim() === "") {
      throw new Error(`Task ${path} must be non-empty`);
    }
  }
  if (new Set(task.dependencies).size !== task.dependencies.length) {
    throw new Error(`Task ${task.id} contains duplicate dependencies`);
  }
}

function sortTasks(tasks: readonly TaskNode[]): TaskNode[] {
  return [...tasks].sort((left, right) => left.id.localeCompare(right.id));
}
