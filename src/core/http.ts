import * as http from 'node:http';
import * as https from 'node:https';
import * as zlib from 'node:zlib';
import { Readable } from 'node:stream';

/**
 * Small HTTP client on top of node:http(s). We use it instead of `fetch` because we need:
 * - per-request TLS verification control (self-signed internal Jenkins),
 * - hard response size caps and head+tail truncation for huge console logs,
 * - AbortSignal + timeout,
 * - a strict same-origin redirect policy so credentials are never sent to another host.
 */

export type HttpErrorCode = 'timeout' | 'aborted' | 'network' | 'tls' | 'too_large' | 'redirect' | 'invalid_url';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly code: HttpErrorCode,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Fail with `too_large` when the decoded body exceeds this size. Ignored when `truncate` is set. */
  maxBytes?: number;
  /** Instead of failing on large bodies, keep the first `headBytes` and last `tailBytes`. */
  truncate?: { headBytes: number; tailBytes: number };
  strictSSL?: boolean;
  /** Maximum number of same-origin redirects to follow (default 3). */
  maxRedirects?: number;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** True when the body was cut by `truncate`. */
  truncated: boolean;
  /** Total decoded bytes received (including those dropped by truncation). */
  totalBytes: number;
  /** Final URL after redirects. */
  url: string;
}

export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_NOT_YET_VALID',
]);

export const httpRequest: HttpTransport = async (req) => {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch (e) {
    throw new HttpError(`Invalid URL: ${req.url}`, 'invalid_url', e);
  }
  const origin = url.origin;
  let redirects = req.maxRedirects ?? 3;
  for (;;) {
    const res = await singleRequest(url, req);
    if (res.redirectTo === undefined) {
      return res.response;
    }
    const next = new URL(res.redirectTo, url);
    if (next.origin !== origin) {
      throw new HttpError(
        `Server redirected to a different origin (${next.origin}). Credentials are not forwarded across origins; ` +
          `check the configured URL (scheme/host/port) or whether an SSO proxy sits in front of Jenkins.`,
        'redirect',
      );
    }
    if (redirects-- <= 0) {
      throw new HttpError('Too many redirects', 'redirect');
    }
    url = next;
  }
};

interface SingleResult {
  response: HttpResponse;
  redirectTo?: string;
}

function singleRequest(url: URL, req: HttpRequest): Promise<SingleResult> {
  return new Promise<SingleResult>((resolve, reject) => {
    if (req.signal?.aborted) {
      reject(new HttpError('Request cancelled', 'aborted'));
      return;
    }
    const isHttps = url.protocol === 'https:';
    if (!isHttps && url.protocol !== 'http:') {
      reject(new HttpError(`Unsupported protocol ${url.protocol}`, 'invalid_url'));
      return;
    }
    const headers: Record<string, string> = {
      'Accept-Encoding': 'gzip, deflate',
      'User-Agent': 'jenkins-build-doctor-vscode',
      ...req.headers,
    };
    if (req.body !== undefined) {
      headers['Content-Length'] = String(Buffer.byteLength(req.body));
    }
    const options: https.RequestOptions = {
      method: req.method ?? 'GET',
      headers,
    };
    if (isHttps) {
      options.rejectUnauthorized = req.strictSSL !== false;
    }
    const lib = isHttps ? https : http;

    let settled = false;
    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        fn();
      }
    };

    const request = lib.request(url, options, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        finish(() =>
          resolve({
            redirectTo: res.headers.location,
            response: { status, headers: res.headers, body: Buffer.alloc(0), truncated: false, totalBytes: 0, url: url.toString() },
          }),
        );
        return;
      }
      let stream: Readable = res;
      const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
      if (encoding === 'gzip' || encoding === 'x-gzip') {
        stream = res.pipe(zlib.createGunzip());
      } else if (encoding === 'deflate') {
        stream = res.pipe(zlib.createInflate());
      }

      const collector = new BodyCollector(req.truncate, req.maxBytes ?? DEFAULT_MAX_BYTES);
      stream.on('data', (chunk: Buffer) => {
        if (!collector.push(chunk)) {
          request.destroy();
          finish(() => reject(new HttpError(`Response exceeded ${req.maxBytes ?? DEFAULT_MAX_BYTES} bytes`, 'too_large')));
        }
      });
      stream.on('end', () => {
        finish(() =>
          resolve({
            response: {
              status,
              headers: res.headers,
              body: collector.result(),
              truncated: collector.truncated,
              totalBytes: collector.total,
              url: url.toString(),
            },
          }),
        );
      });
      stream.on('error', (err) => finish(() => reject(new HttpError(`Failed to read response: ${err.message}`, 'network', err))));
    });

    const timer = setTimeout(() => {
      request.destroy();
      finish(() => reject(new HttpError(`Request timed out after ${Math.round(req.timeoutMs / 1000)}s`, 'timeout')));
    }, req.timeoutMs);

    const onAbort = () => {
      request.destroy();
      finish(() => reject(new HttpError('Request cancelled', 'aborted')));
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });

    request.on('error', (err: NodeJS.ErrnoException) => {
      const code = err.code ?? '';
      if (TLS_CODES.has(code) || /certificate|SSL|TLS/i.test(err.message)) {
        finish(() =>
          reject(
            new HttpError(
              `TLS error (${code || err.message}). If this is an internal CA, install it in the OS trust store; ` +
                `as a last resort disable 'jenkinsBuildDoctor.server.strictSSL'.`,
              'tls',
              err,
            ),
          ),
        );
      } else {
        finish(() => reject(new HttpError(`Network error: ${code ? `${code} ` : ''}${err.message}`, 'network', err)));
      }
    });

    if (req.body !== undefined) {
      request.write(req.body);
    }
    request.end();
  });
}

