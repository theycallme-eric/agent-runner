import type { DependencyResolver, TaskNode } from "../tasks/types.js";
import type { ProjectContract } from "../project-contract.js";
import type { ProjectRegistration } from "../projects/types.js";
import type { GitHubClient } from "./types.js";
import { taskId } from "./issue-task-provider.js";

export class GitHubNativeDependencyResolver implements DependencyResolver {
  readonly name = "github-native";
  readonly #client: GitHubClient;
  readonly #concurrency: number;

  constructor(client: GitHubClient, concurrency = 4) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("GitHub dependency concurrency must be a positive integer");
    }
    this.#client = client;
    this.#concurrency = concurrency;
  }

  async resolve(tasks: TaskNode[], project: ProjectRegistration, _contract: ProjectContract) {
    const known = new Set(tasks.map((task) => task.id));
    return mapWithConcurrency(tasks, this.#concurrency, async (task) => {
      const issueNumber = Number(task.sourceId);
      if (!Number.isInteger(issueNumber) || issueNumber < 1) {
        throw new Error(`GitHub task ${task.id} has invalid source id ${task.sourceId}`);
      }
      const blockedBy = await this.#client.listBlockedBy(project.id, issueNumber);
      const dependencies = blockedBy.map((dependency) => {
        if (dependency.repository.toLowerCase() !== project.id.toLowerCase()) {
          throw new Error(
            `GitHub task ${task.id} has unsupported cross-repository dependency ${dependency.repository}#${dependency.number}`,
          );
        }
        const dependencyId = taskId(dependency.number);
        if (!known.has(dependencyId)) {
          throw new Error(`GitHub task ${task.id} depends on undiscovered ${dependencyId}`);
        }
        return dependencyId;
      });
      return { ...task, dependencies };
    });
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value !== undefined) {
        result[index] = await operation(value);
      }
    }
  });
  await Promise.all(workers);
  return result;
}
