import * as vscode from 'vscode';

export const SECTION = 'jenkinsBuildDoctor';

export type AiProviderId = 'none' | 'vscodeLm' | 'bedrock' | 'openaiCompatible';
export type BedrockAuthMode = 'apiKey' | 'accessKeys' | 'environment';

export interface Settings {
  serverUrl: string;
  username: string;
  strictSSL: boolean;
  requestTimeoutMs: number;
  buildHistoryLimit: number;
  searchMaxDepth: number;
  searchMaxJobs: number;
  maxLogBytes: number;
  contextLines: number;
  customRules: unknown;
  redactConsoleOutput: boolean;
  additionalRedactionPatterns: string[];
  ai: {
    provider: AiProviderId;
    maxPromptChars: number;
    timeoutMs: number;
    bedrock: { region: string; modelId: string; authMode: BedrockAuthMode };
    openai: { baseUrl: string; model: string };
    vscodeLm: { vendor: string; family: string };
  };
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration(SECTION);
  const provider = c.get<string>('ai.provider', 'none');
  const authMode = c.get<string>('ai.bedrock.authMode', 'apiKey');
  return {
    serverUrl: c.get<string>('server.url', '').trim(),
    username: c.get<string>('server.username', '').trim(),
    strictSSL: c.get<boolean>('server.strictSSL', true),
    requestTimeoutMs: clamp(c.get<number>('server.requestTimeoutSeconds', 30), 5, 600) * 1000,
    buildHistoryLimit: clamp(c.get<number>('jobs.buildHistoryLimit', 25), 1, 200),
    searchMaxDepth: clamp(c.get<number>('jobs.searchMaxDepth', 6), 1, 20),
    searchMaxJobs: clamp(c.get<number>('jobs.searchMaxJobs', 5000), 100, 100_000),
    maxLogBytes: clamp(c.get<number>('analysis.maxLogSizeMB', 15), 1, 200) * 1024 * 1024,
    contextLines: clamp(c.get<number>('analysis.contextLines', 3), 0, 20),
    customRules: c.get<unknown>('analysis.customRules', []),
    redactConsoleOutput: c.get<boolean>('security.redactConsoleOutput', true),
    additionalRedactionPatterns: c.get<string[]>('security.additionalRedactionPatterns', []).filter((p) => typeof p === 'string'),
    ai: {
      provider: (['none', 'vscodeLm', 'bedrock', 'openaiCompatible'].includes(provider) ? provider : 'none') as AiProviderId,
      maxPromptChars: clamp(c.get<number>('ai.maxPromptChars', 24000), 2000, 400_000),
      timeoutMs: clamp(c.get<number>('ai.requestTimeoutSeconds', 120), 10, 900) * 1000,
      bedrock: {
        region: c.get<string>('ai.bedrock.region', 'us-east-1').trim(),
        modelId: c.get<string>('ai.bedrock.modelId', 'anthropic.claude-opus-5-5').trim(),
        authMode: (['apiKey', 'accessKeys', 'environment'].includes(authMode) ? authMode : 'apiKey') as BedrockAuthMode,
      },
      openai: {
        baseUrl: c.get<string>('ai.openaiCompatible.baseUrl', '').trim(),
        model: c.get<string>('ai.openaiCompatible.model', '').trim(),
      },
      vscodeLm: {
        vendor: c.get<string>('ai.vscodeLm.vendor', 'copilot').trim(),
        family: c.get<string>('ai.vscodeLm.family', '').trim(),
      },
    },
  };
}
