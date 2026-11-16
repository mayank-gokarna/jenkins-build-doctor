import type { BuildStatus, JobKind, StageInfo, TestCaseFailure } from '../jenkins/types';

export type Category =
  | 'compilation'
  | 'test'
  | 'dependency'
  | 'authentication'
  | 'infrastructure'
  | 'resource'
  | 'kubernetes'
  | 'deployment'
  | 'docker'
  | 'scm'
  | 'pipeline'
  | 'configuration'
  | 'quality'
  | 'timeout'
  | 'generic';

export const CATEGORY_LABELS: Record<Category, string> = {
  compilation: 'Compilation',
  test: 'Test failure',
  dependency: 'Dependency',
  authentication: 'Authentication / authorization',
  infrastructure: 'Infrastructure / network',
  resource: 'Resources (memory / disk)',
  kubernetes: 'Kubernetes',
  deployment: 'Deployment',
  docker: 'Docker',
  scm: 'Source control',
  pipeline: 'Pipeline script',
  configuration: 'Configuration / environment',
  quality: 'Quality gate',
  timeout: 'Timeout / abort',
  generic: 'General',
};

/**
 * `confirmed`: the log/API contains an explicit statement of this problem.
 * `hypothesis`: the conclusion is inferred from indirect signals and must be verified.
 */
export type Certainty = 'confirmed' | 'hypothesis';

export interface RuleDefinition {
  id: string;
  title: string;
  category: Category;
  certainty: Certainty;
  /** 1–100. Specific root-cause errors score high; generic "something failed" symptoms low. */
  weight: number;
  patterns: RegExp[];
  /** Matches on the same line that should be ignored (false-positive guard). */
  exclude?: RegExp;
  /** Template: `{0}` whole match, `{1}`.. capture groups, `{g}` first non-empty group. */
  summary: string;
  causes: string[];
  remediation: string[];
  /** Generic failure markers. They locate the failure point but are rarely the root cause. */
  symptom?: boolean;
  /** Only reported when nothing more specific matched. */
  fallbackOnly?: boolean;
  /** Adds case-specific causes/remediation based on the matches. */
  enrich?: (matches: RuleMatch[]) => { causes?: string[]; remediation?: string[]; summary?: string };
}

export interface RuleMatch {
  line: number; // 1-based
  /** Full text of the matching line. */
  text: string;
  /** The matched substring. */
  match: string;
  groups: (string | undefined)[];
}

export interface ContextLine {
  line: number;
  text: string;
}

export interface Evidence {
  line?: number;
  text: string;
  stage?: string;
  before: ContextLine[];
  after: ContextLine[];
  source: 'log' | 'testReport' | 'stages' | 'metadata';
}

export interface Finding {
  ruleId: string;
  category: Category;
  title: string;
  certainty: Certainty;
  summary: string;
  occurrences: number;
  evidence: Evidence[];
  causes: string[];
  remediation: string[];
  score: number;
  symptom: boolean;
  /** Why this finding was ranked where it is. */
  rankingNotes: string[];
}

export interface Diagnosis {
  job: { path: string[]; displayName: string; kind: JobKind; webUrl?: string };
  build: {
    number: number;
    status: BuildStatus;
    timestamp?: number;
    durationMs?: number;
    builtOn?: string;
    causes: string[];
    parameters: { name: string; value: string }[];
    branch?: string;
    commit?: string;
    changes: { commitId?: string; author?: string; message: string }[];
    webUrl?: string;
  };
  headline: string;
  primary?: Finding;
  findings: Finding[];
  failedStages: StageInfo[];
  stages: StageInfo[];
  failedTests: TestCaseFailure[];
  testSummary?: { failed: number; passed: number; skipped: number };
  notes: string[];
  stats: {
    lines: number;
    bytes: number;
    totalBytes: number;
    truncated: boolean;
    redactions: number;
    analysisMs: number;
    rulesEvaluated: number;
  };
  analyzedAt: number;
}
