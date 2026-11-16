export type JobKind =
  | 'folder'
  | 'multibranch'
  | 'organization'
  | 'pipeline'
  | 'freestyle'
  | 'matrix'
  | 'maven'
  | 'external'
  | 'unknown';

export type BuildStatus =
  | 'success'
  | 'failure'
  | 'unstable'
  | 'aborted'
  | 'notBuilt'
  | 'building'
  | 'disabled'
  | 'never'
  | 'unknown';

export interface BuildSummary {
  number: number;
  status: BuildStatus;
  building: boolean;
  timestamp?: number;
  durationMs?: number;
  displayName?: string;
}

export interface JobSummary {
  /** URL-level name (may contain encoded characters such as `feature%2Fx` for branches). */
  name: string;
  displayName: string;
  /** Names from the root to this job, used to build URLs. */
  path: string[];
  kind: JobKind;
  className: string;
  /** True when the item contains other jobs (folder, multibranch, organization). */
  isContainer: boolean;
  status: BuildStatus;
  lastBuild?: BuildSummary;
  description?: string;
}

export interface JobDetails {
  job: JobSummary;
  builds: BuildSummary[];
  lastFailedBuild?: number;
  lastUnsuccessfulBuild?: number;
  lastCompletedBuild?: number;
}

export interface BuildParameter {
  name: string;
  value: string;
  sensitive: boolean;
}

export interface ChangeEntry {
  commitId?: string;
  author?: string;
  message: string;
}

export interface BuildDetails extends BuildSummary {
  fullDisplayName?: string;
  description?: string;
  builtOn?: string;
  causes: string[];
  parameters: BuildParameter[];
  scm: { branch?: string; commit?: string; remoteUrls: string[] };
  changes: ChangeEntry[];
  testCounts?: { failed: number; skipped: number; total: number };
}

export interface TestCaseFailure {
  suite?: string;
  className?: string;
  name: string;
  status: string;
  errorDetails?: string;
  stackTrace?: string;
  durationSec?: number;
}

export interface TestReport {
  failCount: number;
  passCount: number;
  skipCount: number;
  failures: TestCaseFailure[];
}

export interface StageInfo {
  id: string;
  name: string;
  status: string;
  durationMs?: number;
  startTimeMs?: number;
  error?: string;
}

export interface ConsoleLog {
  text: string;
  truncated: boolean;
  totalBytes: number;
}

export interface ServerInfo {
  version?: string;
  user?: string;
  anonymous: boolean;
  rootJobCount: number;
}

/** Everything gathered about one build, the input to the analysis engine. */
export interface BuildContext {
  jobPath: string[];
  jobDisplayName: string;
  jobKind: JobKind;
  build: BuildDetails;
  log: ConsoleLog;
  testReport?: TestReport;
  stages?: StageInfo[];
  webUrl?: string;
}
