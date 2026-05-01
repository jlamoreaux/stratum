import YAML from "yaml";
import { readFileFromRepo } from "../storage/git-ops";
import type { EvalPolicy } from "./types";

const DEFAULT_POLICY: EvalPolicy = {
  evaluators: [{ type: "diff" }],
  requireAll: true,
  minScore: 0.7,
};

export async function loadPolicy(remote: string, token: string): Promise<EvalPolicy> {
  const yamlPolicy = await readAndParsePolicy(remote, token, ".stratum/policy.yaml", "yaml");
  if (yamlPolicy) return yamlPolicy;

  const jsonPolicy = await readAndParsePolicy(remote, token, "stratum.config.json", "json");
  if (jsonPolicy) return jsonPolicy;

  return DEFAULT_POLICY;
}

async function readAndParsePolicy(
  remote: string,
  token: string,
  path: string,
  format: "json" | "yaml",
): Promise<EvalPolicy | null> {
  try {
    const content = await readFileFromRepo(remote, token, path);
    if (content === null || content === undefined) return null;

    let parsed: unknown;
    try {
      parsed = format === "json" ? JSON.parse(content) : YAML.parse(content);
    } catch {
      return null;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("evaluators" in parsed) ||
      !Array.isArray((parsed as Record<string, unknown>).evaluators)
    ) {
      return null;
    }

    return { ...DEFAULT_POLICY, ...(parsed as Partial<EvalPolicy>) };
  } catch {
    return null;
  }
}
