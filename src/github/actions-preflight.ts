import { parseDocument } from "yaml";

import type { RequiredCheck } from "../delivery/types.js";

export const GITHUB_ACTIONS_APP_ID = 15_368;

export interface WorkflowSource {
  path: string;
  source: string;
}

export interface ActionsPreflightResult {
  evidence: string[];
  failures: string[];
}

interface Producer {
  context: string;
  path: string;
  safePullRequestEvents: boolean;
  eventSummary: string;
  unsupported: string[];
}

/**
 * Validate only the intentionally narrow GitHub Actions lane Agent Runner can prove safe.
 * Unsupported workflow semantics are refusals, never guesses. This keeps absence from being used
 * as evidence that another producer or trigger cannot appear later for the same check identity.
 */
export function preflightGitHubActions(
  requiredChecks: RequiredCheck[],
  workflows: WorkflowSource[],
): ActionsPreflightResult {
  const failures: string[] = [];
  const producers: Producer[] = [];
  const requiredNames = new Set(requiredChecks.map((check) => check.context));

  if (workflows.length === 0) {
    return {
      evidence: [],
      failures: ["no GitHub Actions workflow files were found on the protected base branch"],
    };
  }

  for (const workflow of [...workflows].sort((left, right) => left.path.localeCompare(right.path))) {
    try {
      const parsed = parseDocument(workflow.source, { uniqueKeys: true });
      if (parsed.errors.length > 0) {
        failures.push(
          `${workflow.path} cannot be parsed unambiguously: ` +
            parsed.errors.map((error) => error.message).join("; "),
        );
        continue;
      }
      const root = recordAt(parsed.toJS(), workflow.path);
      const events = eventProfile(root.on, workflow.path);
      const jobs = recordAt(root.jobs, `${workflow.path}.jobs`);
      for (const [jobId, value] of Object.entries(jobs)) {
        const jobPath = `${workflow.path}.jobs.${jobId}`;
        const job = recordAt(value, jobPath);
        const unsupported: string[] = [];
        if (job.uses !== undefined) unsupported.push("reusable workflow job");
        if (hasMatrix(job.strategy)) unsupported.push("matrix job");
        if (job.if !== undefined) unsupported.push("conditional job");
        const configuredName = job.name === undefined ? jobId : stringAt(job.name, `${jobPath}.name`);
        if (configuredName.includes("${{")) unsupported.push("dynamic job name");

        if (unsupported.length > 0 && !requiredNames.has(configuredName)) {
          // A dynamic or matrix name might resolve to a required context, so none of the missing
          // required contexts can be proven absent from this workflow.
          if (unsupported.includes("dynamic job name") || unsupported.includes("matrix job")) {
            failures.push(
              `${jobPath} uses ${unsupported.join(" and ")}; required-context mapping is indeterminate`,
            );
          }
          continue;
        }
        if (!requiredNames.has(configuredName)) continue;
        producers.push({
          context: configuredName,
          path: workflow.path,
          safePullRequestEvents: events.safe,
          eventSummary: events.summary,
          unsupported: [...unsupported, ...events.unsupported],
        });
      }
    } catch (error) {
      failures.push(
        `${workflow.path} cannot be analyzed safely: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const evidence: string[] = [];
  for (const required of requiredChecks) {
    if (required.appId !== GITHUB_ACTIONS_APP_ID) {
      failures.push(
        `${required.context} is pinned to unsupported application ${required.appId ?? "none"}; ` +
          `the initial automatic lane supports GitHub Actions application ${GITHUB_ACTIONS_APP_ID}`,
      );
      continue;
    }
    const matching = producers.filter((producer) => producer.context === required.context);
    if (matching.length === 0) {
      failures.push(
        `${required.context} cannot be mapped to a static job in the protected base workflows`,
      );
      continue;
    }
    if (matching.length > 1) {
      failures.push(
        `${required.context} has multiple possible producers: ` +
          matching.map((producer) => producer.path).join(", "),
      );
      continue;
    }
    const producer = matching[0];
    if (!producer) continue;
    if (producer.unsupported.length > 0 || !producer.safePullRequestEvents) {
      failures.push(
        `${required.context} in ${producer.path} is not in the supported automatic lane: ` +
          [...producer.unsupported, producer.eventSummary].filter(Boolean).join("; "),
      );
      continue;
    }
    evidence.push(
      `Required context ${required.context} has one static GitHub Actions producer in ` +
        `${producer.path}, triggered on pull_request opened and synchronize`,
    );
  }

  return {
    evidence,
    failures: [...new Set(failures)].sort((left, right) => left.localeCompare(right)),
  };
}

function eventProfile(value: unknown, path: string): {
  safe: boolean;
  summary: string;
  unsupported: string[];
} {
  const unsupported: string[] = [];
  let pullRequest: unknown;
  if (value === "pull_request") {
    pullRequest = null;
  } else if (Array.isArray(value)) {
    const names = value.map((entry, index) => stringAt(entry, `${path}.on[${index}]`));
    if (names.length !== 1 || names[0] !== "pull_request") {
      unsupported.push(`multiple or unsupported workflow triggers: ${names.join(", ")}`);
    }
    pullRequest = names.includes("pull_request") ? null : undefined;
  } else {
    const events = recordAt(value, `${path}.on`);
    const names = Object.keys(events);
    if (names.length !== 1 || names[0] !== "pull_request") {
      unsupported.push(`multiple or unsupported workflow triggers: ${names.join(", ")}`);
    }
    pullRequest = events.pull_request;
  }

  if (pullRequest === undefined) {
    return { safe: false, summary: "pull_request is not configured", unsupported };
  }
  if (pullRequest === null) {
    return { safe: unsupported.length === 0, summary: "default pull_request events", unsupported };
  }
  const config = recordAt(pullRequest, `${path}.on.pull_request`);
  const filters = ["paths", "paths-ignore", "branches", "branches-ignore"]
    .filter((key) => config[key] !== undefined);
  if (filters.length > 0) {
    unsupported.push(`pull_request filters are configured: ${filters.join(", ")}`);
  }
  const types = config.types === undefined
    ? ["opened", "synchronize", "reopened"]
    : stringArrayAt(config.types, `${path}.on.pull_request.types`);
  const missing = ["opened", "synchronize"].filter((event) => !types.includes(event));
  const extra = types.filter((event) => !["opened", "synchronize", "reopened"].includes(event));
  if (missing.length > 0) unsupported.push(`missing pull_request events: ${missing.join(", ")}`);
  if (extra.length > 0) unsupported.push(`unsupported pull_request events: ${extra.join(", ")}`);
  return {
    safe: unsupported.length === 0,
    summary: `pull_request types: ${types.join(", ")}`,
    unsupported,
  };
}

function hasMatrix(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const strategy = recordAt(value, "job.strategy");
  return strategy.matrix !== undefined;
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function stringArrayAt(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty array`);
  }
  return value.map((entry, index) => stringAt(entry, `${path}[${index}]`));
}
