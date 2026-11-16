import * as vscode from 'vscode';
import type { Logger } from '../core/logger';
import { JenkinsError, type JenkinsClient } from '../jenkins/client';
import { displayPath, safeDecode } from '../jenkins/paths';
import type { BuildStatus, BuildSummary, JobKind, JobSummary } from '../jenkins/types';
import { formatDuration } from '../report/html';

export type TreeNode =
  | { type: 'folder'; job: JobSummary }
  | { type: 'job'; job: JobSummary; flat?: boolean }
  | { type: 'build'; job: JobSummary; build: BuildSummary }
  | { type: 'message'; label: string; detail?: string; icon: string; command?: vscode.Command };

export function timeAgo(ts: number | undefined, now = Date.now()): string {
  if (!ts) {
    return '';
  }
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) {
    return 'just now';
  }
  const m = Math.round(s / 60);
  if (m < 60) {
    return `${m}m ago`;
  }
  const h = Math.round(m / 60);
  if (h < 48) {
    return `${h}h ago`;
  }
  return `${Math.round(h / 24)}d ago`;
}

const STATUS_ICON: Record<BuildStatus, [string, string | undefined]> = {
  success: ['pass', 'testing.iconPassed'],
  failure: ['error', 'testing.iconFailed'],
  unstable: ['warning', 'editorWarning.foreground'],
  aborted: ['circle-slash', 'disabledForeground'],
  notBuilt: ['circle-outline', 'disabledForeground'],
  building: ['sync~spin', 'editorInfo.foreground'],
  disabled: ['circle-slash', 'disabledForeground'],
  never: ['circle-outline', 'disabledForeground'],
  unknown: ['question', undefined],
};

const KIND_ICON: Partial<Record<JobKind, string>> = {
  folder: 'folder',
  multibranch: 'git-branch',
  organization: 'organization',
};

const KIND_LABEL: Record<JobKind, string> = {
  folder: 'Folder',
  multibranch: 'Multibranch pipeline',
  organization: 'Organization folder',
  pipeline: 'Pipeline',
  freestyle: 'Freestyle job',
  matrix: 'Matrix job',
  maven: 'Maven job',
  external: 'External job',
  unknown: 'Job',
};

export const STATUS_TEXT: Record<BuildStatus, string> = {
  success: 'success',
  failure: 'failed',
  unstable: 'unstable',
  aborted: 'aborted',
  notBuilt: 'not built',
  building: 'running',
  disabled: 'disabled',
  never: 'never built',
  unknown: 'unknown',
};

function statusIcon(status: BuildStatus): vscode.ThemeIcon {
  const [id, color] = STATUS_ICON[status];
  return new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
}

