import { HttpError, httpRequest, type HttpResponse, type HttpTransport } from '../core/http';
import { type Logger, nullLogger } from '../core/logger';
import { JenkinsResponseError, isObj, parseBuildDetails, parseJobDetails, parseJobs, parseJson, parseStages, parseTestReport } from './parse';
import { buildUrl, jobUrl, normalizeBaseUrl } from './paths';
import type { BuildDetails, ConsoleLog, JobDetails, JobSummary, ServerInfo, StageInfo, TestReport } from './types';

export interface JenkinsConnection {
  baseUrl: string;
  username: string;
  token: string;
  strictSSL: boolean;
  timeoutMs: number;
}

export type JenkinsErrorKind =
  | 'auth'
  | 'forbidden'
  | 'notFound'
  | 'network'
  | 'timeout'
  | 'tls'
  | 'redirect'
  | 'invalidResponse'
  | 'server'
  | 'cancelled'
  | 'tooLarge';

export class JenkinsError extends Error {
  constructor(
    message: string,
    readonly kind: JenkinsErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'JenkinsError';
  }
}

const BUILD_FIELDS = 'number,result,timestamp,duration,building,displayName';
const JOB_FIELDS = `name,displayName,color,description,lastBuild[${BUILD_FIELDS}]`;

/** Read-only Jenkins REST client. Only GET requests are issued, so no CSRF crumb is required. */
export class JenkinsClient {
  readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(
    private readonly conn: JenkinsConnection,
    private readonly logger: Logger = nullLogger,
    private readonly transport: HttpTransport = httpRequest,
  ) {
    this.baseUrl = normalizeBaseUrl(conn.baseUrl);
    this.authHeader = `Basic ${Buffer.from(`${conn.username}:${conn.token}`, 'utf8').toString('base64')}`;
  }

  jobWebUrl(path: readonly string[]): string {
    return path.length === 0 ? this.baseUrl : jobUrl(this.baseUrl, path);
  }

  buildWebUrl(path: readonly string[], buildNumber: number): string {
    return buildUrl(this.baseUrl, path, buildNumber);
  }

  /** Verifies connectivity, credentials and that the server is Jenkins. */
  async validate(signal?: AbortSignal): Promise<ServerInfo> {
    const res = await this.get(`${this.baseUrl}api/json?tree=jobs[name]`, 'server info', signal);
    const version = headerValue(res, 'x-jenkins');
    let root: unknown;
    try {
      root = parseJson(res.body.toString('utf8'), 'server info');
    } catch (e) {
      throw asJenkinsError(e);
    }
    if (!isObj(root)) {
      throw new JenkinsError('Unexpected response from server root.', 'invalidResponse');
    }
    if (!version && !Array.isArray(root.jobs)) {
      throw new JenkinsError('The server responded, but it does not look like Jenkins (no X-Jenkins header).', 'invalidResponse');
    }
    let user: string | undefined;
    let anonymous = true;
    try {
      const me = await this.get(`${this.baseUrl}me/api/json?tree=id,fullName`, 'current user', signal);
      const meJson = parseJson(me.body.toString('utf8'), 'current user');
      if (isObj(meJson) && typeof meJson.id === 'string') {
        user = meJson.id;
        anonymous = meJson.id === 'anonymous';
      }
    } catch (e) {
      this.logger.debug('whoami lookup failed', { error: e });
    }
    return { version, user, anonymous, rootJobCount: Array.isArray(root.jobs) ? root.jobs.length : 0 };
  }

  /** Lists direct children of the root (`[]`) or of a folder / multibranch / organization folder. */
  async listJobs(folderPath: readonly string[], signal?: AbortSignal): Promise<JobSummary[]> {
    const url = `${this.jobWebUrl(folderPath)}api/json?tree=jobs[${JOB_FIELDS},jobs[name]]`;
    return this.getParsed(url, 'job list', (j) => parseJobs(j, folderPath), signal);
  }

  async getJob(path: readonly string[], buildLimit: number, signal?: AbortSignal): Promise<JobDetails> {
    const limit = Math.max(1, Math.min(500, Math.floor(buildLimit)));
    const ref = 'number';
    const url =
      `${this.jobWebUrl(path)}api/json?tree=${JOB_FIELDS},builds[${BUILD_FIELDS}]{0,${limit}},` +
      `lastFailedBuild[${ref}],lastUnsuccessfulBuild[${ref}],lastCompletedBuild[${ref}]`;
    return this.getParsed(url, 'job', (j) => parseJobDetails(j, path), signal);
  }

