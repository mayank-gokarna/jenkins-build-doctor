import { httpRequest, HttpError, type HttpTransport } from '../../core/http';
import { errorMessageFromBody, LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from './provider';
import { signRequest, type AwsCredentials } from './sigv4';

export type BedrockAuth = { kind: 'apiKey'; apiKey: string } | { kind: 'sigv4'; credentials: AwsCredentials };

export interface BedrockOptions {
  region: string;
  modelId: string;
  auth: BedrockAuth;
  timeoutMs: number;
}

/** Amazon Bedrock via the model-agnostic Converse API. */
export class BedrockProvider implements LlmProvider {
  readonly id = 'bedrock';
  readonly displayName: string;
  readonly destination: string;

  constructor(
    private readonly options: BedrockOptions,
    private readonly transport: HttpTransport = httpRequest,
  ) {
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(options.region)) {
      throw new LlmError(`Invalid AWS region "${options.region}".`);
    }
    if (!options.modelId) {
      throw new LlmError('No Bedrock model ID configured.');
    }
    this.destination = `bedrock-runtime.${options.region}.amazonaws.com`;
    this.displayName = `Amazon Bedrock (${options.modelId})`;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const url = `https://${this.destination}/model/${encodeURIComponent(this.options.modelId)}/converse`;
    const body = JSON.stringify({
      system: [{ text: req.system }],
      messages: [{ role: 'user', content: [{ text: req.user }] }],
      inferenceConfig: { maxTokens: req.maxTokens },
    });
    let headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.options.auth.kind === 'apiKey') {
      headers.authorization = `Bearer ${this.options.auth.apiKey}`;
    } else {
      headers = signRequest({
        method: 'POST',
        url,
        headers,
        body,
        region: this.options.region,
        service: 'bedrock',
        credentials: this.options.auth.credentials,
      });
    }
    let res;
    try {
      res = await this.transport({ url, method: 'POST', headers, body, timeoutMs: this.options.timeoutMs, signal: req.signal, maxBytes: 5 * 1024 * 1024 });
    } catch (e) {
      throw new LlmError(e instanceof HttpError ? e.message : String(e));
    }
    const text = res.body.toString('utf8');
    if (res.status < 200 || res.status >= 300) {
      throw new LlmError(`Bedrock returned HTTP ${res.status}: ${errorMessageFromBody(text)}`, res.status);
    }
    return { text: extractConverseText(text), model: this.options.modelId };
  }
}

export function extractConverseText(body: string): string {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new LlmError('Bedrock returned invalid JSON.');
  }
  const content = (json as { output?: { message?: { content?: unknown } } })?.output?.message?.content;
  if (!Array.isArray(content)) {
    throw new LlmError('Unexpected Bedrock response shape (no output.message.content).');
  }
  const text = content
    .map((c) => (typeof c === 'object' && c !== null && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
    .join('');
  if (!text.trim()) {
    throw new LlmError('Bedrock returned an empty response.');
  }
  return text;
}
