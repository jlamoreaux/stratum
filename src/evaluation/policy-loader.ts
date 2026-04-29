import { readFileFromRepo } from '../storage/git-ops';
import type { EvalPolicy } from './types';

const DEFAULT_POLICY: EvalPolicy = {
  evaluators: [{ type: 'diff' }],
  requireAll: true,
  minScore: 0.7,
};

export async function loadPolicy(remote: string, token: string): Promise<EvalPolicy> {
  try {
    const content = await readFileFromRepo(remote, token, 'stratum.config.json');
    if (content === null || content === undefined) return DEFAULT_POLICY;

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return DEFAULT_POLICY;
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('evaluators' in parsed) ||
      !Array.isArray((parsed as Record<string, unknown>)['evaluators'])
    ) {
      return DEFAULT_POLICY;
    }

    return { ...DEFAULT_POLICY, ...(parsed as Partial<EvalPolicy>) };
  } catch {
    return DEFAULT_POLICY;
  }
}
