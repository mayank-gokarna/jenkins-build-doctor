export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string;
  model: string;
}

/**
 * A pluggable LLM backend. Providers receive only the already-redacted prompt built by
 * `buildPrompt`; they never see raw logs.
 */
export interface LlmProvider {
  readonly id: string;
  readonly displayName: string;
  /** Where data is sent, shown in the consent dialog (e.g. a hostname). */
  readonly destination: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Extracts a readable error message from a provider error body without echoing huge payloads. */
export function errorMessageFromBody(body: string): string {
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const err = json.error;
    if (typeof err === 'object' && err !== null && typeof (err as Record<string, unknown>).message === 'string') {
      return (err as Record<string, string>).message;
    }
    if (typeof json.message === 'string') {
      return json.message;
    }
    if (typeof json.Message === 'string') {
      return json.Message;
    }
  } catch {
    // not JSON
  }
  return body.slice(0, 300);
}