/** Collects a body either fully (with a cap) or as head + rolling tail. */
export class BodyCollector {
  private readonly chunks: Buffer[] = [];
  private headSize = 0;
  private tail: Buffer[] = [];
  private tailSize = 0;
  total = 0;
  truncated = false;

  constructor(
    private readonly truncate: { headBytes: number; tailBytes: number } | undefined,
    private readonly maxBytes: number,
  ) {}

  /** Returns false when the hard cap is exceeded (non-truncating mode). */
  push(chunk: Buffer): boolean {
    this.total += chunk.length;
    if (!this.truncate) {
      if (this.total > this.maxBytes) {
        return false;
      }
      this.chunks.push(chunk);
      return true;
    }
    const { headBytes, tailBytes } = this.truncate;
    if (this.headSize < headBytes) {
      const take = Math.min(headBytes - this.headSize, chunk.length);
      this.chunks.push(chunk.subarray(0, take));
      this.headSize += take;
      chunk = chunk.subarray(take);
      if (chunk.length === 0) {
        return true;
      }
    }
    this.tail.push(chunk);
    this.tailSize += chunk.length;
    // Drop whole leading chunks while the remainder still covers tailBytes.
    while (this.tail.length > 1 && this.tailSize - this.tail[0].length >= tailBytes) {
      this.tailSize -= this.tail[0].length;
      this.tail.shift();
      this.truncated = true;
    }
    return true;
  }

  result(): Buffer {
    if (!this.truncate) {
      return Buffer.concat(this.chunks);
    }
    let tail = Buffer.concat(this.tail);
    if (tail.length > this.truncate.tailBytes) {
      tail = tail.subarray(tail.length - this.truncate.tailBytes);
      this.truncated = true;
    }
    if (!this.truncated) {
      return Buffer.concat([...this.chunks, tail]);
    }
    const head = Buffer.concat(this.chunks);
    // Start the tail on a line boundary so the first line is not a fragment.
    const nl = tail.indexOf(10);
    if (nl >= 0 && nl < 4096) {
      tail = tail.subarray(nl + 1);
    }
    const marker = Buffer.from(
      `\n\n[jenkins-build-doctor] … console log truncated: ${this.total - head.length - tail.length} bytes omitted …\n\n`,
    );
    return Buffer.concat([head, marker, tail]);
  }
}

/** Links an AbortSignal to a timeout and/or parent signal. */
export function linkedAbort(parent?: AbortSignal): AbortController {
  const ctrl = new AbortController();
  if (parent) {
    if (parent.aborted) {
      ctrl.abort();
    } else {
      parent.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
  }
  return ctrl;
}
