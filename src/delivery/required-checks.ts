import type { CiCheck, RequiredCheck } from "./types.js";

export interface RequiredCheckReconciliation {
  satisfied: string[];
  waiting: string[];
  failed: string[];
}

/**
 * Decide, for every context branch protection requires, whether an observed check row proves a
 * passing result from the configured reporting source on the exact verified head.
 *
 * A row satisfies a required context only when the name, the reporting application, and the head
 * commit all match and the result is a pass. Anything else is reported by name with the reason, so
 * the caller can wait or fail closed rather than merging on an unproven reading.
 */
export function reconcileRequiredChecks(
  requiredChecks: RequiredCheck[],
  observed: CiCheck[],
  headSha: string,
): RequiredCheckReconciliation {
  const satisfied: string[] = [];
  const waiting: string[] = [];
  const failed: string[] = [];
  for (const required of requiredChecks) {
    const named = observed.filter((check) => check.name === required.context);
    if (required.appId === null) {
      waiting.push(`${required.context} (no required reporting application is configured)`);
      continue;
    }
    const fromSource = named.filter((check) => check.appId === required.appId);
    const onHead = fromSource.filter((check) => check.headSha === headSha);
    // A passing duplicate must never mask a failing, cancelled, pending, or skipped producer.
    // The topology preflight proves there is one configured producer; this aggregation still
    // fails closed if GitHub reports conflicting rows for that identity.
    if (onHead.some((check) => check.bucket === "fail" || check.bucket === "cancel")) {
      const blocking = onHead.find((check) => check.bucket === "fail" || check.bucket === "cancel");
      failed.push(`${required.context} (${blocking?.bucket ?? "fail"})`);
      continue;
    }
    const inconclusive = onHead.find((check) =>
      check.bucket === "pending" || check.bucket === "skipping"
    );
    if (inconclusive) {
      waiting.push(`${required.context} (${inconclusive.bucket})`);
      continue;
    }
    if (onHead.some((check) => check.bucket === "pass")) {
      satisfied.push(required.context);
      continue;
    }
    if (fromSource.length > 0) {
      waiting.push(
        `${required.context} (reported on ${describeHeads(fromSource)}, not on the verified head ${headSha})`,
      );
      continue;
    }
    if (named.length > 0) {
      waiting.push(
        `${required.context} (reported by ${describeSources(named)}, not by required application ${required.appId})`,
      );
      continue;
    }
    waiting.push(`${required.context} (no check run reported)`);
  }
  return { satisfied, waiting, failed };
}

function describeSources(checks: CiCheck[]): string {
  const sources = [...new Set(checks.map((check) =>
    check.appId === null ? "an unidentified source" : `application ${check.appId}`
  ))];
  return sources.join(", ");
}

function describeHeads(checks: CiCheck[]): string {
  const heads = [...new Set(checks.map((check) => check.headSha ?? "an unidentified head"))];
  return heads.join(", ");
}
