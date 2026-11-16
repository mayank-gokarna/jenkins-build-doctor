import * as vscode from 'vscode';
import type { Logger } from '../core/logger';
import type { Redactor } from '../core/redact';
import { BedrockProvider, type BedrockAuth } from '../analysis/llm/bedrock';
import { OpenAiCompatibleProvider } from '../analysis/llm/openaiCompatible';
import { buildPrompt } from '../analysis/llm/prompt';
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from '../analysis/llm/provider';
import type { ProcessedLog } from '../analysis/preprocess';
import type { Diagnosis } from '../analysis/types';
import { displayPath } from '../jenkins/paths';
import type { CredentialStore } from './credentials';
import { readSettings, SECTION } from './settings';

const CONSENT_PREFIX = 'aiConsent:';

/** VS Code Language Model API (e.g. GitHub Copilot) — no API key required. */
class VsCodeLmProvider implements LlmProvider {
  readonly id = 'vscodeLm';
  readonly displayName: string;
  readonly destination: string;

  constructor(private readonly model: vscode.LanguageModelChat) {
    this.displayName = `${model.name} (${model.vendor})`;
    this.destination = `${model.vendor} language model service`;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const cts = new vscode.CancellationTokenSource();
    req.signal?.addEventListener('abort', () => cts.cancel(), { once: true });
    try {
      // The LM API has no system role; prepend the instructions to the user message.
      const messages = [vscode.LanguageModelChatMessage.User(`${req.system}\n\n---\n\n${req.user}`)];
      const response = await this.model.sendRequest(messages, { justification: 'Diagnose a failed Jenkins build from redacted log excerpts.' }, cts.token);
      let text = '';
      for await (const chunk of response.text) {
        text += chunk;
      }
      if (!text.trim()) {
        throw new LlmError('The language model returned an empty response.');
      }
      return { text, model: this.model.name };
    } catch (e) {
      if (e instanceof vscode.LanguageModelError) {
        throw new LlmError(`${e.message} (${e.code})`);
      }
      throw e;
    } finally {
      cts.dispose();
    }
  }
}

export interface ProviderInfo {
  configured: boolean;
  label?: string;
}

export class AiService {
  constructor(
    private readonly credentials: CredentialStore,
    private readonly globalState: vscode.Memento,
    private readonly logger: Logger,
  ) {}

  /** Cheap check used to decide whether to show the "Ask AI" button. */
  describe(): ProviderInfo {
    const s = readSettings().ai;
    switch (s.provider) {
      case 'none':
        return { configured: false };
      case 'vscodeLm':
        return { configured: true, label: `VS Code language model${s.vscodeLm.vendor ? ` (${s.vscodeLm.vendor})` : ''}` };
      case 'bedrock':
        return { configured: !!s.bedrock.modelId, label: `Amazon Bedrock (${s.bedrock.modelId})` };
      case 'openaiCompatible':
        return { configured: !!s.openai.baseUrl && !!s.openai.model, label: `${safeHost(s.openai.baseUrl)} (${s.openai.model})` };
    }
  }

