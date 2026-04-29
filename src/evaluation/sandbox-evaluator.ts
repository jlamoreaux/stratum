import type { EvalResult, EvalPolicy } from './types';
import type { Evaluator } from './types';
import type { SandboxBinding } from '../types';

function parseDiffFiles(diff: string): Map<string, string> {
  const files = new Map<string, string>();
  const lines = diff.split('\n');
  let currentPath: string | null = null;
  const contentLines: string[] = [];

  const flush = () => {
    if (currentPath !== null) {
      files.set(currentPath, contentLines.join('\n'));
    }
  };

  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      flush();
      currentPath = line.slice(6);
      contentLines.length = 0;
    } else if (
      currentPath !== null &&
      !line.startsWith('--- ') &&
      !line.startsWith('diff ') &&
      !line.startsWith('index ') &&
      !line.startsWith('@@ ')
    ) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        contentLines.push(line.slice(1));
      }
    }
  }

  flush();
  return files;
}

function parseTestOutput(stdout: string, stderr: string): number | null {
  const combined = stdout + '\n' + stderr;

  const match = combined.match(/(\d+)\s+passed[,\s]+(\d+)\s+failed/i)
    ?? combined.match(/(\d+)\s+passed/i);

  if (match) {
    const passed = parseInt(match[1] ?? '0', 10);
    const failedMatch = combined.match(/(\d+)\s+failed/i);
    const failed = failedMatch ? parseInt(failedMatch[1] ?? '0', 10) : 0;
    const total = passed + failed;
    if (total === 0) return null;
    return passed / total;
  }

  return null;
}

export class SandboxEvaluator implements Evaluator {
  constructor(private sandbox: SandboxBinding) {}

  async evaluate(diff: string, policy: EvalPolicy): Promise<EvalResult> {
    const config = policy.evaluators.find(e => e.type === 'sandbox') as
      | { type: 'sandbox'; command?: string; timeoutMs?: number }
      | undefined;

    if (!config) {
      return { score: 1.0, passed: true, reason: 'No sandbox evaluator configured' };
    }

    const command = config.command ?? 'npm test';
    const timeoutMs = config.timeoutMs ?? 60_000;
    const minScore = policy.minScore ?? 0.7;

    const files = parseDiffFiles(diff);
    let sb: Awaited<ReturnType<SandboxBinding['create']>> | null = null;

    try {
      sb = await this.sandbox.create();

      for (const [path, content] of files) {
        await sb.writeFile(path, content);
      }

      const result = await sb.run(command, { timeout: timeoutMs });

      let score: number;
      if (result.exitCode === 0) {
        score = 1.0;
      } else {
        const parsed = parseTestOutput(result.stdout, result.stderr);
        score = parsed ?? 0.0;
      }

      const passed = score >= minScore;
      const reason = (result.stdout + result.stderr).slice(0, 500).trim();

      return { score, passed, reason };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { score: 0, passed: false, reason: `Sandbox error: ${message}` };
    } finally {
      if (sb !== null) {
        await sb.destroy();
      }
    }
  }
}
