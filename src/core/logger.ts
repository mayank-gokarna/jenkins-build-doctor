/**
 * Minimal structured logger. Core modules depend only on the `Logger` interface so they
 * can be unit-tested without VS Code; the extension wires it to a LogOutputChannel.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface Logger {
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields | unknown): void;
  child(scope: string): Logger;
}

export type LogSink = (level: LogLevel, line: string) => void;

export interface StructuredLoggerOptions {
  /** Applied to the fully formatted line, so secrets never reach the sink. */
  redact?: (text: string) => string;
}

export class StructuredLogger implements Logger {
  constructor(
    private readonly sink: LogSink,
    private readonly scope = '',
    private readonly options: StructuredLoggerOptions = {},
  ) {}

  trace(message: string, fields?: LogFields): void {
    this.write('trace', message, fields);
  }
  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }
  error(message: string, fields?: LogFields | unknown): void {
    if (fields instanceof Error) {
      this.write('error', message, { error: describeError(fields) });
    } else if (fields !== undefined && (typeof fields !== 'object' || fields === null)) {
      this.write('error', message, { error: String(fields) });
    } else {
      this.write('error', message, fields as LogFields | undefined);
    }
  }

  child(scope: string): Logger {
    return new StructuredLogger(this.sink, this.scope ? `${this.scope}.${scope}` : scope, this.options);
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    let line = this.scope ? `[${this.scope}] ${message}` : message;
    if (fields && Object.keys(fields).length > 0) {
      line += ` ${safeStringify(fields)}`;
    }
    if (this.options.redact) {
      line = this.options.redact(line);
    }
    this.sink(level, line);
  }
}

export function describeError(err: unknown): Record<string, unknown> | string {
  if (err instanceof Error) {
    const out: Record<string, unknown> = { name: err.name, message: err.message };
    for (const key of ['kind', 'status', 'code'] as const) {
      const v = (err as unknown as Record<string, unknown>)[key];
      if (v !== undefined) {
        out[key] = v;
      }
    }
    return out;
  }
  return String(err);
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, v: unknown) => {
      if (v instanceof Error) {
        return describeError(v);
      }
      if (typeof v === 'string' && v.length > 2000) {
        return `${v.slice(0, 2000)}…(${v.length} chars)`;
      }
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) {
          return '[circular]';
        }
        seen.add(v);
      }
      return v;
    });
  } catch {
    return '[unserializable]';
  }
}

export const nullLogger: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => nullLogger,
};
