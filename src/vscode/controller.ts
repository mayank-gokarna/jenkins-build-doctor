import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from '../core/logger';
import { Redactor } from '../core/redact';
import { analyzeBuild, type AnalyzeResult } from '../analysis/engine';
import { cleanLines } from '../analysis/preprocess';
import { compileCustomRules } from '../analysis/rules';
import type { Diagnosis } from '../analysis/types';
import { JenkinsClient, JenkinsError } from '../jenkins/client';
import { displayPath, isInsecureRemote, normalizeBaseUrl } from '../jenkins/paths';
import type { BuildContext, BuildSummary, JobSummary } from '../jenkins/types';
import { AiService } from './aiService';
import { CredentialStore } from './credentials';
import { DiagnosisPanel, type PanelDeps } from './diagnosisPanel';
import { JobIndex, JobTreeProvider, STATUS_TEXT, timeAgo, type TreeNode } from './jobTree';
import { LogDocumentProvider, LOG_SCHEME } from './logDocuments';
import { readSettings, SECTION, type Settings } from './settings';

export interface TestApi {
  setToken(token: string): Promise<void>;
  getChildren(node?: TreeNode): Promise<TreeNode[]>;
  diagnose(jobPath: string[], buildNumber: number): Promise<Diagnosis | undefined>;
  analyzeText(text: string): Promise<Diagnosis | undefined>;
}

type JobRef = Pick<JobSummary, 'path' | 'displayName' | 'kind'>;

export class Controller implements vscode.Disposable {
  private client?: JenkinsClient;
  private token?: string;
  private redactor = new Redactor();
  private readonly credentials: CredentialStore;
  private readonly tree: JobTreeProvider;
  private readonly index: JobIndex;
  private readonly logDocs = new LogDocumentProvider();
  private readonly ai: AiService;
  private readonly disposables: vscode.Disposable[] = [];
  private settings: Settings = readSettings();
  private ready: Promise<void>;