  async createProvider(): Promise<LlmProvider> {
    const s = readSettings();
    const ai = s.ai;
    switch (ai.provider) {
      case 'none':
        throw new LlmError('No AI provider configured.');
      case 'vscodeLm': {
        const selector: vscode.LanguageModelChatSelector = {};
        if (ai.vscodeLm.vendor) {
          selector.vendor = ai.vscodeLm.vendor;
        }
        if (ai.vscodeLm.family) {
          selector.family = ai.vscodeLm.family;
        }
        const models = await vscode.lm.selectChatModels(selector);
        if (models.length === 0) {
          throw new LlmError(
            `No VS Code language model matches vendor "${ai.vscodeLm.vendor || 'any'}"${ai.vscodeLm.family ? ` / family "${ai.vscodeLm.family}"` : ''}. ` +
              'Install and sign in to GitHub Copilot (or another LM provider extension), or adjust the jenkinsBuildDoctor.ai.vscodeLm settings.',
          );
        }
        return new VsCodeLmProvider(models[0]);
      }
      case 'bedrock': {
        let auth: BedrockAuth;
        if (ai.bedrock.authMode === 'apiKey') {
          const apiKey = await this.credentials.get('ai.bedrock.apiKey');
          if (!apiKey) {
            throw new LlmError('No Bedrock API key stored. Run "Jenkins: Configure AI Provider…".');
          }
          auth = { kind: 'apiKey', apiKey };
        } else if (ai.bedrock.authMode === 'accessKeys') {
          const accessKeyId = await this.credentials.get('ai.bedrock.accessKeyId');
          const secretAccessKey = await this.credentials.get('ai.bedrock.secretAccessKey');
          if (!accessKeyId || !secretAccessKey) {
            throw new LlmError('No AWS access keys stored. Run "Jenkins: Configure AI Provider…".');
          }
          auth = { kind: 'sigv4', credentials: { accessKeyId, secretAccessKey, sessionToken: (await this.credentials.get('ai.bedrock.sessionToken')) || undefined } };
        } else {
          const env = process.env;
          if (env.AWS_BEARER_TOKEN_BEDROCK) {
            auth = { kind: 'apiKey', apiKey: env.AWS_BEARER_TOKEN_BEDROCK };
          } else if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
            auth = { kind: 'sigv4', credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN } };
          } else {
            throw new LlmError('AWS credentials not found in the VS Code environment (AWS_BEARER_TOKEN_BEDROCK or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY).');
          }
        }
        return new BedrockProvider({ region: ai.bedrock.region, modelId: ai.bedrock.modelId, auth, timeoutMs: ai.timeoutMs });
      }
      case 'openaiCompatible': {
        if (!ai.openai.baseUrl || !ai.openai.model) {
          throw new LlmError('Set jenkinsBuildDoctor.ai.openaiCompatible.baseUrl and .model first.');
        }
        const apiKey = (await this.credentials.get('ai.openaiCompatible.apiKey')) || undefined;
        return new OpenAiCompatibleProvider({ baseUrl: ai.openai.baseUrl, model: ai.openai.model, apiKey, timeoutMs: ai.timeoutMs });
      }
    }
  }

  /**
   * Builds the redacted prompt, obtains explicit consent (with a preview option) and calls the provider.
   * Returns undefined when the user declines.
   */
  async analyze(diagnosis: Diagnosis, log: ProcessedLog, redactor: Redactor, signal: AbortSignal): Promise<LlmResponse | undefined> {
    const settings = readSettings();
    const provider = await this.createProvider();
    const prompt = buildPrompt(diagnosis, log, redactor, settings.ai.maxPromptChars);
    const consentKey = `${CONSENT_PREFIX}${settings.ai.provider}|${provider.destination}`;

    if (!this.globalState.get<boolean>(consentKey)) {
      for (;;) {
        const choice = await vscode.window.showWarningMessage(
          `Send build data to ${provider.displayName}?`,
          {
            modal: true,
            detail:
              `About ${prompt.size.toLocaleString()} characters from ${displayPath(diagnosis.job.path)} #${diagnosis.build.number} ` +
              `(rule findings, failing tests and log excerpts, with detected secrets replaced by ******) will be sent to ${provider.destination}. ` +
              'Automatic redaction cannot catch every secret or proprietary detail. Only continue if your organisation allows this.',
          },
          'Send Once',
          'Always Allow for This Provider',
          'Preview Data',
        );
        if (choice === 'Preview Data') {
          const doc = await vscode.workspace.openTextDocument({ content: `${prompt.system}\n\n=====\n\n${prompt.user}`, language: 'markdown' });
          await vscode.window.showTextDocument(doc, { preview: true });
          continue;
        }
        if (choice === 'Always Allow for This Provider') {
          await this.globalState.update(consentKey, true);
          break;
        }
        if (choice === 'Send Once') {
          break;
        }
        this.logger.info('AI analysis declined by user');
        return undefined;
      }
    }

    this.logger.info('Sending AI analysis request', { provider: provider.id, destination: provider.destination, chars: prompt.size });
    const started = Date.now();
    const res = await provider.complete({ system: prompt.system, user: prompt.user, maxTokens: 4000, signal });
    this.logger.info('AI analysis completed', { provider: provider.id, model: res.model, ms: Date.now() - started, chars: res.text.length });
    return { ...res, text: redactor.redactString(res.text) };
  }

  async resetConsent(): Promise<number> {
    const keys = this.globalState.keys().filter((k) => k.startsWith(CONSENT_PREFIX));
    for (const k of keys) {
      await this.globalState.update(k, undefined);
    }
    return keys.length;
  }

  /** Interactive setup for the AI provider and its secrets. */
  async configure(): Promise<void> {
    const config = vscode.workspace.getConfiguration(SECTION);
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Rule-based only', description: 'No AI. Nothing is sent anywhere.', id: 'none' },
        { label: 'VS Code language model', description: 'GitHub Copilot or another installed LM provider. No API key needed.', id: 'vscodeLm' },
        { label: 'Amazon Bedrock', description: 'Converse API with an API key or AWS access keys.', id: 'bedrock' },
        { label: 'OpenAI-compatible endpoint', description: 'Internal gateway, Azure OpenAI, Ollama, vLLM, LiteLLM…', id: 'openaiCompatible' },
      ],
      { title: 'Jenkins Build Doctor: AI provider', placeHolder: 'Rule-based analysis always runs locally; AI is optional.' },
    );
    if (!pick) {
      return;
    }
    const target = vscode.ConfigurationTarget.Global;
    await config.update('ai.provider', pick.id, target);

    if (pick.id === 'bedrock') {
      const region = await vscode.window.showInputBox({ title: 'AWS region', value: config.get('ai.bedrock.region', 'us-east-1'), ignoreFocusOut: true });
      if (region === undefined) {
        return;
      }
      const modelId = await vscode.window.showInputBox({
        title: 'Bedrock model ID or inference profile',
        value: config.get('ai.bedrock.modelId', 'anthropic.claude-opus-5-5'),
        ignoreFocusOut: true,
      });
      if (modelId === undefined) {
        return;
      }
      await config.update('ai.bedrock.region', region.trim(), target);
      await config.update('ai.bedrock.modelId', modelId.trim(), target);
      const mode = await vscode.window.showQuickPick(
        [
          { label: 'Bedrock API key', id: 'apiKey' },
          { label: 'AWS access key ID + secret', id: 'accessKeys' },
          { label: 'Environment variables of the VS Code process', id: 'environment' },
        ],
        { title: 'Bedrock authentication' },
      );
      if (!mode) {
        return;
      }
      await config.update('ai.bedrock.authMode', mode.id, target);
      if (mode.id === 'apiKey') {
        const key = await secretInput('Bedrock API key');
        if (key) {
          await this.credentials.set('ai.bedrock.apiKey', key);
        }
      } else if (mode.id === 'accessKeys') {
        const id = await secretInput('AWS access key ID');
        const secret = id ? await secretInput('AWS secret access key') : undefined;
        if (id && secret) {
          await this.credentials.set('ai.bedrock.accessKeyId', id);
          await this.credentials.set('ai.bedrock.secretAccessKey', secret);
          const session = await secretInput('AWS session token (optional, leave empty if none)', true);
          if (session) {
            await this.credentials.set('ai.bedrock.sessionToken', session);
          } else {
            await this.credentials.delete('ai.bedrock.sessionToken');
          }
        }
      }
    } else if (pick.id === 'openaiCompatible') {
      const baseUrl = await vscode.window.showInputBox({
        title: 'Base URL (…/v1)',
        value: config.get('ai.openaiCompatible.baseUrl', ''),
        placeHolder: 'http://localhost:11434/v1',
        ignoreFocusOut: true,
        validateInput: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? undefined : 'Enter an http(s) URL'),
      });
      if (baseUrl === undefined) {
        return;
      }
      const model = await vscode.window.showInputBox({ title: 'Model name', value: config.get('ai.openaiCompatible.model', ''), ignoreFocusOut: true });
      if (model === undefined) {
        return;
      }
      await config.update('ai.openaiCompatible.baseUrl', baseUrl.trim(), target);
      await config.update('ai.openaiCompatible.model', model.trim(), target);
      const key = await secretInput('API key (leave empty if the endpoint needs none)', true);
      if (key) {
        await this.credentials.set('ai.openaiCompatible.apiKey', key);
      } else {
        await this.credentials.delete('ai.openaiCompatible.apiKey');
      }
    }
    void vscode.window.showInformationMessage(
      pick.id === 'none' ? 'AI analysis disabled. Rule-based diagnosis remains available.' : `AI provider set to ${pick.label}. You will be asked for consent before any data is sent.`,
    );
  }
}

function secretInput(title: string, optional = false): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title,
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (optional || v.trim() ? undefined : 'Required'),
  }).then((v) => v?.trim());
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
