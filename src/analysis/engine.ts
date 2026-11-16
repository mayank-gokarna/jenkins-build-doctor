import { Redactor } from '../core/redact';
import { isFailedStageStatus } from '../jenkins/parse';
import type { BuildContext, BuildStatus, StageInfo } from '../jenkins/types';
import { attributeStages, cleanLines, type ProcessedLog } from './preprocess';
import { compileRules, fillTemplate, scanLines, type CompiledRule } from './ruleEngine';
import { BUILT_IN_RULES } from './rules';
import type { Diagnosis, Evidence, Finding, RuleDefinition, RuleMatch } from './types';

export interface AnalyzeOptions {
  redactor: Redactor;
  /** When false, the log shown to the user is not redacted (AI prompts are always redacted separately). */
  redactLog: boolean;
  contextLines: number;
  customRules?: RuleDefinition[];
  /** Extra notes to surface (e.g. invalid custom rules). */
  notes?: string[];
  signal?: AbortSignal;
}

export interface AnalyzeResult {
  diagnosis: Diagnosis;
  /** The cleaned (and, unless disabled, redacted) log that evidence line numbers refer to. */
  log: ProcessedLog;
}

const MAX_EVIDENCE = 6;

let builtInCompiled: CompiledRule[] | undefined;

export async function analyzeBuild(ctx: BuildContext, options: AnalyzeOptions): Promise<AnalyzeResult> {
  const started = Date.now();
  const notes = [...(options.notes ?? [])];

  // 1. Clean and redact the log (redaction preserves line count).
  let lines = cleanLines(ctx.log.text);
  let redactions = 0;
  if (options.redactLog) {
    const r = options.redactor.redact(lines.join('\n'));
    redactions = r.count;
    lines = r.text.split('\n');
  }
  const { stageIndex, stageNames } = attributeStages(lines);
  const log: ProcessedLog = { lines, stageIndex, stageNames };

  // 2. Scan with built-in + custom rules.
  builtInCompiled ??= compileRules(BUILT_IN_RULES);
  const rules = [...builtInCompiled, ...compileRules(options.customRules ?? [])];
  const matchesByRule = await scanLines(lines, rules, { signal: options.signal });

  // 3. Locate the failure point: the first generic failure marker (excluding the final "Finished:" line).
  let failurePoint = lines.length;
  for (const rule of rules) {
    if (rule.def.symptom && rule.def.id !== 'generic.finished-failure') {
      const first = matchesByRule.get(rule.def.id)?.[0];
      if (first && first.line < failurePoint) {
        failurePoint = first.line;
      }
    }
  }
  if (failurePoint === lines.length) {
    const fin = matchesByRule.get('generic.finished-failure')?.[0];
    if (fin) {
      failurePoint = fin.line;
    }
  }

  const stages = ctx.stages ?? [];
  const failedStages = stages.filter((s) => isFailedStageStatus(s.status));
  const failedStageNames = failedStages.map((s) => s.name);

  const evidenceFor = (m: RuleMatch): Evidence => {
    const idx = m.line - 1;
    const from = Math.max(0, idx - options.contextLines);
    const to = Math.min(lines.length - 1, idx + options.contextLines);
    const stage = stageIndex[idx] >= 0 ? stageNames[stageIndex[idx]] : undefined;
    return {
      line: m.line,
      text: m.text,
      stage,
      source: 'log',
      before: range(from, idx - 1).map((i) => ({ line: i + 1, text: lines[i] })),
      after: range(idx + 1, to).map((i) => ({ line: i + 1, text: lines[i] })),
    };
  };

  // 4. Turn matches into scored findings.
  const findings: Finding[] = [];
  const fallback: Finding[] = [];
  for (const rule of rules) {
    const matches = matchesByRule.get(rule.def.id);
    if (!matches) {
      continue;
    }
    const finding = buildFinding(rule.def, matches, failurePoint, failedStageNames, evidenceFor, stageIndex, stageNames);
    (rule.def.fallbackOnly ? fallback : findings).push(finding);
  }

  // 5. Test report from the Jenkins API (strongest evidence for test failures).
  const red = (s: string | undefined) => (s === undefined ? undefined : options.redactor.redactString(s));
  const report = ctx.testReport && {
    ...ctx.testReport,
    failures: ctx.testReport.failures.map((f) => ({ ...f, errorDetails: red(f.errorDetails), stackTrace: red(f.stackTrace) })),
  };
  if (report && report.failures.length > 0) {
    const fromReport = testReportFinding(report.failCount, report.failures);
    // The API report names the exact tests, so it outranks log-derived test findings.
    const bestLogTest = Math.max(0, ...findings.filter((f) => f.category === 'test').map((f) => f.score));
    fromReport.score = Math.max(fromReport.score, bestLogTest + 1);
    findings.push(fromReport);
  }

  // 6. Fallbacks when nothing specific matched.
  // 'unknown' covers logs analysed outside Jenkins (e.g. from an editor).
  const failed = ['failure', 'unstable', 'aborted', 'unknown'].includes(ctx.build.status);
  if (!findings.some((f) => !f.symptom)) {
    findings.push(...fallback);
    if (failed && !findings.some((f) => !f.symptom)) {
      findings.push(unknownFinding(lines, failurePoint, evidenceFor));
    }
  }

  // Stage errors from wfapi corroborate the location.
  for (const stage of failedStages) {
    if (stage.error) {
      notes.push(`Jenkins reports stage “${stage.name}” ${stage.status.toLowerCase()}: ${options.redactor.redactString(stage.error)}`);
    }
  }

  findings.sort((a, b) => b.score - a.score);
  const primary = failed || ctx.build.status === 'building' ? (findings.find((f) => !f.symptom) ?? findings[0]) : undefined;
  if (primary) {
    primary.rankingNotes.unshift('Ranked as the most probable root cause: highest score after weighting specificity, proximity to the failure point and stage.');
  }

  if (ctx.log.truncated) {
    notes.push(
      `The console log is ${formatBytes(ctx.log.totalBytes)}; only the beginning and the most recent part were analysed. ` +
        'Increase "jenkinsBuildDoctor.analysis.maxLogSizeMB" to analyse more.',
    );
  }
  if (redactions > 0) {
    notes.push(`${redactions} potential secret(s) were redacted from the log before display.`);
  }
  if (!options.redactLog) {
    notes.push('Log redaction is disabled ("jenkinsBuildDoctor.security.redactConsoleOutput"). Evidence may contain secrets.');
  }
  if (lines.length === 0) {
    notes.push('The console log is empty.');
  }

  const diagnosis: Diagnosis = {
    job: { path: ctx.jobPath, displayName: ctx.jobDisplayName, kind: ctx.jobKind, webUrl: ctx.webUrl },
    build: {
      number: ctx.build.number,
      status: ctx.build.status,
      timestamp: ctx.build.timestamp,
      durationMs: ctx.build.durationMs,
      builtOn: ctx.build.builtOn,
      causes: ctx.build.causes,
      parameters: ctx.build.parameters.map((p) => ({ name: p.name, value: p.sensitive ? p.value : options.redactor.redactString(p.value) })),
      branch: ctx.build.scm.branch,
      commit: ctx.build.scm.commit,
      changes: ctx.build.changes.map((c) => ({ ...c, message: options.redactor.redactString(c.message) })),
      webUrl: ctx.webUrl,
    },
    headline: headline(ctx.build.number, ctx.build.status, primary, failedStages),
    primary,
    findings,
    failedStages,
    stages,
    failedTests: report?.failures ?? [],
    testSummary: report ? { failed: report.failCount, passed: report.passCount, skipped: report.skipCount } : undefined,
    notes,
    stats: {
      lines: lines.length,
      bytes: ctx.log.text.length,
      totalBytes: ctx.log.totalBytes,
      truncated: ctx.log.truncated,
      redactions,
      analysisMs: Date.now() - started,
      rulesEvaluated: rules.length,
    },
    analyzedAt: Date.now(),
  };
  return { diagnosis, log };
}

