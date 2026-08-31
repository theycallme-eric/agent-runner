import type { DependencyResolver } from "./types.js";

export class DependencyResolverRegistry {
  readonly #resolvers = new Map<string, DependencyResolver>();

  register(resolver: DependencyResolver): void {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(resolver.name)) {
      throw new Error(`Invalid dependency resolver name: ${resolver.name}`);
    }
    if (this.#resolvers.has(resolver.name)) {
      throw new Error(`Dependency resolver already registered: ${resolver.name}`);
    }
    this.#resolvers.set(resolver.name, resolver);
  }

  get(name: string): DependencyResolver {
    const resolver = this.#resolvers.get(name);
    if (!resolver) {
      const available = [...this.#resolvers.keys()].sort().join(", ") || "none";
      throw new Error(`Dependency resolver ${name} is not installed; available: ${available}`);
    }
    return resolver;
  }

  list(): string[] {
    return [...this.#resolvers.keys()].sort();
  }
}