  async getBuild(path: readonly string[], buildNumber: number, signal?: AbortSignal): Promise<BuildDetails> {
    const tree = [
      BUILD_FIELDS,
      'fullDisplayName,description,builtOn,url',
      'actions[causes[shortDescription],parameters[name,value],lastBuiltRevision[SHA1,branch[name]],remoteUrls,failCount,skipCount,totalCount]',
      'changeSets[items[msg,commitId,author[fullName]]]',
      'changeSet[items[msg,commitId,author[fullName]]]',
    ].join(',');
    return this.getParsed(`${this.buildWebUrl(path, buildNumber)}api/json?tree=${tree}`, 'build', parseBuildDetails, signal);
  }

  /**
   * Downloads the plain-text console log. Logs larger than `maxBytes` keep the first 1 MB and
   * the most recent `maxBytes - 1 MB`, since failures are usually near the end.
   */
  async getConsoleLog(path: readonly string[], buildNumber: number, maxBytes: number, signal?: AbortSignal): Promise<ConsoleLog> {
    const headBytes = Math.min(1024 * 1024, Math.floor(maxBytes / 4));
    const res = await this.get(`${this.buildWebUrl(path, buildNumber)}consoleText`, 'console log', signal, {
      truncate: { headBytes, tailBytes: maxBytes - headBytes },
      accept: 'text/plain',
    });
    return { text: res.body.toString('utf8'), truncated: res.truncated, totalBytes: res.totalBytes };
  }

  /** Returns undefined when the build has no JUnit report (404). */
  async getTestReport(path: readonly string[], buildNumber: number, signal?: AbortSignal): Promise<TestReport | undefined> {
    const caseFields = 'className,name,status,errorDetails,errorStackTrace,duration';
    const tree =
      `failCount,passCount,skipCount,suites[name,cases[${caseFields}]],` +
      `childReports[result[failCount,suites[name,cases[${caseFields}]]]]`;
    try {
      return await this.getParsed(
        `${this.buildWebUrl(path, buildNumber)}testReport/api/json?tree=${tree}`,
        'test report',
        (j) => parseTestReport(j),
        signal,
        { maxBytes: 30 * 1024 * 1024 },
      );
    } catch (e) {
      if (e instanceof JenkinsError && e.kind === 'notFound') {
        return undefined;
      }
      throw e;
    }
  }

  /** Pipeline stages via the Pipeline Stage View plugin. Undefined if the plugin or data is unavailable. */
  async getStages(path: readonly string[], buildNumber: number, signal?: AbortSignal): Promise<StageInfo[] | undefined> {
    try {
      return await this.getParsed(`${this.buildWebUrl(path, buildNumber)}wfapi/describe`, 'pipeline stages', parseStages, signal);
    } catch (e) {
      if (e instanceof JenkinsError && (e.kind === 'notFound' || e.kind === 'invalidResponse')) {
        return undefined;
      }
      throw e;
    }
  }

  /**
   * Recursively indexes all jobs (breadth first) for search/filter, bounded by depth and count.
   * Containers that fail to load are skipped and logged rather than failing the whole crawl.
   */
  async crawlJobs(
    options: { maxDepth: number; maxJobs: number; concurrency?: number; onProgress?: (count: number) => void },
    signal?: AbortSignal,
  ): Promise<{ jobs: JobSummary[]; complete: boolean }> {
    const all: JobSummary[] = [];
    let queue: (readonly string[])[] = [[]];
    let complete = true;
    const concurrency = options.concurrency ?? 4;
    for (let depth = 0; depth < options.maxDepth && queue.length > 0; depth++) {
      const next: (readonly string[])[] = [];
      for (let i = 0; i < queue.length; i += concurrency) {
        if (signal?.aborted) {
          throw new JenkinsError('Cancelled', 'cancelled');
        }
        const batch = queue.slice(i, i + concurrency);
        const results = await Promise.all(
          batch.map((p) =>
            this.listJobs(p, signal).catch((e: unknown) => {
              if (e instanceof JenkinsError && e.kind === 'cancelled') {
                throw e;
              }
              this.logger.warn('Skipping folder during crawl', { folder: p.join('/'), error: e });
              complete = false;
              return [] as JobSummary[];
            }),
          ),
        );
        for (const jobs of results) {
          for (const job of jobs) {
            all.push(job);
            if (job.isContainer) {
              next.push(job.path);
            }
          }
        }
        options.onProgress?.(all.length);
        if (all.length >= options.maxJobs) {
          return { jobs: all.slice(0, options.maxJobs), complete: false };
        }
      }
      queue = next;
    }
    if (queue.length > 0) {
      complete = false;
    }
    return { jobs: all, complete };
  }