function buildFinding(
  def: RuleDefinition,
  matches: RuleMatch[],
  failurePoint: number,
  failedStageNames: string[],
  evidenceFor: (m: RuleMatch) => Evidence,
  stageIndex: Int32Array,
  stageNames: string[],
): Finding {
  const rankingNotes: string[] = [];
  // Anchor: the last match at or before the failure point, else the first match.
  const before = matches.filter((m) => m.line <= failurePoint);
  const anchor = before.length > 0 ? before[before.length - 1] : matches[0];

  let score = def.weight;
  const distance = failurePoint - anchor.line;
  if (distance >= 0) {
    const bonus = 15 * Math.max(0, 1 - distance / 3000);
    score += bonus;
    if (bonus > 10) {
      rankingNotes.push(`Occurs shortly before the failure point (${distance} line(s) earlier).`);
    }
  } else {
    score += 3;
  }

  const stageOf = (m: RuleMatch) => (stageIndex[m.line - 1] >= 0 ? stageNames[stageIndex[m.line - 1]] : undefined);
  const inFailedStage = failedStageNames.find((name) => matches.some((m) => stageOf(m)?.split(' › ').includes(name)));
  if (inFailedStage) {
    score += 12;
    rankingNotes.push(`Found inside the failed stage “${inFailedStage}”.`);
  }
  score += Math.min(4, Math.log2(matches.length));
  if (def.certainty === 'hypothesis') {
    score -= 4;
  }
  if (def.symptom) {
    rankingNotes.push('Generic failure marker: indicates where the build failed, not why.');
  }

  // Evidence: the anchor first, then the earliest occurrences, then the latest.
  const picked = new Map<number, RuleMatch>();
  picked.set(anchor.line, anchor);
  for (const m of [...matches.slice(0, 3), ...matches.slice(-2)]) {
    if (picked.size >= MAX_EVIDENCE) {
      break;
    }
    picked.set(m.line, m);
  }
  const evidence = [...picked.values()].map(evidenceFor);

  const extra = def.enrich?.(matches) ?? {};
  return {
    ruleId: def.id,
    category: def.category,
    title: def.title,
    certainty: def.certainty,
    summary: extra.summary ?? fillTemplate(def.summary, anchor),
    occurrences: matches.length,
    evidence,
    causes: [...(extra.causes ?? []), ...def.causes],
    remediation: [...def.remediation, ...(extra.remediation ?? [])],
    score: Math.round(score * 10) / 10,
    symptom: def.symptom === true,
    rankingNotes,
  };
}

