import type { ProjectContract } from "../project-contract.js";

export interface GateDecision {
  required: boolean;
  matchedPaths: string[];
}

export function protectedPathGate(
  changedPaths: readonly string[],
  rules: ProjectContract["verification"]["protectedPaths"],
): GateDecision {
  const matchers = rules.map((rule) => globToRegExp(rule.pattern));
  const matchedPaths = changedPaths.filter((path) => matchers.some((matcher) => matcher.test(path)));
  return { required: matchedPaths.length > 0, matchedPaths };
}

function globToRegExp(glob: string): RegExp {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    if (char === "*" && next === "*") {
      pattern += ".*";
      index += 1;
    } else if (char === "*") {
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char?.replace(/[\\^$+?.()|{}\[\]]/g, "\\$&") ?? "";
    }
  }
  return new RegExp(`${pattern}$`);
}
