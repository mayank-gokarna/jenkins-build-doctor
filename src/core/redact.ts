/**
 * Secret redaction for console logs, reports, structured logs and AI prompts.
 *
 * Every replacement preserves the number of newlines in the matched text so that
 * line numbers in redacted logs stay aligned with the original log.
 */

export const MASK = '******';

export interface RedactionResult {
  text: string;
  count: number;
}

interface RedactionPattern {
  name: string;
  regex: RegExp;
  /** Replacement; receives the full match and capture groups. */
  replace: (match: string, ...groups: string[]) => string;
}

const keepPrefix =
  (group = 1) =>
  (_m: string, ...g: string[]) =>
    `${g[group - 1] ?? ''}${MASK}`;

/**
 * Built-in patterns, ordered from most specific to most generic. Patterns avoid `\s`
 * (which would span lines) except where a multi-line block is intended.
 */
const BUILT_IN_PATTERNS: RedactionPattern[] = [
  {
    name: 'private-key-block',
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: (m) => `[REDACTED PRIVATE KEY]${'\n'.repeat(countNewlines(m))}`,
  },
  {
    name: 'url-credentials',
    regex: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@'"]+):([^\s/@'"]+)@/gi,
    replace: (_m, scheme: string) => `${scheme}${MASK}:${MASK}@`,
  },
  {
    name: 'authorization-header',
    regex: /\b((?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?(?:basic|bearer|token|digest|negotiate|aws4-hmac-sha256)?[ \t]*)([^\s"',;]+)/gi,
    replace: keepPrefix(),
  },
  { name: 'aws-access-key-id', regex: /\b((?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16})\b/g, replace: () => MASK },
  { name: 'github-token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g, replace: () => MASK },
  { name: 'gitlab-token', regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, replace: () => MASK },
  { name: 'slack-token', regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, replace: () => MASK },
  { name: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: () => MASK },
  { name: 'npm-token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: () => MASK },
  { name: 'anthropic-or-openai-key', regex: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, replace: () => MASK },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: () => MASK },
  {
    name: 'connection-string-secret',
    regex: /\b((?:AccountKey|SharedAccessKey|SharedAccessSignature|Password|Pwd)=)([^;"'\s]+)/gi,
    replace: keepPrefix(),
  },
  {
    name: 'npmrc-auth',
    regex: /(_(?:authToken|auth|password)[ \t]*=[ \t]*)(\S+)/gi,
    replace: keepPrefix(),
  },
  {
    name: 'cli-password-flag',
    regex: /((?:^|[ \t])--?(?:password|passwd|pass|token|secret|api-key|apikey)(?:[ \t]+|=))(?!-)(["']?)([^\s"']+)\2/gim,
    replace: (_m, prefix: string, quote: string) => `${prefix}${quote}${MASK}${quote}`,
  },
  {
    name: 'docker-login-p',
    regex: /(docker[ \t]+login\b[^\n]*?[ \t]-p[ \t]+)(\S+)/gi,
    replace: keepPrefix(),
  },
  {
    // key=value / key: value / "key": "value" where key looks sensitive.
    name: 'sensitive-assignment',
    regex:
      /(["']?\b[\w.-]*?(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?)[\w.-]*["']?[ \t]*[:=][ \t]*["']?)(?!\*{3})([^\s"',;}{)(]{3,})/gi,
    replace: keepPrefix(),
  },
];

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) {
      n++;
    }
  }
  return n;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface RedactorOptions {
  /** Literal values that must never appear (e.g. the configured Jenkins API token). */
  knownSecrets?: readonly string[];
  /** Extra user-supplied regular expressions. Invalid expressions are reported via `invalidPatterns`. */
  extraPatterns?: readonly string[];
}

export class Redactor {
  private readonly patterns: RedactionPattern[];
  readonly invalidPatterns: string[] = [];

  constructor(options: RedactorOptions = {}) {
    this.patterns = [...BUILT_IN_PATTERNS];
    for (const secret of options.knownSecrets ?? []) {
      // Very short values would cause massive false positives; they are not real secrets anyway.
      if (secret && secret.length >= 6) {
        this.patterns.unshift({ name: 'known-secret', regex: new RegExp(escapeRegExp(secret), 'g'), replace: () => MASK });
      }
    }
    for (const source of options.extraPatterns ?? []) {
      try {
        const regex = new RegExp(source, 'g');
        // Reject patterns that match the empty string: they would loop forever / mask everything.
        if (regex.test('')) {
          this.invalidPatterns.push(source);
          continue;
        }
        regex.lastIndex = 0;
        this.patterns.push({
          name: 'custom',
          regex,
          replace: (m) => `${MASK}${'\n'.repeat(countNewlines(m))}`,
        });
      } catch {
        this.invalidPatterns.push(source);
      }
    }
  }

  redact(text: string): RedactionResult {
    let count = 0;
    let out = text;
    for (const p of this.patterns) {
      p.regex.lastIndex = 0;
      out = out.replace(p.regex, (...args: unknown[]) => {
        const match = args[0] as string;
        // Groups are the args between the match and the offset (a number).
        const groups: string[] = [];
        for (let i = 1; i < args.length && typeof args[i] !== 'number'; i++) {
          groups.push((args[i] as string | undefined) ?? '');
        }
        const replaced = p.replace(match, ...groups);
        if (replaced !== match) {
          count++;
        }
        return replaced;
      });
    }
    return { text: out, count };
  }

  redactString(text: string): string {
    return this.redact(text).text;
  }
}

/** Parameter names whose values should never be displayed. */
export const SENSITIVE_NAME = /pass(word|wd)?|secret|token|api[_-]?key|credential|private[_-]?key|auth/i;
