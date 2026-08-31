import type { WorkerAdapter } from "./types.js";

export class WorkerProfileRegistry {
  readonly #profiles = new Map<string, WorkerAdapter>();

  register(profile: string, worker: WorkerAdapter): void {
    validateProfile(profile);
    if (worker.name.trim() === "") {
      throw new Error("Worker name must be non-empty");
    }
    if (this.#profiles.has(profile)) {
      throw new Error(`Worker profile already registered: ${profile}`);
    }
    this.#profiles.set(profile, worker);
  }

  get(profile: string): WorkerAdapter {
    const worker = this.#profiles.get(profile);
    if (!worker) {
      throw new Error(`Worker profile is not installed: ${profile}`);
    }
    return worker;
  }
}

function validateProfile(profile: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(profile)) {
    throw new Error(`Worker profile must be a lowercase plugin identifier: ${profile}`);
  }
}