function testReportFinding(failCount: number, failures: NonNullable<BuildContext['testReport']>['failures']): Finding {
  const evidence: Evidence[] = failures.slice(0, MAX_EVIDENCE).map((f) => ({
    text: `${f.className ? `${f.className}.` : ''}${f.name}${f.errorDetails ? ` — ${firstLine(f.errorDetails)}` : ''}`,
    source: 'testReport',
    before: [],
    after: f.stackTrace
      ? f.stackTrace
          .split('\n')
          .slice(0, 4)
          .map((t) => ({ line: 0, text: t }))
      : [],
  }));
  return {
    ruleId: 'test.report',
    category: 'test',
    title: 'Failing tests reported by Jenkins',
    certainty: 'confirmed',
    summary: `${failCount} test(s) failed according to the Jenkins test report.`,
    occurrences: failCount,
    evidence,
    causes: [
      'A regression introduced by the changes in this build.',
      'A flaky test — check its history in the Jenkins test report (“age” column).',
      'Environment differences on the agent (timezone, locale, network, services).',
    ],
    remediation: [
      'Run the listed tests locally with the same configuration.',
      'Compare with the last successful build\'s changes to locate the regression.',
    ],
    score: 92,
    symptom: false,
    rankingNotes: ['Reported directly by the Jenkins JUnit test report API.'],
  };
}

function unknownFinding(lines: string[], failurePoint: number, evidenceFor: (m: RuleMatch) => Evidence): Finding {
  const end = Math.min(lines.length, failurePoint);
  const tail = lines.length === 0 ? [] : [Math.max(1, end)];
  return {
    ruleId: 'generic.unknown',
    category: 'generic',
    title: 'No known failure pattern recognised',
    certainty: 'hypothesis',
    summary: 'The rule engine did not recognise the failure. The lines just before the failure point are the most likely place to look.',
    occurrences: 0,
    evidence: tail.map((line) => {
      const e = evidenceFor({ line, text: lines[line - 1], match: '', groups: [] });
      return { ...e, before: range(Math.max(0, line - 21), line - 2).map((i) => ({ line: i + 1, text: lines[i] })) };
    }),
    causes: ['A tool-specific error not covered by the built-in rules.'],
    remediation: [
      'Read the highlighted section of the console log.',
      'Add a custom rule (setting "jenkinsBuildDoctor.analysis.customRules") so this failure is recognised next time.',
      'Optionally use "Ask AI" if an AI provider is configured.',
    ],
    score: 1,
    symptom: false,
    rankingNotes: [],
  };
}

const STATUS_LABEL: Record<BuildStatus, string> = {
  success: 'Succeeded',
  failure: 'Failed',
  unstable: 'Unstable',
  aborted: 'Aborted',
  notBuilt: 'Not built',
  building: 'In progress',
  disabled: 'Disabled',
  never: 'Never built',
  unknown: 'Diagnosis',
};

function headline(number: number, status: BuildStatus, primary: Finding | undefined, failedStages: StageInfo[]): string {
  if (status === 'success') {
    return `Build #${number} succeeded — there is no failure to diagnose.`;
  }
  const where = failedStages.length > 0 ? ` in stage “${failedStages[0].name}”` : '';
  if (!primary) {
    return `Build #${number}: ${STATUS_LABEL[status]}${where}.`;
  }
  return `${STATUS_LABEL[status]}${where}: ${primary.title}`;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) {
    out.push(i);
  }
  return out;
}

function firstLine(s: string): string {
  const l = s.split('\n')[0];
  return l.length > 300 ? `${l.slice(0, 300)}…` : l;
}

export function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
