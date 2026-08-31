import type { DependencyResolverRegistry } from "../tasks/dependency-registry.js";
import type { TaskProviderRegistry } from "../tasks/provider-registry.js";
import { GhCliGitHubClient } from "./gh-cli-client.js";
import { GitHubIssueTaskProvider } from "./issue-task-provider.js";
import { GitHubNativeDependencyResolver } from "./native-dependency-resolver.js";

export function registerGitHubAdapters(
  providers: TaskProviderRegistry,
  dependencies: DependencyResolverRegistry,
  executable = "gh",
): void {
  const client = new GhCliGitHubClient(executable);
  providers.register(new GitHubIssueTaskProvider(client));
  dependencies.register(new GitHubNativeDependencyResolver(client));
}
