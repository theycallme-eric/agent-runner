import { resolve } from "node:path";

import { loadProjectContract } from "../project-contract.js";
import type { ProjectRegistryStore } from "./registry.js";
import type { RegisterProjectResult } from "./types.js";

export interface OnboardProjectRequest {
  rootPath: string;
  workerProfile: string;
  now: number;
}

export async function onboardProject(
  registry: ProjectRegistryStore,
  request: OnboardProjectRequest,
): Promise<RegisterProjectResult> {
  const rootPath = resolve(request.rootPath);
  const contractPath = resolve(rootPath, ".agent-runner.yml");
  const contract = await loadProjectContract(contractPath);
  return registry.register({
    id: contract.project.id,
    rootPath,
    contractPath,
    workerProfile: request.workerProfile,
    contractVersion: contract.version,
    now: request.now,
  });
}
