import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Logger } from '../core/logger';
import type { Redactor } from '../core/redact';
import type { AnalyzeResult } from '../analysis/engine';
import { CancelledError } from '../analysis/ruleEngine';
import type { Diagnosis } from '../analysis/types';
import { JenkinsError } from '../jenkins/client';
import { renderAiSection, renderDiagnosisHtml, renderErrorHtml, renderLoadingHtml, type AiViewState } from '../report/html';
import { diagnosisToMarkdown } from '../report/markdown';
import type { AiService } from './aiService';
import { LogDocumentProvider } from './logDocuments';

export interface DiagnosisSource {
  /** Identity of the panel; re-diagnosing the same build reuses the panel. */
  key: string;
  title: string;
  logUri: vscode.Uri;
  load(signal: AbortSignal, report: (message: string) => void): Promise<AnalyzeResult>;
}

export interface PanelDeps {
  logDocs: LogDocumentProvider;
  ai: AiService;
  logger: Logger;
  getRedactor: () => Redactor;
}

type InboundMessage = { type: 'openLine'; line: number } | { type: string };

const ALLOWED = new Set(['openLine', 'openConsole', 'openBuild', 'copyMarkdown', 'reanalyze', 'askAi', 'cancelAi', 'configureAi']);

export class DiagnosisPanel implements vscode.Disposable {
  private static readonly panels = new Map<string, DiagnosisPanel>();
  private result?: AnalyzeResult;
  private ai: AiViewState = { status: 'unavailable' };
  private aiAbort?: AbortController;
  private logRegistered = false;
  private running?: Promise<Diagnosis | undefined>;
  private readonly disposables: vscode.Disposable[] = [];

  /** Opens (or reveals) the panel for a build and runs the analysis. Resolves with the diagnosis (undefined if cancelled/failed). */
  static open(deps: PanelDeps, source: DiagnosisSource): Promise<Diagnosis | undefined> {
    const existing = DiagnosisPanel.panels.get(source.key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      existing.source = source;
      return existing.run();
    }
    const panel = vscode.window.createWebviewPanel('jenkinsBuildDoctor.diagnosis', source.title, vscode.ViewColumn.Active, {
      enableScripts: true,
      enableFindWidget: true,
      retainContextWhenHidden: false,
      localResourceRoots: [],
    });
    const instance = new DiagnosisPanel(panel, deps, source);
    DiagnosisPanel.panels.set(source.key, instance);
    return instance.run();
  }

