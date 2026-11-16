import { httpRequest, HttpError, type HttpTransport } from '../../core/http';
import { errorMessageFromBody, LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from './provider';

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  strictSSL?: boolean;
}

/** Any endpoint implementing the OpenAI `/chat/completions` contract (gateways, Ollama, vLLM, Azure OpenAI…). */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id = 'openaiCompatible';
  readonly displayName: string;
  readonly destination: string;
  private readonly endpoint: string;

  constructor(
    private readonly options: OpenAiCompatibleOptions,
    private readonly transport: HttpTransport = httpRequest,
  ) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new LlmError(`Invalid base URL "${options.baseUrl}".`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new LlmError('Base URL must use http or https.');
    }
    if (!options.model) {
      throw new LlmError('No model configured for the OpenAI-compatible provider.');
    }
    this.endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    this.destination = url.host;
    this.displayName = `${url.host} (${options.model})`;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.options.apiKey) {
      headers.authorization = `Bearer ${this.options.apiKey}`;
    }
    const body = JSON.stringify({
      model: this.options.model,
      max_tokens: req.maxTokens,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    });
    let res;
    try {
      res = await this.transport({
        url: this.endpoint,
        method: 'POST',
        headers,
        body,
        timeoutMs: this.options.timeoutMs,
        signal: req.signal,
        strictSSL: this.options.strictSSL,
        maxBytes: 5 * 1024 * 1024,
      });
    } catch (e) {
      throw new LlmError(e instanceof HttpError ? e.message : String(e));
    }
    const text = res.body.toString('utf8');
    if (res.status < 200 || res.status >= 300) {
      throw new LlmError(`Provider returned HTTP ${res.status}: ${errorMessageFromBody(text)}`, res.status);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new LlmError('Provider returned invalid JSON.');
    }
    const choice = (json as { choices?: { message?: { content?: unknown } }[] }).choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new LlmError('Unexpected response shape (no choices[0].message.content).');
    }
    const model = (json as { model?: unknown }).model;
    return { text: content, model: typeof model === 'string' ? model : this.options.model };
  }
}
