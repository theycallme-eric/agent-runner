import type { TaskProvider } from "./types.js";

export class TaskProviderRegistry {
  readonly #providers = new Map<string, TaskProvider>();

  register(provider: TaskProvider): void {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(provider.name)) {
      throw new Error(`Invalid task provider name: ${provider.name}`);
    }
    if (this.#providers.has(provider.name)) {
      throw new Error(`Task provider already registered: ${provider.name}`);
    }
    this.#providers.set(provider.name, provider);
  }

  get(name: string): TaskProvider {
    const provider = this.#providers.get(name);
    if (!provider) {
      const available = [...this.#providers.keys()].sort().join(", ") || "none";
      throw new Error(`Task provider ${name} is not installed; available: ${available}`);
    }
    return provider;
  }

  list(): string[] {
    return [...this.#providers.keys()].sort();
  }
}