export class JobTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly cache = new Map<string, Promise<TreeNode[]>>();
  private filter?: { text: string; jobs: JobSummary[]; complete: boolean };

  constructor(
    private readonly getClient: () => JenkinsClient | undefined,
    private readonly getBuildLimit: () => number,
    private readonly logger: Logger,
  ) {}

  get filterText(): string | undefined {
    return this.filter?.text;
  }

  setFilter(text: string, index: { jobs: JobSummary[]; complete: boolean }): void {
    this.filter = { text, jobs: index.jobs, complete: index.complete };
    this.emitter.fire(undefined);
  }

  clearFilter(): void {
    this.filter = undefined;
    this.emitter.fire(undefined);
  }

  /** Clears cached children for a node (or everything) and re-renders. */
  refresh(node?: TreeNode): void {
    if (!node || node.type === 'message') {
      this.cache.clear();
      this.emitter.fire(undefined);
      return;
    }
    const prefix = key(node.job.path);
    for (const k of [...this.cache.keys()]) {
      if (k === prefix || k.startsWith(`${prefix}\u0000`)) {
        this.cache.delete(k);
      }
    }
    this.emitter.fire(node.type === 'build' ? undefined : node);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.type) {
      case 'message': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.description = node.detail;
        item.tooltip = node.detail ? `${node.label}\n${node.detail}` : node.label;
        item.command = node.command;
        item.contextValue = 'message';
        return item;
      }
      case 'folder': {
        const item = new vscode.TreeItem(node.job.displayName, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon(KIND_ICON[node.job.kind] ?? 'folder');
        item.description = this.filter ? displayPath(node.job.path.slice(0, -1)) : KIND_LABEL[node.job.kind].toLowerCase();
        item.tooltip = `${KIND_LABEL[node.job.kind]}: ${displayPath(node.job.path)}`;
        item.contextValue = 'folder';
        item.id = `f:${key(node.job.path)}`;
        return item;
      }
      case 'job': {
        const j = node.job;
        const item = new vscode.TreeItem(j.displayName, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = statusIcon(j.status);
        const last = j.lastBuild;
        const parts = [
          last ? `#${last.number}` : '',
          STATUS_TEXT[last?.status && last.status !== 'unknown' ? last.status : j.status],
          last ? timeAgo(last.timestamp) : '',
        ].filter(Boolean);
        item.description = node.flat ? `${displayPath(j.path.slice(0, -1))} · ${parts.join(' · ')}` : parts.join(' · ');
        const md = new vscode.MarkdownString(undefined, true);
        md.appendMarkdown(`**${escapeMd(j.displayName)}**  \n`);
        md.appendMarkdown(`${KIND_LABEL[j.kind]} · \`${escapeMd(displayPath(j.path))}\`  \n`);
        if (last) {
          md.appendMarkdown(
            `Last build #${last.number}: **${STATUS_TEXT[last.status]}**${last.timestamp ? ` · ${new Date(last.timestamp).toLocaleString()}` : ''}${
              last.durationMs ? ` · ${formatDuration(last.durationMs)}` : ''
            }`,
          );
        } else {
          md.appendMarkdown('No builds yet');
        }
        item.tooltip = md;
        item.contextValue = 'job';
        item.id = `${node.flat ? 'jf' : 'j'}:${key(j.path)}`;
        return item;
      }
      case 'build': {
        const b = node.build;
        const item = new vscode.TreeItem(b.displayName && b.displayName !== `#${b.number}` ? `#${b.number} ${b.displayName}` : `#${b.number}`);
        item.iconPath = statusIcon(b.status);
        item.description = [STATUS_TEXT[b.status], b.building ? '' : formatDuration(b.durationMs), timeAgo(b.timestamp)].filter((s) => s && s !== '—').join(' · ');
        item.tooltip = `Build #${b.number}: ${STATUS_TEXT[b.status]}\n${b.timestamp ? new Date(b.timestamp).toLocaleString() : ''}\nClick to diagnose.`;
        item.contextValue = 'build';
        item.id = `b:${key(node.job.path)}#${b.number}`;
        item.command = { command: 'jenkinsBuildDoctor.diagnoseBuild', title: 'Diagnose Build', arguments: [node] };
        return item;
      }
    }
  }

  getChildren(node?: TreeNode): Promise<TreeNode[]> | TreeNode[] {
    const client = this.getClient();
    if (!client) {
      return [];
    }
    if (!node) {
      return this.filter ? this.filteredRoot(this.filter) : this.cached([], () => this.loadFolder(client, []));
    }
    switch (node.type) {
      case 'folder':
        return this.cached(node.job.path, () => this.loadFolder(client, node.job.path));
      case 'job':
        return this.cached(node.job.path, () => this.loadBuilds(client, node.job));
      default:
        return [];
    }
  }

  private filteredRoot(filter: { text: string; jobs: JobSummary[]; complete: boolean }): TreeNode[] {
    const needle = filter.text.toLowerCase();
    const matches = filter.jobs.filter(
      (j) => j.displayName.toLowerCase().includes(needle) || displayPath(j.path).toLowerCase().includes(needle) || safeDecode(j.name).toLowerCase().includes(needle),
    );
    const header: TreeNode = {
      type: 'message',
      icon: 'filter',
      label: `Filter: "${filter.text}"`,
      detail: `${matches.length} match(es)${filter.complete ? '' : ' (index incomplete)'} — click to clear`,
      command: { command: 'jenkinsBuildDoctor.clearFilter', title: 'Clear Filter' },
    };
    return [header, ...matches.slice(0, 500).map((job): TreeNode => (job.isContainer ? { type: 'folder', job } : { type: 'job', job, flat: true }))];
  }

  private cached(path: readonly string[], load: () => Promise<TreeNode[]>): Promise<TreeNode[]> {
    const k = key(path);
    let p = this.cache.get(k);
    if (!p) {
      p = load().catch((e: unknown) => {
        this.cache.delete(k);
        return [this.errorNode(e)];
      });
      this.cache.set(k, p);
    }
    return p;
  }

  private async loadFolder(client: JenkinsClient, path: readonly string[]): Promise<TreeNode[]> {
    const jobs = await client.listJobs(path);
    if (jobs.length === 0) {
      return [{ type: 'message', icon: 'info', label: path.length === 0 ? 'No jobs visible to this account' : 'Empty' }];
    }
    return jobs
      .sort((a, b) => Number(b.isContainer) - Number(a.isContainer) || a.displayName.localeCompare(b.displayName))
      .map((job): TreeNode => (job.isContainer ? { type: 'folder', job } : { type: 'job', job }));
  }

  private async loadBuilds(client: JenkinsClient, job: JobSummary): Promise<TreeNode[]> {
    const details = await client.getJob(job.path, this.getBuildLimit());
    if (details.builds.length === 0) {
      return [{ type: 'message', icon: 'info', label: 'No builds' }];
    }
    return details.builds.map((build): TreeNode => ({ type: 'build', job: details.job, build }));
  }

  private errorNode(e: unknown): TreeNode {
    const message = e instanceof Error ? e.message : String(e);
    this.logger.warn('Tree load failed', { error: e });
    const auth = e instanceof JenkinsError && (e.kind === 'auth' || e.kind === 'forbidden');
    return {
      type: 'message',
      icon: 'error',
      label: auth ? 'Access denied' : 'Failed to load',
      detail: message,
      command: auth
        ? { command: 'jenkinsBuildDoctor.configure', title: 'Configure' }
        : { command: 'jenkinsBuildDoctor.refresh', title: 'Retry' },
    };
  }
}

