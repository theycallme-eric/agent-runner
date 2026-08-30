#!/usr/bin/env node

import { resolve } from "node:path";

import { loadProjectContract } from "./project-contract.js";

async function main(): Promise<void> {
  const [command, path] = process.argv.slice(2);
  if (command !== "validate" || !path) {
    console.error("Usage: agent-runner validate <path-to-.agent-runner.yml>");
    process.exitCode = 2;
    return;
  }

  const contract = await loadProjectContract(resolve(path));
  console.log(
    JSON.stringify(
      {
        valid: true,
        project: contract.project.id,
        verificationCommands: contract.verification.required.length,
        mergePolicy: contract.delivery.merge,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
