import { SENSITIVE_NAME } from '../core/redact';
import type {
  BuildDetails,
  BuildParameter,
  BuildStatus,
  BuildSummary,
  ChangeEntry,
  JobDetails,
  JobKind,
  JobSummary,
  StageInfo,
  TestCaseFailure,
  TestReport,
} from './types';

/**
 * Runtime validation of Jenkins JSON. Jenkins responses vary by version and installed plugins,
 * so every field is treated as untrusted. Malformed entries are dropped, not thrown, except
 * when the top-level shape is wrong (that usually means an HTML/SSO page was returned).
 */

export class JenkinsResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JenkinsResponseError';
  }
}

type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown, max = 10_000): string | undefined {
  if (typeof v === 'string') {
    return v.length > max ? `${v.slice(0, max)}…` : v;
  }
  return undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function int(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
}
function bool(v: unknown): boolean {
  return v === true;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function parseJson(text: string, what: string): unknown {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<')) {
    throw new JenkinsResponseError(
      `Expected JSON for ${what} but received HTML. The URL may not point to Jenkins, or a login/SSO page intercepted the request.`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new JenkinsResponseError(`Invalid JSON received for ${what}.`);
  }
}

export function classifyJob(className: string, hasJobs: boolean): JobKind {
  const c = className;
  if (/OrganizationFolder$/.test(c)) {
    return 'organization';
  }
  if (/MultiBranchProject$/.test(c)) {
    return 'multibranch';
  }
  if (/\.Folder$|ComputedFolder$/.test(c)) {
    return 'folder';
  }
  if (/WorkflowJob$/.test(c)) {
    return 'pipeline';
  }
  if (/FreeStyleProject$/.test(c)) {
    return 'freestyle';
  }
  if (/MatrixProject$/.test(c)) {
    return 'matrix';
  }
  if (/MavenModuleSet$/.test(c)) {
    return 'maven';
  }
  if (/ExternalJob$/.test(c)) {
    return 'external';
  }
  return hasJobs ? 'folder' : 'unknown';
}

export function colorToStatus(color: string | undefined): BuildStatus {
  if (!color) {
    return 'unknown';
  }
  if (color.endsWith('_anime')) {
    return 'building';
  }
  switch (color) {
    case 'blue':
    case 'green':
      return 'success';
    case 'red':
      return 'failure';
    case 'yellow':
      return 'unstable';
    case 'aborted':
      return 'aborted';
    case 'notbuilt':
      return 'never';
    case 'disabled':
    case 'grey':
      return 'disabled';
    default:
      return 'unknown';
  }
}

export function resultToStatus(result: unknown, building: boolean): BuildStatus {
  if (building) {
    return 'building';
  }
  switch (result) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
      return 'failure';
    case 'UNSTABLE':
      return 'unstable';
    case 'ABORTED':
      return 'aborted';
    case 'NOT_BUILT':
      return 'notBuilt';
    default:
      return 'unknown';
  }
}

export function parseBuildSummary(v: unknown): BuildSummary | undefined {
  if (!isObj(v)) {
    return undefined;
  }
  const number = int(v.number);
  if (number === undefined) {
    return undefined;
  }
  const building = bool(v.building);
  return {
    number,
    building,
    status: resultToStatus(v.result, building),
    timestamp: num(v.timestamp),
    durationMs: num(v.duration),
    displayName: str(v.displayName, 200),
  };
}

export function parseJobs(json: unknown, parentPath: readonly string[]): JobSummary[] {
  if (!isObj(json)) {
    throw new JenkinsResponseError('Unexpected job list response.');
  }
  const out: JobSummary[] = [];
  for (const item of arr(json.jobs)) {
    const job = parseJob(item, parentPath);
    if (job) {
      out.push(job);
    }
  }
  return out;
}

export function parseJob(item: unknown, parentPath: readonly string[]): JobSummary | undefined {
  if (!isObj(item)) {
    return undefined;
  }
  const name = str(item.name, 500);
  if (!name || name.includes('/')) {
    return undefined;
  }
  const className = str(item._class, 300) ?? '';
  const hasJobs = Array.isArray(item.jobs);
  const kind = classifyJob(className, hasJobs);
  const isContainer = kind === 'folder' || kind === 'multibranch' || kind === 'organization' || hasJobs;
  return {
    name,
    displayName: str(item.displayName, 500) ?? decodeSafe(name),
    path: [...parentPath, name],
    kind,
    className,
    isContainer,
    status: isContainer ? 'unknown' : colorToStatus(str(item.color, 50)),
    lastBuild: parseBuildSummary(item.lastBuild),
    description: str(item.description, 2000) ?? undefined,
  };
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parseJobDetails(json: unknown, path: readonly string[]): JobDetails {
  if (!isObj(json)) {
    throw new JenkinsResponseError('Unexpected job response.');
  }
  const job = parseJob({ ...json, name: path[path.length - 1] }, path.slice(0, -1));
  if (!job) {
    throw new JenkinsResponseError('Job response missing required fields.');
  }
  const builds = arr(json.builds)
    .map(parseBuildSummary)
    .filter((b): b is BuildSummary => b !== undefined)
    .sort((a, b) => b.number - a.number);
  const ref = (v: unknown) => (isObj(v) ? int(v.number) : undefined);
  return {
    job,
    builds,
    lastFailedBuild: ref(json.lastFailedBuild),
    lastUnsuccessfulBuild: ref(json.lastUnsuccessfulBuild),
    lastCompletedBuild: ref(json.lastCompletedBuild),
  };
}

function stringifyParamValue(v: unknown): string {
  if (v === undefined || v === null) {
    return '';
  }
  if (typeof v === 'string') {
    return v.length > 500 ? `${v.slice(0, 500)}…` : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  try {
    const s = JSON.stringify(v);
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  } catch {
    return '';
  }
}

export function parseBuildDetails(json: unknown): BuildDetails {
  const summary = parseBuildSummary(json);
  if (!summary || !isObj(json)) {
    throw new JenkinsResponseError('Build response missing build number.');
  }
  const causes: string[] = [];
  const parameters: BuildParameter[] = [];
  const scm: BuildDetails['scm'] = { remoteUrls: [] };
  let testCounts: BuildDetails['testCounts'];

  for (const action of arr(json.actions)) {
    if (!isObj(action)) {
      continue;
    }
    for (const cause of arr(action.causes)) {
      const d = isObj(cause) ? str(cause.shortDescription, 500) : undefined;
      if (d && !causes.includes(d)) {
        causes.push(d);
      }
    }
    for (const p of arr(action.parameters)) {
      if (!isObj(p)) {
        continue;
      }
      const name = str(p.name, 200);
      if (!name) {
        continue;
      }
      const cls = str(p._class, 300) ?? '';
      const sensitive = /Password|Credentials/i.test(cls) || SENSITIVE_NAME.test(name);
      parameters.push({ name, sensitive, value: sensitive ? '******' : stringifyParamValue(p.value) });
    }
    if (isObj(action.lastBuiltRevision)) {
      const rev = action.lastBuiltRevision;
      scm.commit ??= str(rev.SHA1, 64);
      const branch = arr(rev.branch).find(isObj);
      if (branch) {
        scm.branch ??= str(branch.name, 300);
      }
    }
    for (const u of arr(action.remoteUrls)) {
      const s = str(u, 1000);
      if (s && !scm.remoteUrls.includes(s)) {
        scm.remoteUrls.push(s);
      }
    }
    const failCount = int(action.failCount);
    const totalCount = int(action.totalCount);
    if (failCount !== undefined && totalCount !== undefined) {
      testCounts = { failed: failCount, skipped: int(action.skipCount) ?? 0, total: totalCount };
    }
  }

  const changes: ChangeEntry[] = [];
  const changeSets = [...arr(json.changeSets), ...(isObj(json.changeSet) ? [json.changeSet] : [])];
  for (const set of changeSets) {
    if (!isObj(set)) {
      continue;
    }
    for (const item of arr(set.items)) {
      if (!isObj(item) || changes.length >= 50) {
        continue;
      }
      const author = isObj(item.author) ? str(item.author.fullName, 200) : undefined;
      changes.push({
        commitId: str(item.commitId, 64),
        author,
        message: str(item.msg, 500) ?? '',
      });
    }
  }

  return {
    ...summary,
    fullDisplayName: str(json.fullDisplayName, 500),
    description: str(json.description, 2000) ?? undefined,
    builtOn: str(json.builtOn, 200) || undefined,
    causes,
    parameters,
    scm,
    changes,
    testCounts,
  };
}

export function parseTestReport(json: unknown, maxFailures = 200): TestReport {
  if (!isObj(json)) {
    throw new JenkinsResponseError('Unexpected test report response.');
  }
  const failures: TestCaseFailure[] = [];
  let failCount = int(json.failCount) ?? 0;
  const passCount = int(json.passCount) ?? 0;
  const skipCount = int(json.skipCount) ?? 0;

  const visitSuites = (suites: unknown[]) => {
    for (const suite of suites) {
      if (!isObj(suite)) {
        continue;
      }
      const suiteName = str(suite.name, 500);
      for (const c of arr(suite.cases)) {
        if (!isObj(c) || failures.length >= maxFailures) {
          continue;
        }
        const status = str(c.status, 50) ?? '';
        if (status === 'FAILED' || status === 'REGRESSION' || status === 'ERROR') {
          failures.push({
            suite: suiteName,
            className: str(c.className, 500),
            name: str(c.name, 500) ?? '(unnamed test)',
            status,
            errorDetails: str(c.errorDetails, 4000),
            stackTrace: str(c.errorStackTrace, 8000),
            durationSec: num(c.duration),
          });
        }
      }
    }
  };
  visitSuites(arr(json.suites));
  // Aggregated reports (matrix / maven module sets) nest child reports.
  for (const child of arr(json.childReports)) {
    if (isObj(child) && isObj(child.result)) {
      visitSuites(arr(child.result.suites));
      failCount = Math.max(failCount, int(child.result.failCount) ?? 0);
    }
  }
  return { failCount: Math.max(failCount, failures.length), passCount, skipCount, failures };
}

/** Parses the pipeline-stage-view `wfapi/describe` response. */
export function parseStages(json: unknown): StageInfo[] {
  if (!isObj(json)) {
    throw new JenkinsResponseError('Unexpected stage response.');
  }
  const out: StageInfo[] = [];
  for (const s of arr(json.stages)) {
    if (!isObj(s)) {
      continue;
    }
    const name = str(s.name, 300);
    if (!name) {
      continue;
    }
    const err = isObj(s.error) ? [str(s.error.type, 300), str(s.error.message, 2000)].filter(Boolean).join(': ') : undefined;
    out.push({
      id: str(s.id, 50) ?? name,
      name,
      status: str(s.status, 50) ?? 'UNKNOWN',
      durationMs: num(s.durationMillis),
      startTimeMs: num(s.startTimeMillis),
      error: err || undefined,
    });
  }
  return out;
}

export function isFailedStageStatus(status: string): boolean {
  return status === 'FAILED' || status === 'UNSTABLE' || status === 'ABORTED';
}
