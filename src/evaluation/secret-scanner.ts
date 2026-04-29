import type { EvalResult } from './types';

const SECRET_PATTERNS = [
  { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub Token (Classic)', pattern: /ghp_[a-zA-Z0-9]{36}/ },
  { name: 'GitHub App Token', pattern: /ghs_[a-zA-Z0-9]{36}/ },
  { name: 'GitHub Refresh Token', pattern: /ghr_[a-zA-Z0-9]{76}/ },
  { name: 'Stratum User Token', pattern: /stratum_user_[a-f0-9]{32}/ },
  { name: 'Stratum Agent Token', pattern: /stratum_agent_[a-f0-9]{32}/ },
  { name: 'Generic high-entropy secret', pattern: /[A-Za-z0-9+/]{40,}={0,2}/ },
];

export class SecretScanEvaluator {
  async evaluate(diff: string, _policy: unknown): Promise<EvalResult> {
    const issues: string[] = [];

    const lines = diff.split('\n');
    lines.forEach((line, idx) => {
      if (!line.startsWith('+') || line.startsWith('+++')) return;
      const lineNumber = idx + 1;
      for (const { name, pattern } of SECRET_PATTERNS) {
        if (pattern.test(line)) {
          issues.push(`${name}: line ${lineNumber}`);
          break;
        }
      }
    });

    if (issues.length > 0) {
      return {
        score: 0,
        passed: false,
        reason: `Secret detected: ${issues[0]?.split(':')[0] ?? 'unknown'}`,
        issues,
      };
    }

    return {
      score: 1,
      passed: true,
      reason: 'No secrets detected',
    };
  }
}
