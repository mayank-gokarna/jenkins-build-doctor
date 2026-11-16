import * as vscode from 'vscode';

export const LOG_SCHEME = 'jenkins-log';

/**
 * Serves console logs as read-only virtual documents. Content is held in memory only while
 * a document (or the diagnosis panel that registered it) is open. Nothing is written to disk.
 */
export class LogDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly owners = new Map<string, number>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.scheme === LOG_SCHEME) {
          this.releaseIfUnowned(doc.uri.toString());
        }
      }),
    );
  }

  static uriFor(jobPath: readonly string[], buildNumber: number): vscode.Uri {
    const name = jobPath.map((s) => s.replace(/[\\/:*?"<>|]/g, '_')).join('/');
    return vscode.Uri.from({ scheme: LOG_SCHEME, path: `/${name}/#${buildNumber}.log` });
  }

  /** Registers content and takes a reference held by the caller until `release`. */
  register(uri: vscode.Uri, text: string): void {
    const k = uri.toString();
    this.contents.set(k, text);
    this.owners.set(k, (this.owners.get(k) ?? 0) + 1);
    this.emitter.fire(uri);
  }

  release(uri: vscode.Uri): void {
    const k = uri.toString();
    const n = (this.owners.get(k) ?? 1) - 1;
    if (n <= 0) {
      this.owners.delete(k);
      const open = vscode.workspace.textDocuments.some((d) => d.uri.toString() === k);
      if (!open) {
        this.contents.delete(k);
      }
    } else {
      this.owners.set(k, n);
    }
  }

  private releaseIfUnowned(k: string): void {
    if (!this.owners.has(k)) {
      this.contents.delete(k);
    }
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '(This log is no longer in memory. Re-open it from the Jenkins view or the diagnosis panel.)';
  }

  async show(uri: vscode.Uri, line?: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
    if (line && line > 0) {
      const l = Math.min(line - 1, doc.lineCount - 1);
      const range = doc.lineAt(l).range;
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }
  }

  dispose(): void {
    this.contents.clear();
    this.owners.clear();
    this.emitter.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