  constructor(
    context: vscode.ExtensionContext,
    private readonly logger: Logger,
    private readonly showLogs: () => void,
    private readonly onSecretsChanged: (secrets: string[]) => void,
  ) {
    this.credentials = new CredentialStore(context.secrets);
    this.ai = new AiService(this.credentials, context.globalState, logger.child('ai'));
    this.tree = new JobTreeProvider(() => this.client, () => this.settings.buildHistoryLimit, logger.child('tree'));
    this.index = new JobIndex(() => this.client, () => ({ maxDepth: this.settings.searchMaxDepth, maxJobs: this.settings.searchMaxJobs }));

    const view = vscode.window.createTreeView('jenkinsBuildDoctor.jobs', { treeDataProvider: this.tree, showCollapseAll: true });
    this.disposables.push(
      view,
      this.logDocs,
      vscode.workspace.registerTextDocumentContentProvider(LOG_SCHEME, this.logDocs),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SECTION)) {
          this.settings = readSettings();
          if (e.affectsConfiguration(`${SECTION}.server`) || e.affectsConfiguration(`${SECTION}.security`)) {
            void this.reloadClient();
          }
        }
      }),
      this.credentials.onDidChange(() => void this.reloadClient()),
    );
    this.registerCommands();
    this.ready = this.reloadClient();
  }

  /** (Re)creates the Jenkins client from settings + SecretStorage. */
  private async reloadClient(): Promise<void> {
    this.settings = readSettings();
    const { serverUrl, username } = this.settings;
    let client: JenkinsClient | undefined;
    let token: string | undefined;
    if (serverUrl && username) {
      try {
        const base = normalizeBaseUrl(serverUrl);
        token = await this.credentials.getJenkinsToken(base, username);
        if (token) {
          client = new JenkinsClient(
            { baseUrl: base, username, token, strictSSL: this.settings.strictSSL, timeoutMs: this.settings.requestTimeoutMs },
            this.logger.child('jenkins'),
          );
        }
      } catch (e) {
        this.logger.warn('Invalid Jenkins configuration', { error: e });
      }
    }
    this.client = client;
    this.token = token;
    this.redactor = new Redactor({ knownSecrets: token ? [token] : [], extraPatterns: this.settings.additionalRedactionPatterns });
    if (this.redactor.invalidPatterns.length > 0) {
      void vscode.window.showWarningMessage(`Jenkins Build Doctor: ignoring invalid redaction pattern(s): ${this.redactor.invalidPatterns.join(', ')}`);
    }
    this.onSecretsChanged(token ? [token] : []);
    await vscode.commands.executeCommand('setContext', 'jenkinsBuildDoctor.connected', !!client);
    this.index.invalidate();
    this.tree.refresh();
    this.logger.info('Jenkins client configured', { connected: !!client, server: client?.baseUrl });
  }

  private register(id: string, fn: (...args: never[]) => unknown): void {
    this.disposables.push(
      vscode.commands.registerCommand(id, async (...args: never[]) => {
        try {
          return await fn(...args);
        } catch (e) {
          if (e instanceof JenkinsError && e.kind === 'cancelled') {
            return undefined;
          }
          this.logger.error(`Command ${id} failed`, e);
          const choice = await vscode.window.showErrorMessage(`Jenkins Build Doctor: ${e instanceof Error ? e.message : String(e)}`, 'Show Logs');
          if (choice === 'Show Logs') {
            this.showLogs();
          }
          return undefined;
        }
      }),
    );
  }

  private registerCommands(): void {
    const c = 'jenkinsBuildDoctor.';
    this.register(`${c}configure`, () => this.configure());
    this.register(`${c}testConnection`, () => this.testConnection(true));
    this.register(`${c}signOut`, () => this.signOut());
    this.register(`${c}refresh`, (node?: TreeNode) => {
      if (!node) {
        this.index.invalidate();
      }
      this.tree.refresh(node);
    });
    this.register(`${c}filterJobs`, () => this.filterJobs());
    this.register(`${c}clearFilter`, () => {
      this.tree.clearFilter();
      return vscode.commands.executeCommand('setContext', 'jenkinsBuildDoctor.filtered', false);
    });
    this.register(`${c}searchJobs`, async () => {
      const job = await this.pickJob();
      return job ? this.selectBuild(job) : undefined;
    });
    this.register(`${c}diagnoseBuild`, (node?: TreeNode) => this.diagnoseCommand(node));
    this.register(`${c}diagnoseLastFailed`, (node?: TreeNode) => this.diagnoseLastFailed(node));
    this.register(`${c}selectBuild`, (node?: TreeNode) => (node && node.type === 'job' ? this.selectBuild(node.job) : this.diagnoseCommand()));
    this.register(`${c}openConsole`, (node?: TreeNode) => (node?.type === 'build' ? this.openConsole(node.job, node.build.number) : undefined));
    this.register(`${c}openInBrowser`, (node?: TreeNode) => {
      const url = this.urlFor(node);
      return url ? vscode.env.openExternal(vscode.Uri.parse(url)) : undefined;
    });
    this.register(`${c}copyUrl`, async (node?: TreeNode) => {
      const url = this.urlFor(node);
      if (url) {
        await vscode.env.clipboard.writeText(url);
        void vscode.window.setStatusBarMessage('Jenkins URL copied', 2000);
      }
    });
    this.register(`${c}analyzeActiveEditor`, () => this.analyzeActiveEditor());
    this.register(`${c}configureAi`, () => this.ai.configure());
    this.register(`${c}resetAiConsent`, async () => {
      const n = await this.ai.resetConsent();
      void vscode.window.showInformationMessage(n ? 'AI data-sharing consent revoked. You will be asked again before data is sent.' : 'No stored AI consent to revoke.');
    });
    this.register(`${c}showLogs`, () => this.showLogs());
  }

  // ───────────── Connection ─────────────

  private async configure(): Promise<void> {
    const current = this.settings;
    const url = await vscode.window.showInputBox({
      title: 'Jenkins server URL (1/3)',
      value: current.serverUrl || 'https://',
      placeHolder: 'https://jenkins.example.com/',
      ignoreFocusOut: true,
      validateInput: (v) => {
        try {
          normalizeBaseUrl(v);
          return undefined;
        } catch (e) {
          return e instanceof Error ? e.message : 'Invalid URL';
        }
      },
    });
    if (url === undefined) {
      return;
    }
    const base = normalizeBaseUrl(url);
    if (isInsecureRemote(base)) {
      const ok = await vscode.window.showWarningMessage(
        'This URL uses plain http://. Your API token would be sent unencrypted over the network.',
        { modal: true },
        'Continue Anyway',
      );
      if (ok !== 'Continue Anyway') {
        return;
      }
    }
    const username = await vscode.window.showInputBox({
      title: 'Jenkins username (2/3)',
      value: current.username,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Username is required'),
    });
    if (username === undefined) {
      return;
    }
    const token = await vscode.window.showInputBox({
      title: 'Jenkins API token (3/3)',
      prompt: 'Create one in Jenkins under your user → Security → API Token. It is stored in VS Code SecretStorage.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'API token is required'),
    });
    if (token === undefined) {
      return;
    }

    let strictSSL = current.strictSSL;
    for (;;) {
      const client = new JenkinsClient(
        { baseUrl: base, username: username.trim(), token: token.trim(), strictSSL, timeoutMs: current.requestTimeoutMs },
        this.logger.child('jenkins'),
      );
      try {
        const info = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Connecting to Jenkins…', cancellable: true },
          (_p, tokenCt) => {
            const ctrl = new AbortController();
            tokenCt.onCancellationRequested(() => ctrl.abort());
            return client.validate(ctrl.signal);
          },
        );
        if (info.anonymous) {
          const proceed = await vscode.window.showWarningMessage(
            'Connected, but Jenkins treated the request as anonymous. The username/token may be wrong, or the server allows anonymous read.',
            'Save Anyway',
            'Cancel',
          );
          if (proceed !== 'Save Anyway') {
            return;
          }
        }
        const config = vscode.workspace.getConfiguration(SECTION);
        await this.credentials.setJenkinsToken(base, username.trim(), token.trim());
        await config.update('server.url', base, vscode.ConfigurationTarget.Global);
        await config.update('server.username', username.trim(), vscode.ConfigurationTarget.Global);
        if (strictSSL !== current.strictSSL) {
          await config.update('server.strictSSL', strictSSL, vscode.ConfigurationTarget.Global);
        }
        await this.reloadClient();
        void vscode.window.showInformationMessage(
          `Connected to Jenkins${info.version ? ` ${info.version}` : ''} as ${info.user ?? username}. ${info.rootJobCount} top-level item(s).`,
        );
        return;
      } catch (e) {
        if (e instanceof JenkinsError && e.kind === 'cancelled') {
          return;
        }
        if (e instanceof JenkinsError && e.kind === 'tls' && strictSSL) {
          const choice = await vscode.window.showErrorMessage(
            `${e.message}`,
            { modal: true, detail: 'Disabling verification exposes the connection to interception. Prefer installing the CA certificate.' },
            'Disable Verification for This Server',
          );
          if (choice) {
            strictSSL = false;
            continue;
          }
          return;
        }
        const retry = await vscode.window.showErrorMessage(`Could not connect: ${e instanceof Error ? e.message : String(e)}`, 'Try Again');
        if (retry) {
          return this.configure();
        }
        return;
      }
    }
  }

  private async testConnection(notify: boolean): Promise<boolean> {
    const client = this.requireClient();
    const info = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Testing Jenkins connection…' }, () => client.validate());
    if (notify) {
      void vscode.window.showInformationMessage(
        `Jenkins${info.version ? ` ${info.version}` : ''} reachable at ${client.baseUrl} as ${info.anonymous ? 'anonymous (check credentials!)' : info.user}.`,
      );
    }
    return true;
  }

  private async signOut(): Promise<void> {
    const { serverUrl, username } = this.settings;
    if (!serverUrl || !username) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(`Remove the stored API token for ${username} on ${serverUrl}?`, { modal: true }, 'Remove');
    if (ok) {
      await this.credentials.deleteJenkinsToken(normalizeBaseUrl(serverUrl), username);
      await this.reloadClient();
    }
  }

  private requireClient(): JenkinsClient {
    if (!this.client) {
      void vscode.window.showWarningMessage('Jenkins is not configured.', 'Configure').then((c) => {
        if (c) {
          void vscode.commands.executeCommand('jenkinsBuildDoctor.configure');
        }
      });
      throw new JenkinsError('Cancelled', 'cancelled');
    }
    return this.client;
  }

  // ───────────── Discovery ─────────────

  private async filterJobs(): Promise<void> {
    this.requireClient();
    const text = await vscode.window.showInputBox({ title: 'Filter Jenkins jobs', prompt: 'Matches job names and folder paths (case-insensitive).', value: this.tree.filterText ?? '' });
    if (!text?.trim()) {
      return;
    }
    const index = await this.index.get();
    this.tree.setFilter(text.trim(), index);
    await vscode.commands.executeCommand('setContext', 'jenkinsBuildDoctor.filtered', true);
  }

  private async pickJob(): Promise<JobSummary | undefined> {
    this.requireClient();
    const index = await this.index.get();
    const items = index.jobs
      .filter((j) => !j.isContainer)
      .map((job) => ({
        label: `$(${job.status === 'failure' ? 'error' : job.status === 'success' ? 'pass' : job.status === 'unstable' ? 'warning' : 'circle-outline'}) ${job.displayName}`,
        description: displayPath(job.path.slice(0, -1)),
        detail: job.lastBuild ? `#${job.lastBuild.number} · ${STATUS_TEXT[job.lastBuild.status]} · ${timeAgo(job.lastBuild.timestamp)}` : 'no builds',
        job,
      }));
    const pick = await vscode.window.showQuickPick(items, {
      title: `Select a Jenkins job (${items.length}${index.complete ? '' : '+, index incomplete'})`,
      matchOnDescription: true,
      placeHolder: 'Type to search by name or folder',
    });
    return pick?.job;
  }

  private async selectBuild(job: JobRef): Promise<Diagnosis | undefined> {
    const client = this.requireClient();
    const details = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Loading build history…' }, () =>
      client.getJob(job.path, this.settings.buildHistoryLimit),
    );
    type Item = vscode.QuickPickItem & { build?: BuildSummary; manual?: boolean };
    const icon = (b: BuildSummary) =>
      b.status === 'failure' ? '$(error)' : b.status === 'success' ? '$(pass)' : b.status === 'unstable' ? '$(warning)' : b.status === 'building' ? '$(sync~spin)' : '$(circle-slash)';
    const items: Item[] = details.builds.map((b) => ({
      label: `${icon(b)} #${b.number}`,
      description: `${STATUS_TEXT[b.status]} · ${timeAgo(b.timestamp)}`,
      detail: b.timestamp ? new Date(b.timestamp).toLocaleString() : undefined,
      build: b,
    }));
    items.push({ label: '$(edit) Enter a build number…', manual: true });
    const lastFailed = details.lastFailedBuild;
    const pick = await vscode.window.showQuickPick(items, {
      title: `${displayPath(job.path)} — select a build to diagnose${lastFailed ? ` (last failed: #${lastFailed})` : ''}`,
      matchOnDescription: true,
    });
    if (!pick) {
      return undefined;
    }
    let number = pick.build?.number;
    if (pick.manual) {
      const input = await vscode.window.showInputBox({
        title: 'Build number',
        validateInput: (v) => (/^\d+$/.test(v.trim()) ? undefined : 'Enter a positive integer'),
      });
      if (!input) {
        return undefined;
      }
      number = Number(input.trim());
    }
    return number === undefined ? undefined : this.diagnose(details.job, number);
  }

  private async diagnoseCommand(node?: TreeNode): Promise<Diagnosis | undefined> {
    if (node?.type === 'build') {
      return this.diagnose(node.job, node.build.number);
    }
    if (node?.type === 'job') {
      return this.selectBuild(node.job);
    }
    const job = await this.pickJob();
    return job ? this.selectBuild(job) : undefined;
  }

  private async diagnoseLastFailed(node?: TreeNode): Promise<Diagnosis | undefined> {
    const job = node?.type === 'job' ? node.job : await this.pickJob();
    if (!job) {
      return undefined;
    }
    const client = this.requireClient();
    const details = await client.getJob(job.path, 1);
    const n = details.lastFailedBuild ?? details.lastUnsuccessfulBuild;
    if (n === undefined) {
      void vscode.window.showInformationMessage(`${displayPath(job.path)} has no failed builds.`);
      return undefined;
    }
    return this.diagnose(details.job, n);
  }

  // ───────────── Diagnosis ─────────────

  diagnose(job: JobRef, buildNumber: number): Promise<Diagnosis | undefined> {
    const client = this.requireClient();
    const title = `${displayPath(job.path)} #${buildNumber}`;
    return DiagnosisPanel.open(this.panelDeps(), {
      key: `${client.baseUrl}|${job.path.join('/')}#${buildNumber}`,
      title,
      logUri: LogDocumentProvider.uriFor(job.path, buildNumber),
      load: async (signal, report) => {
        const settings = this.settings;
        report('Fetching build metadata…');
        const build = await client.getBuild(job.path, buildNumber, signal);
        report('Downloading console log, test report and stages…');
        const [log, testReport, stages] = await Promise.all([
          client.getConsoleLog(job.path, buildNumber, settings.maxLogBytes, signal),
          client.getTestReport(job.path, buildNumber, signal).catch((e: unknown) => this.optional('test report', e)),
          job.kind === 'pipeline' || job.kind === 'unknown'
            ? client.getStages(job.path, buildNumber, signal).catch((e: unknown) => this.optional('stages', e))
            : Promise.resolve(undefined),
        ]);
        report('Analysing…');
        const ctx: BuildContext = {
          jobPath: job.path,
          jobDisplayName: job.displayName,
          jobKind: job.kind,
          build,
          log,
          testReport,
          stages,
          webUrl: client.buildWebUrl(job.path, buildNumber),
        };
        const result = await this.runAnalysis(ctx, signal);
        this.logger.info('Diagnosis complete', {
          job: job.path.join('/'),
          build: buildNumber,
          primary: result.diagnosis.primary?.ruleId,
          findings: result.diagnosis.findings.length,
          ms: result.diagnosis.stats.analysisMs,
        });
        return result;
      },
    });
  }

  private optional(what: string, e: unknown): undefined {
    if (e instanceof JenkinsError && e.kind === 'cancelled') {
      throw e;
    }
    this.logger.warn(`Could not load ${what}; continuing without it`, { error: e });
    return undefined;
  }

  private runAnalysis(ctx: BuildContext, signal?: AbortSignal): Promise<AnalyzeResult> {
    const custom = compileCustomRules(this.settings.customRules);
    return analyzeBuild(ctx, {
      redactor: this.redactor,
      redactLog: this.settings.redactConsoleOutput,
      contextLines: this.settings.contextLines,
      customRules: custom.rules,
      notes: custom.errors,
      signal,
    });
  }

  private panelDeps(): PanelDeps {
    return { logDocs: this.logDocs, ai: this.ai, logger: this.logger.child('panel'), getRedactor: () => this.redactor };
  }

  private async analyzeActiveEditor(text?: string): Promise<Diagnosis | undefined> {
    const editor = vscode.window.activeTextEditor;
    let name = 'Console log';
    if (text === undefined) {
      if (!editor) {
        void vscode.window.showInformationMessage('Open a Jenkins console log in an editor first (or select part of it).');
        return undefined;
      }
      text = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
      name = path.basename(editor.document.uri.path) || name;
    }
    const raw = text;
    const key = `editor|${name}|${Date.now()}`;
    return DiagnosisPanel.open(this.panelDeps(), {
      key,
      title: `${name} (local log)`,
      logUri: vscode.Uri.from({ scheme: LOG_SCHEME, path: `/local/${name.replace(/[\\/:*?"<>|]/g, '_')}-${Date.now()}.log` }),
      load: (signal) =>
        this.runAnalysis(
          {
            jobPath: [name],
            jobDisplayName: name,
            jobKind: 'unknown',
            build: { number: 0, status: 'unknown', building: false, causes: [], parameters: [], scm: { remoteUrls: [] }, changes: [] },
            log: { text: raw, truncated: false, totalBytes: Buffer.byteLength(raw) },
          },
          signal,
        ),
    });
  }

  private async openConsole(job: JobRef, buildNumber: number): Promise<void> {
    const client = this.requireClient();
    const log = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading console log for #${buildNumber}…`, cancellable: true },
      (_p, token) => {
        const ctrl = new AbortController();
        token.onCancellationRequested(() => ctrl.abort());
        return client.getConsoleLog(job.path, buildNumber, this.settings.maxLogBytes, ctrl.signal);
      },
    );
    let text = cleanLines(log.text).join('\n');
    if (this.settings.redactConsoleOutput) {
      text = this.redactor.redactString(text);
    }
    const uri = LogDocumentProvider.uriFor(job.path, buildNumber);
    this.logDocs.register(uri, text);
    try {
      await this.logDocs.show(uri, text.split('\n').length);
    } finally {
      // The open document now keeps the content alive until it is closed.
      this.logDocs.release(uri);
    }
  }

  private urlFor(node?: TreeNode): string | undefined {
    if (!this.client || !node || node.type === 'message') {
      return undefined;
    }
    return node.type === 'build' ? this.client.buildWebUrl(node.job.path, node.build.number) : this.client.jobWebUrl(node.job.path);
  }

  /** Hooks for the extension-host integration tests (only exposed in test mode). */
  testApi(): TestApi {
    return {
      setToken: async (token: string) => {
        const s = readSettings();
        await this.credentials.setJenkinsToken(normalizeBaseUrl(s.serverUrl), s.username, token);
        await this.reloadClient();
      },
      getChildren: async (node?: TreeNode) => {
        await this.ready;
        return this.tree.getChildren(node);
      },
      diagnose: async (jobPath: string[], n: number) => {
        await this.ready;
        return this.diagnose({ path: jobPath, displayName: jobPath[jobPath.length - 1], kind: 'pipeline' }, n);
      },
      analyzeText: (text: string) => this.analyzeActiveEditor(text),
    };
  }

  get knownSecret(): string | undefined {
    return this.token;
  }

  dispose(): void {
    DiagnosisPanel.disposeAll();
    this.disposables.forEach((d) => d.dispose());
  }
}
