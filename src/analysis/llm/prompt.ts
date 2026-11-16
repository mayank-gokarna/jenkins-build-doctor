import type { Redactor } from '../../core/redact';
import { displayPath } from '../../jenkins/paths';
import type { ProcessedLog } from '../preprocess';
import { CATEGORY_LABELS, type Diagnosis } from '../types';

export const SYSTEM_PROMPT = `You are a senior CI/CD engineer diagnosing a failed Jenkins build.
You receive build metadata, findings from a deterministic rule engine (with log line numbers), failing tests, and excerpts of the console log. Secrets have been replaced by ******.

Respond in Markdown with exactly these sections:
## Root cause
One or two sentences. State whether it is CONFIRMED by explicit log evidence or a HYPOTHESIS.
## Evidence
Bullet list quoting the relevant log lines with their line numbers (e.g. "L1234: ...").
## Explanation
Why this caused the failure, and whether other findings are symptoms of it.
## Remediation
Numbered, concrete steps (commands/config changes), most likely fix first.
## Confidence
High / Medium / Low, with a short justification and what to check to confirm.

Rules: cite only lines present in the input; do not invent file names, versions or URLs; if the evidence is insufficient, say so and list what extra information is needed. The rule engine can be wrong — say so if you disagree.`;

export interface BuiltPrompt {
  system: string;
  user: string;
  /** Character count of the user prompt, shown in the consent dialog. */
  size: number;
}

/**
 * Builds a size-bounded, redacted prompt. Sections are added in priority order until the
 * budget is reached; the final text is redacted again as defence in depth.
 */
export function buildPrompt(diagnosis: Diagnosis, log: ProcessedLog, redactor: Redactor, maxChars: number): BuiltPrompt {
  const parts: string[] = [];
  let budget = maxChars;
  const add = (s: string): boolean => {
    if (s.length > budget) {
      if (budget > 200) {
        parts.push(`${s.slice(0, budget - 20)}\n…[truncated]`);
        budget = 0;
      }
      return false;
    }
    parts.push(s);
    budget -= s.length;
    return true;
  };

  const b = diagnosis.build;
  add(
    [
      '# Build',
      `Job: ${displayPath(diagnosis.job.path)} (${diagnosis.job.kind})`,
      `Build: #${b.number}, status ${b.status}${b.durationMs ? `, duration ${Math.round(b.durationMs / 1000)}s` : ''}`,
      b.builtOn ? `Agent: ${b.builtOn}` : '',
      b.branch ? `Branch: ${b.branch}` : '',
      b.causes.length ? `Triggered by: ${b.causes.join('; ')}` : '',
      diagnosis.failedStages.length ? `Failed stages: ${diagnosis.failedStages.map((s) => `${s.name} (${s.status})`).join(', ')}` : '',
      diagnosis.stats.truncated ? 'Note: the console log was truncated (middle part omitted).' : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  if (diagnosis.findings.length > 0) {
    const lines = ['\n# Rule-engine findings (ranked)'];
    for (const f of diagnosis.findings.slice(0, 8)) {
      lines.push(`- [${f.certainty}] ${CATEGORY_LABELS[f.category]} — ${f.title}: ${f.summary} (score ${f.score}, ${f.occurrences} occurrence(s))`);
      for (const e of f.evidence.slice(0, 2)) {
        lines.push(`    ${e.line ? `L${e.line}` : 'test'}: ${e.text}`);
      }
    }
    add(lines.join('\n'));
  }

  if (diagnosis.failedTests.length > 0) {
    const lines = ['\n# Failing tests'];
    for (const t of diagnosis.failedTests.slice(0, 10)) {
      lines.push(`- ${t.className ? `${t.className}.` : ''}${t.name}: ${(t.errorDetails ?? '').split('\n')[0].slice(0, 300)}`);
      if (t.stackTrace) {
        lines.push(
          t.stackTrace
            .split('\n')
            .slice(0, 6)
            .map((s) => `    ${s}`)
            .join('\n'),
        );
      }
    }
    add(lines.join('\n'));
  }

  // Context windows around the top findings' evidence.
  const windows: [number, number][] = [];
  for (const f of diagnosis.findings.slice(0, 5)) {
    for (const e of f.evidence.slice(0, 2)) {
      if (e.line) {
        windows.push([Math.max(1, e.line - 15), Math.min(log.lines.length, e.line + 10)]);
      }
    }
  }
  const merged = mergeRanges(windows);
  if (merged.length > 0) {
    const lines = ['\n# Log excerpts around findings'];
    for (const [from, to] of merged) {
      lines.push(`--- lines ${from}-${to} ---`);
      for (let i = from; i <= to; i++) {
        lines.push(`L${i}: ${log.lines[i - 1]}`);
      }
    }
    add(lines.join('\n'));
  }

  // The end of the log usually contains the final error.
  if (budget > 500 && log.lines.length > 0) {
    const tailCount = Math.min(log.lines.length, 150);
    const start = log.lines.length - tailCount + 1;
    const lines = [`\n# Last ${tailCount} log lines`];
    for (let i = start; i <= log.lines.length; i++) {
      lines.push(`L${i}: ${log.lines[i - 1]}`);
    }
    add(lines.join('\n'));
  }

  const user = redactor.redactString(parts.join('\n'));
  return { system: SYSTEM_PROMPT, user, size: user.length };
}

export function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      out.push([r[0], r[1]]);
    }
  }
  return out;
}
