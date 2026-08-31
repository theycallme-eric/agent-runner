import type { PullRequestPublisher } from "./types.js";

export class PullRequestPublisherRegistry {
  readonly #publishers = new Map<string, PullRequestPublisher>();

  register(publisher: PullRequestPublisher): void {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(publisher.name)) {
      throw new Error(`Delivery publisher must have a lowercase plugin id: ${publisher.name}`);
    }
    if (this.#publishers.has(publisher.name)) {
      throw new Error(`Delivery publisher already registered: ${publisher.name}`);
    }
    this.#publishers.set(publisher.name, publisher);
  }

  get(name: string): PullRequestPublisher {
    const publisher = this.#publishers.get(name);
    if (!publisher) {
      throw new Error(`Delivery publisher is not installed: ${name}`);
    }
    return publisher;
  }
}
