const RETRYABLE_TASK_FAILURES = new Set([
  "workspace-failed",
  "setup-failed",
  "worker-failed",
  "worker-timed-out",
  "worker-no-changes",
  "task-verification-failed",
  "verification-failed",
  "base-advanced",
]);

export function isRetryableTaskFailure(reason: string | null): boolean {
  return reason !== null && RETRYABLE_TASK_FAILURES.has(reason);
}