  static disposeAll(): void {
    for (const p of [...DiagnosisPanel.panels.values()]) {
      p.panel.dispose();
    }
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: PanelDeps,
    private source: DiagnosisSource,
  ) {
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: unknown) => this.onMessage(m)),
      // Re-render when the panel becomes visible again (context is not retained while hidden).
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible && this.result) {
          this.render();
        }
      }),
    );
  }

  private nonce(): string {
    return randomBytes(16).toString('base64');
  }

  private run(): Promise<Diagnosis | undefined> {
    if (this.running) {
      return this.running;
    }
    this.running = this.doRun().finally(() => (this.running = undefined));
    return this.running;
  }

  private async doRun(): Promise<Diagnosis | undefined> {
    const webview = this.panel.webview;
    this.panel.title = this.source.title;
    webview.html = renderLoadingHtml(this.source.title, this.nonce(), webview.cspSource);
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Diagnosing ${this.source.title}`, cancellable: true },
        async (progress, token) => {
          const ctrl = new AbortController();
          const sub = token.onCancellationRequested(() => ctrl.abort());
          const disposeSub = this.panel.onDidDispose(() => ctrl.abort());
          try {
            return await this.source.load(ctrl.signal, (message) => {
              progress.report({ message });
              if (this.panel.visible) {
                webview.html = renderLoadingHtml(this.source.title, this.nonce(), webview.cspSource, message);
              }
            });
          } finally {
            sub.dispose();
            disposeSub.dispose();
          }
        },
      );
      this.setResult(result);
      return result.diagnosis;
    } catch (e) {
      if (isCancellation(e)) {
        this.deps.logger.info('Diagnosis cancelled', { key: this.source.key });
        if (!this.result) {
          this.safeSetHtml(renderErrorHtml(this.source.title, this.nonce(), webview.cspSource, 'Diagnosis cancelled.'));
        } else {
          this.render();
        }
        return undefined;
      }
      const message = e instanceof Error ? e.message : String(e);
      this.deps.logger.error('Diagnosis failed', e);
      this.safeSetHtml(renderErrorHtml(this.source.title, this.nonce(), webview.cspSource, message));
      void vscode.window.showErrorMessage(`Jenkins Build Doctor: ${message}`);
      return undefined;
    }
  }

  private setResult(result: AnalyzeResult): void {
    this.result = result;
    const text = result.log.lines.join('\n');
    if (this.logRegistered) {
      this.deps.logDocs.release(this.source.logUri);
    }
    this.deps.logDocs.register(this.source.logUri, text);
    this.logRegistered = true;
    const info = this.deps.ai.describe();
    this.ai = info.configured ? { status: 'idle', providerLabel: info.label } : { status: 'unavailable' };
    this.render();
  }

  private safeSetHtml(html: string): void {
    try {
      this.panel.webview.html = html;
    } catch {
      // panel disposed
    }
  }

  private render(): void {
    if (!this.result) {
      return;
    }
    this.safeSetHtml(
      renderDiagnosisHtml(this.result.diagnosis, {
        nonce: this.nonce(),
        cspSource: this.panel.webview.cspSource,
        ai: this.ai,
        hasLog: true,
      }),
    );
  }

  private updateAi(state: AiViewState): void {
    this.ai = state;
    void this.panel.webview.postMessage({ type: 'aiHtml', html: renderAiSection(state) });
  }

  private async onMessage(raw: unknown): Promise<void> {
    if (typeof raw !== 'object' || raw === null || typeof (raw as InboundMessage).type !== 'string' || !ALLOWED.has((raw as InboundMessage).type)) {
      this.deps.logger.warn('Ignoring unexpected webview message');
      return;
    }
    const msg = raw as InboundMessage;
    const d = this.result?.diagnosis;
    try {
      switch (msg.type) {
        case 'openLine': {
          const line = (msg as { line: unknown }).line;
          if (typeof line === 'number' && Number.isInteger(line) && line > 0) {
            await this.deps.logDocs.show(this.source.logUri, line);
          }
          break;
        }
        case 'openConsole':
          await this.deps.logDocs.show(this.source.logUri, d?.primary?.evidence[0]?.line);
          break;
        case 'openBuild':
          if (d?.build.webUrl) {
            await vscode.env.openExternal(vscode.Uri.parse(d.build.webUrl));
          }
          break;
        case 'copyMarkdown':
          if (d) {
            await vscode.env.clipboard.writeText(diagnosisToMarkdown(d, this.ai.status === 'done' ? this.ai.text : undefined));
            void vscode.window.showInformationMessage('Diagnosis copied to the clipboard as Markdown.');
          }
          break;
        case 'reanalyze':
          await this.run();
          break;
        case 'configureAi':
          await vscode.commands.executeCommand('jenkinsBuildDoctor.configureAi');
          {
            const info = this.deps.ai.describe();
            this.updateAi(info.configured ? { status: 'idle', providerLabel: info.label } : { status: 'unavailable' });
          }
          break;
        case 'cancelAi':
          this.aiAbort?.abort();
          break;
        case 'askAi':
          await this.askAi();
          break;
      }
    } catch (e) {
      this.deps.logger.error('Webview action failed', e);
      void vscode.window.showErrorMessage(`Jenkins Build Doctor: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async askAi(): Promise<void> {
    if (!this.result || this.ai.status === 'running') {
      return;
    }
    const label = this.deps.ai.describe().label;
    this.aiAbort = new AbortController();
    try {
      this.updateAi({ status: 'running', providerLabel: label });
      const res = await this.deps.ai.analyze(this.result.diagnosis, this.result.log, this.deps.getRedactor(), this.aiAbort.signal);
      if (!res) {
        this.updateAi({ status: 'idle', providerLabel: label });
        return;
      }
      this.updateAi({ status: 'done', providerLabel: label, text: res.text, model: res.model });
    } catch (e) {
      if (this.aiAbort.signal.aborted) {
        this.updateAi({ status: 'idle', providerLabel: label });
        return;
      }
      this.deps.logger.warn('AI analysis failed', { error: e });
      this.updateAi({ status: 'error', providerLabel: label, error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.aiAbort = undefined;
    }
  }

  dispose(): void {
    DiagnosisPanel.panels.delete(this.source.key);
    this.aiAbort?.abort();
    if (this.logRegistered) {
      this.deps.logDocs.release(this.source.logUri);
    }
    // Drop log data and the diagnosis as soon as the panel closes (minimise retention).
    this.result = undefined;
    this.disposables.forEach((d) => d.dispose());
  }
}

function isCancellation(e: unknown): boolean {
  return e instanceof CancelledError || (e instanceof JenkinsError && e.kind === 'cancelled');
}