  private async getParsed<T>(
    url: string,
    what: string,
    parser: (json: unknown) => T,
    signal?: AbortSignal,
    opts: { maxBytes?: number } = {},
  ): Promise<T> {
    const res = await this.get(url, what, signal, opts);
    try {
      return parser(parseJson(res.body.toString('utf8'), what));
    } catch (e) {
      throw asJenkinsError(e);
    }
  }

  private async get(
    url: string,
    what: string,
    signal?: AbortSignal,
    opts: { truncate?: { headBytes: number; tailBytes: number }; maxBytes?: number; accept?: string } = {},
  ): Promise<HttpResponse> {
    if (!url.startsWith(this.baseUrl)) {
      // Defence in depth: credentials only ever go to the configured server.
      throw new JenkinsError(`Refusing to send credentials to ${new URL(url).origin}`, 'invalidResponse');
    }
    const started = Date.now();
    let res: HttpResponse;
    try {
      res = await this.transport({
        url,
        method: 'GET',
        headers: { Authorization: this.authHeader, Accept: opts.accept ?? 'application/json' },
        timeoutMs: this.conn.timeoutMs,
        strictSSL: this.conn.strictSSL,
        signal,
        truncate: opts.truncate,
        maxBytes: opts.maxBytes ?? 20 * 1024 * 1024,
      });
    } catch (e) {
      throw mapTransportError(e);
    }
    const ms = Date.now() - started;
    this.logger.debug('GET', { what, path: new URL(url).pathname, status: res.status, ms, bytes: res.totalBytes });
    if (res.status >= 200 && res.status < 300) {
      return res;
    }
    throw statusError(res.status, what);
  }
}

function headerValue(res: HttpResponse, name: string): string | undefined {
  const v = res.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function statusError(status: number, what: string): JenkinsError {
  switch (status) {
    case 401:
      return new JenkinsError('Authentication failed (401). Check the username and API token.', 'auth', status);
    case 403:
      return new JenkinsError(
        `Access denied (403) while reading ${what}. The account needs Overall/Read and Job/Read permissions.`,
        'forbidden',
        status,
      );
    case 404:
      return new JenkinsError(`Not found (404): ${what}.`, 'notFound', status);
    default:
      if (status >= 500) {
        return new JenkinsError(`Jenkins server error (${status}) while reading ${what}.`, 'server', status);
      }
      return new JenkinsError(`Unexpected HTTP ${status} while reading ${what}.`, 'invalidResponse', status);
  }
}

function mapTransportError(e: unknown): Error {
  if (e instanceof HttpError) {
    switch (e.code) {
      case 'aborted':
        return new JenkinsError('Cancelled', 'cancelled');
      case 'timeout':
        return new JenkinsError(e.message, 'timeout');
      case 'tls':
        return new JenkinsError(e.message, 'tls');
      case 'redirect':
        return new JenkinsError(e.message, 'redirect');
      case 'too_large':
        return new JenkinsError(e.message, 'tooLarge');
      default:
        return new JenkinsError(e.message, 'network');
    }
  }
  if (e instanceof JenkinsResponseError) {
    return new JenkinsError(e.message, 'invalidResponse');
  }
  return e instanceof Error ? e : new Error(String(e));
}

/** Wraps parse errors thrown after a successful HTTP call into JenkinsError. */
export function asJenkinsError(e: unknown): JenkinsError | Error {
  if (e instanceof JenkinsError) {
    return e;
  }
  if (e instanceof JenkinsResponseError) {
    return new JenkinsError(e.message, 'invalidResponse');
  }
  return e instanceof Error ? e : new Error(String(e));
}
