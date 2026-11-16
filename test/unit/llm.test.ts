import * as assert from 'node:assert/strict';
import { analyzeBuild } from '../../src/analysis/engine';
import { BedrockProvider, extractConverseText } from '../../src/analysis/llm/bedrock';
import { OpenAiCompatibleProvider } from '../../src/analysis/llm/openaiCompatible';
import { buildPrompt, mergeRanges } from '../../src/analysis/llm/prompt';
import { signRequest } from '../../src/analysis/llm/sigv4';
import type { HttpRequest, HttpResponse } from '../../src/core/http';
import { Redactor } from '../../src/core/redact';
import { MAVEN_COMPILE_FAILURE, WITH_SECRETS } from '../fixtures/logs';

const fakeResponse = (status: number, body: unknown): HttpResponse => ({
  status,
  headers: {},
  body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  truncated: false,
  totalBytes: 0,
  url: '',
});

describe('SigV4', () => {
  it('matches the AWS "get-vanilla" test vector', () => {
    const headers = signRequest({
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      headers: {},
      body: '',
      region: 'us-east-1',
      service: 'service',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      date: new Date('2015-08-30T12:36:00Z'),
    });
    assert.equal(
      headers.Authorization,
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    assert.equal(headers['x-amz-date'], '20150830T123600Z');
  });
});

describe('LLM providers', () => {
  it('Bedrock: sends a Converse request with bearer auth and parses the reply', async () => {
    let seen: HttpRequest | undefined;
    const p = new BedrockProvider(
      { region: 'us-east-1', modelId: 'anthropic.claude-opus-5-5', auth: { kind: 'apiKey', apiKey: 'k' }, timeoutMs: 1000 },
      async (req) => {
        seen = req;
        return fakeResponse(200, { output: { message: { role: 'assistant', content: [{ text: '## Root cause\nX' }] } } });
      },
    );
    const res = await p.complete({ system: 'sys', user: 'hello', maxTokens: 100 });
    assert.equal(res.text, '## Root cause\nX');
    assert.equal(seen!.url, 'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-opus-5-5/converse');
    assert.equal(seen!.headers!.authorization, 'Bearer k');
    const body = JSON.parse(String(seen!.body));
    assert.deepEqual(body.system, [{ text: 'sys' }]);
    assert.equal(body.messages[0].content[0].text, 'hello');
  });

  it('Bedrock: signs with SigV4 when using access keys and surfaces API errors', async () => {
    let seen: HttpRequest | undefined;
    const p = new BedrockProvider(
      { region: 'eu-west-1', modelId: 'm', auth: { kind: 'sigv4', credentials: { accessKeyId: 'AKID', secretAccessKey: 's', sessionToken: 'tok' } }, timeoutMs: 1000 },
      async (req) => {
        seen = req;
        return fakeResponse(403, { message: 'not authorized' });
      },
    );
    await assert.rejects(p.complete({ system: 's', user: 'u', maxTokens: 1 }), /HTTP 403: not authorized/);
    assert.match(seen!.headers!.Authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/eu-west-1\/bedrock\/aws4_request/);
    assert.equal(seen!.headers!['x-amz-security-token'], 'tok');
    assert.throws(() => new BedrockProvider({ region: 'nope', modelId: 'm', auth: { kind: 'apiKey', apiKey: 'k' }, timeoutMs: 1 }));
    assert.throws(() => extractConverseText('{"output":{}}'), /Unexpected/);
  });

  it('OpenAI-compatible: posts chat completions', async () => {
    let seen: HttpRequest | undefined;
    const p = new OpenAiCompatibleProvider({ baseUrl: 'http://localhost:11434/v1/', model: 'llama', timeoutMs: 1000 }, async (req) => {
      seen = req;
      return fakeResponse(200, { model: 'llama:8b', choices: [{ message: { content: 'answer' } }] });
    });
    const res = await p.complete({ system: 's', user: 'u', maxTokens: 10 });
    assert.deepEqual(res, { text: 'answer', model: 'llama:8b' });
    assert.equal(seen!.url, 'http://localhost:11434/v1/chat/completions');
    assert.equal(seen!.headers!.authorization, undefined);
    assert.equal(p.destination, 'localhost:11434');
  });
});

describe('prompt builder', () => {
  it('is bounded, redacted and cites line numbers', async () => {
    const redactor = new Redactor();
    const text = `${WITH_SECRETS}\n${MAVEN_COMPILE_FAILURE}`;
    const { diagnosis, log } = await analyzeBuild(
      {
        jobPath: ['team', 'backend'],
        jobDisplayName: 'backend',
        jobKind: 'pipeline',
        build: { number: 42, status: 'failure', building: false, causes: [], parameters: [], scm: { remoteUrls: [] }, changes: [] },
        log: { text, truncated: false, totalBytes: text.length },
      },
      // Simulate a user who disabled display redaction: the prompt must still be redacted.
      { redactor, redactLog: false, contextLines: 2 },
    );
    const prompt = buildPrompt(diagnosis, log, redactor, 4000);
    assert.ok(prompt.user.length <= 4100);
    for (const s of ['hunter2secret', 'SuperSecret123', 'AKIAIOSFODNN7EXAMPLE']) {
      assert.ok(!prompt.user.includes(s), `leaked ${s}`);
    }
    assert.match(prompt.user, /L\d+: .*cannot find symbol/);
    assert.match(prompt.system, /CONFIRMED.*HYPOTHESIS/s);
  });

  it('merges overlapping ranges', () => {
    assert.deepEqual(
      mergeRanges([
        [10, 20],
        [1, 5],
        [18, 30],
        [6, 7],
      ]),
      [
        [1, 7],
        [10, 30],
      ],
    );
  });
});