function key(path: readonly string[]): string {
  return path.join('\u0000');
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

/** Cached recursive job index used by Search Jobs and Filter Jobs. */
export class JobIndex {
  private cached?: { jobs: JobSummary[]; complete: boolean };
  private inflight?: Promise<{ jobs: JobSummary[]; complete: boolean }>;

  constructor(
    private readonly getClient: () => JenkinsClient | undefined,
    private readonly getLimits: () => { maxDepth: number; maxJobs: number },
  ) {}

  invalidate(): void {
    this.cached = undefined;
  }

  async get(): Promise<{ jobs: JobSummary[]; complete: boolean }> {
    if (this.cached) {
      return this.cached;
    }
    const client = this.getClient();
    if (!client) {
      throw new Error('Jenkins is not configured.');
    }
    if (!this.inflight) {
      this.inflight = Promise.resolve(
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Indexing Jenkins jobs', cancellable: true },
          async (progress, token) => {
            const ctrl = new AbortController();
            const sub = token.onCancellationRequested(() => ctrl.abort());
            try {
              return await client.crawlJobs(
                { ...this.getLimits(), onProgress: (n) => progress.report({ message: `${n} items found…` }) },
                ctrl.signal,
              );
            } finally {
              sub.dispose();
            }
          },
        ),
      )
        .then((r) => {
          this.cached = r;
          return r;
        })
        .finally(() => (this.inflight = undefined));
    }
    return this.inflight;
  }
}
