import { displayPath } from '../jenkins/paths';
import type { BuildStatus } from '../jenkins/types';
import { CATEGORY_LABELS, type Diagnosis, type Evidence, type Finding } from '../analysis/types';

/**
 * Pure HTML rendering for the diagnosis webview. All dynamic text goes through `esc`,
 * and the page runs under a strict CSP with a nonce, so log content can never inject markup or script.
 */

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface AiViewState {
  status: 'unavailable' | 'idle' | 'running' | 'done' | 'error';
  providerLabel?: string;
  text?: string;
  error?: string;
  model?: string;
}

export interface RenderOptions {
  nonce: string;
  cspSource: string;
  ai: AiViewState;
  hasLog: boolean;
}

const STATUS_CLASS: Record<BuildStatus, string> = {
  success: 'ok',
  failure: 'bad',
  unstable: 'warn',
  aborted: 'muted',
  notBuilt: 'muted',
  building: 'info',
  disabled: 'muted',
  never: 'muted',
  unknown: 'muted',
};

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms <= 0) {
    return '—';
  }
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function formatTime(ts: number | undefined): string {
  return ts ? new Date(ts).toLocaleString() : '—';
}

function certaintyBadge(f: Finding): string {
  return f.certainty === 'confirmed'
    ? '<span class="badge ok" title="The log or Jenkins API explicitly reports this problem.">Confirmed by evidence</span>'
    : '<span class="badge warn" title="Inferred from indirect signals. Verify before acting.">Hypothesis — verify</span>';
}

function renderEvidence(e: Evidence): string {
  const row = (line: number, text: string, hit: boolean) =>
    `<div class="row${hit ? ' hit' : ''}">${
      line > 0 ? `<a href="#" class="ln" data-line="${line}" title="Open in console log">${line}</a>` : '<span class="ln"></span>'
    }<span class="code">${esc(text)}</span></div>`;
  const rows = [
    ...e.before.map((c) => row(c.line, c.text, false)),
    row(e.line ?? 0, e.text, true),
    ...e.after.map((c) => row(c.line, c.text, false)),
  ].join('');
  const label = e.source === 'testReport' ? 'Jenkins test report' : e.stage ? `Stage: ${esc(e.stage)}` : '';
  return `<div class="evidence">${label ? `<div class="evlabel">${label}</div>` : ''}<div class="log">${rows}</div></div>`;
}

function renderFinding(f: Finding, open: boolean, primary: boolean): string {
  return `<details class="finding${primary ? ' primary' : ''}"${open ? ' open' : ''}>
  <summary><span class="ftitle">${esc(f.title)}</span>
    <span class="chip">${esc(CATEGORY_LABELS[f.category])}</span>${certaintyBadge(f)}
    <span class="score" title="Ranking score">${esc(f.score)}</span></summary>
  <p class="fsummary">${esc(f.summary)}</p>
  ${f.occurrences > 1 ? `<p class="dim">${esc(f.occurrences)} occurrences in the log.</p>` : ''}
  ${f.rankingNotes.length ? `<ul class="dim notes">${f.rankingNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
  <h4>Evidence</h4>
  ${f.evidence.map(renderEvidence).join('') || '<p class="dim">No direct log evidence.</p>'}
  ${
    f.causes.length
      ? `<h4>Probable causes <span class="dim">(hypotheses, most likely first)</span></h4><ul>${f.causes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`
      : ''
  }
  ${f.remediation.length ? `<h4>Remediation</h4><ol>${f.remediation.map((r) => `<li>${inlineCode(r)}</li>`).join('')}</ol>` : ''}
</details>`;
}

/** Escapes text, then turns `code` spans into <code>. */
function inlineCode(s: string): string {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Minimal, safe Markdown renderer for AI output (escape first, then add a few constructs). */
export function renderMarkdown(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let inCode = false;
  let list: 'ul' | 'ol' | undefined;
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = undefined;
    }
  };
  for (const raw of lines) {
    if (raw.trim().startsWith('```')) {
      closeList();
      out.push(inCode ? '</pre>' : '<pre class="mdcode">');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(`${esc(raw)}\n`);
      continue;
    }
    const inline = (s: string) => inlineCode(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(raw))) {
      closeList();
      const level = Math.min(4, m[1].length + 2);
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
    } else if ((m = /^\s*[-*]\s+(.*)$/.exec(raw))) {
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(raw))) {
      if (list !== 'ol') {
        closeList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if (raw.trim() === '') {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(raw)}</p>`);
    }
  }
  closeList();
  if (inCode) {
    out.push('</pre>');
  }
  return out.join('\n');
}

export function renderAiSection(ai: AiViewState): string {
  switch (ai.status) {
    case 'unavailable':
      return `<p class="dim">AI analysis is off. The findings above come from the local rule engine; nothing has left your machine.
        To add an optional AI explanation, run <a href="#" data-action="configureAi">Jenkins: Configure AI Provider…</a>.</p>`;
    case 'idle':
      return `<p>Get a second opinion from <strong>${esc(ai.providerLabel)}</strong>. A redacted excerpt of the log is sent only after you confirm.</p>
        <button data-action="askAi">Ask AI</button>`;
    case 'running':
      return `<p><span class="spinner"></span> Asking ${esc(ai.providerLabel)}…</p><button data-action="cancelAi" class="secondary">Cancel</button>`;
    case 'error':
      return `<p class="errtext">AI analysis failed: ${esc(ai.error)}</p><button data-action="askAi">Retry</button>`;
    case 'done':
      return `<div class="aibanner">AI-generated (${esc(ai.model ?? ai.providerLabel)}). Treat it as a hypothesis and check it against the evidence above.</div>
        <div class="md">${renderMarkdown(ai.text ?? '')}</div><button data-action="askAi" class="secondary">Ask again</button>`;
  }
}

export function renderLoadingHtml(title: string, nonce: string, cspSource: string, message = 'Collecting build data…'): string {
  return page(title, nonce, cspSource, `<div class="loading"><span class="spinner"></span> ${esc(message)}</div>`);
}

export function renderErrorHtml(title: string, nonce: string, cspSource: string, message: string): string {
  return page(title, nonce, cspSource, `<h2>${esc(title)}</h2><p class="errtext">${esc(message)}</p><button data-action="reanalyze">Retry</button>`);
}

export function renderDiagnosisHtml(d: Diagnosis, opts: RenderOptions): string {
  const title = `${displayPath(d.job.path)} #${d.build.number}`;
  const b = d.build;
  const main = d.findings.filter((f) => !f.symptom && f !== d.primary);
  const confirmed = main.filter((f) => f.certainty === 'confirmed');
  const hypotheses = main.filter((f) => f.certainty === 'hypothesis');
  const symptoms = d.findings.filter((f) => f.symptom && f !== d.primary);

  const meta: [string, string][] = [
    ['Started', formatTime(b.timestamp)],
    ['Duration', formatDuration(b.durationMs)],
    ['Agent', b.builtOn ?? 'built-in / unknown'],
    ['Triggered by', b.causes.join('; ') || '—'],
  ];
  if (b.branch) {
    meta.push(['Branch', b.branch]);
  }
  if (b.commit) {
    meta.push(['Commit', b.commit.slice(0, 12)]);
  }

  const stageStrip = d.stages.length
    ? `<section><h2>Pipeline stages</h2><div class="stages">${d.stages
        .map(
          (s) =>
            `<span class="stage ${s.status === 'SUCCESS' ? 'ok' : s.status === 'FAILED' ? 'bad' : s.status === 'UNSTABLE' ? 'warn' : 'muted'}" title="${esc(
              s.status,
            )} · ${esc(formatDuration(s.durationMs))}">${esc(s.name)}</span>`,
        )
        .join('<span class="arrow">›</span>')}</div></section>`
    : '';

  const tests = d.failedTests.length
    ? `<section><h2>Failing tests ${d.testSummary ? `<span class="dim">(${d.testSummary.failed} failed, ${d.testSummary.passed} passed, ${d.testSummary.skipped} skipped)</span>` : ''}</h2>
      <table><thead><tr><th>Test</th><th>Error</th></tr></thead><tbody>${d.failedTests
        .slice(0, 50)
        .map(
          (t) =>
            `<tr><td><code>${esc(t.className ? `${t.className}.` : '')}${esc(t.name)}</code></td><td>${esc((t.errorDetails ?? '').split('\n')[0].slice(0, 400))}${
              t.stackTrace ? `<details><summary class="dim">stack trace</summary><pre>${esc(t.stackTrace.split('\n').slice(0, 25).join('\n'))}</pre></details>` : ''
            }</td></tr>`,
        )
        .join('')}</tbody></table>${d.failedTests.length > 50 ? `<p class="dim">…and ${d.failedTests.length - 50} more.</p>` : ''}</section>`
    : '';

  const params = b.parameters.length
    ? `<h3>Parameters</h3><table>${b.parameters.map((p) => `<tr><td><code>${esc(p.name)}</code></td><td>${esc(p.value)}</td></tr>`).join('')}</table>`
    : '';
  const changes = b.changes.length
    ? `<h3>Changes in this build</h3><ul>${b.changes
        .map((c) => `<li><code>${esc((c.commitId ?? '').slice(0, 10))}</code> ${esc(c.message.split('\n')[0])} <span class="dim">${esc(c.author ?? '')}</span></li>`)
        .join('')}</ul>`
    : '<p class="dim">No SCM changes recorded for this build.</p>';

  const body = `
<header>
  <div class="titlebar">
    <h1>${esc(title)}</h1>
    <span class="badge ${STATUS_CLASS[b.status]}">${esc(b.status.toUpperCase())}</span>
  </div>
  <div class="meta">${meta.map(([k, v]) => `<span><span class="dim">${esc(k)}:</span> ${esc(v)}</span>`).join('')}</div>
  <div class="actions">
    ${opts.hasLog ? '<button data-action="openConsole">Open console log</button>' : ''}
    ${b.webUrl ? '<button data-action="openBuild" class="secondary">Open in Jenkins</button>' : ''}
    <button data-action="copyMarkdown" class="secondary">Copy report as Markdown</button>
    <button data-action="reanalyze" class="secondary">Re-analyse</button>
  </div>
</header>

<section class="headline ${STATUS_CLASS[b.status]}">
  <h2>${esc(d.headline)}</h2>
  ${d.primary ? `<div class="label">Most probable root cause</div>${renderFinding(d.primary, true, true)}` : ''}
</section>

${confirmed.length ? `<section><h2>Other confirmed findings</h2>${confirmed.map((f) => renderFinding(f, false, false)).join('')}</section>` : ''}
${hypotheses.length ? `<section><h2>Hypotheses</h2><p class="dim">Inferred from indirect signals. Verify these before acting.</p>${hypotheses.map((f) => renderFinding(f, false, false)).join('')}</section>` : ''}
${stageStrip}
${tests}
${
  symptoms.length
    ? `<section><details><summary><h2 class="inline">Failure markers (${symptoms.length})</h2></summary><p class="dim">Generic lines showing where the build stopped. They are symptoms, not causes.</p>${symptoms
        .map((f) => renderFinding(f, false, false))
        .join('')}</details></section>`
    : ''
}
<section id="ai-section"><h2>AI analysis <span class="dim">(optional)</span></h2><div id="ai">${renderAiSection(opts.ai)}</div></section>
<section><details><summary><h2 class="inline">Build metadata</h2></summary>${params}${changes}</details></section>
${d.notes.length ? `<section><h2>Notes</h2><ul class="dim">${d.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></section>` : ''}
<footer class="dim">Rule engine: ${d.stats.rulesEvaluated} rules over ${d.stats.lines.toLocaleString()} lines in ${d.stats.analysisMs} ms.
${d.stats.redactions ? `${d.stats.redactions} value(s) redacted.` : ''} Analysed ${esc(new Date(d.analyzedAt).toLocaleString())}.</footer>`;
  return page(title, opts.nonce, opts.cspSource, body);
}

function page(title: string, nonce: string, cspSource: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
${body}
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

const CSS = `
:root { --ok: var(--vscode-testing-iconPassed, #3fb950); --bad: var(--vscode-testing-iconFailed, #f85149); --warn: var(--vscode-editorWarning-foreground, #d29922); --info: var(--vscode-editorInfo-foreground, #58a6ff); --muted: var(--vscode-descriptionForeground); }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0 24px 32px; line-height: 1.5; max-width: 1200px; }
h1 { font-size: 1.4em; margin: 0; } h2 { font-size: 1.15em; margin: 1.2em 0 .5em; } h2.inline { display: inline; } h4 { margin: .9em 0 .3em; font-size: .95em; }
header { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 16px 0 10px; border-bottom: 1px solid var(--vscode-panel-border); z-index: 2; }
.titlebar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 18px; margin: 8px 0; font-size: .92em; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 5px 12px; border-radius: 2px; cursor: pointer; font-family: inherit; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
a { color: var(--vscode-textLink-foreground); }
.dim { color: var(--muted); font-weight: normal; }
.badge { font-size: .78em; padding: 1px 8px; border-radius: 10px; border: 1px solid currentColor; white-space: nowrap; margin-left: 6px; }
.badge.ok, .stage.ok { color: var(--ok); } .badge.bad, .stage.bad { color: var(--bad); } .badge.warn, .stage.warn { color: var(--warn); } .badge.info { color: var(--info); } .badge.muted, .stage.muted { color: var(--muted); }
.chip { font-size: .78em; padding: 1px 8px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-left: 8px; }
.score { float: right; font-size: .8em; color: var(--muted); }
.headline { border-left: 4px solid var(--muted); padding: 4px 16px 8px; margin-top: 16px; background: var(--vscode-textBlockQuote-background); }
.headline.bad { border-color: var(--bad); } .headline.warn { border-color: var(--warn); } .headline.ok { border-color: var(--ok); }
.label { text-transform: uppercase; font-size: .75em; letter-spacing: .06em; color: var(--muted); margin-bottom: 4px; }
details.finding { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 12px; margin: 8px 0; background: var(--vscode-editor-background); }
details.finding.primary { border-color: var(--vscode-focusBorder); }
details > summary { cursor: pointer; }
.ftitle { font-weight: 600; }
.fsummary { margin: .5em 0; }
ul.notes { margin: .2em 0; padding-left: 18px; font-size: .9em; }
.evidence { margin: 6px 0 10px; }
.evlabel { font-size: .8em; color: var(--muted); margin-bottom: 2px; }
.log { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); background: var(--vscode-textCodeBlock-background); border-radius: 3px; overflow-x: auto; padding: 4px 0; }
.row { display: flex; white-space: pre; } .row.hit { background: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, .33)); }
.ln { min-width: 56px; text-align: right; padding-right: 10px; color: var(--vscode-editorLineNumber-foreground); text-decoration: none; user-select: none; }
.code { padding-right: 12px; }
code, pre { font-family: var(--vscode-editor-font-family); } code { background: var(--vscode-textCodeBlock-background); padding: 0 4px; border-radius: 3px; }
pre { background: var(--vscode-textCodeBlock-background); padding: 8px; overflow-x: auto; white-space: pre-wrap; }
table { border-collapse: collapse; width: 100%; } td, th { border-bottom: 1px solid var(--vscode-panel-border); padding: 4px 8px; text-align: left; vertical-align: top; }
.stages { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.stage { border: 1px solid currentColor; border-radius: 3px; padding: 1px 8px; } .arrow { color: var(--muted); }
.aibanner { font-size: .85em; color: var(--warn); margin-bottom: 8px; }
.errtext { color: var(--bad); }
.loading { margin-top: 40px; font-size: 1.1em; }
.spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--muted); border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; vertical-align: middle; }
@keyframes spin { to { transform: rotate(360deg); } }
footer { margin-top: 2em; font-size: .85em; }
`;

const SCRIPT = `
(function () {
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) { return; }
    const line = target.closest('[data-line]');
    if (line) { e.preventDefault(); vscode.postMessage({ type: 'openLine', line: Number(line.getAttribute('data-line')) }); return; }
    const action = target.closest('[data-action]');
    if (action) { e.preventDefault(); vscode.postMessage({ type: action.getAttribute('data-action') }); }
  });
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.type === 'aiHtml' && typeof msg.html === 'string') {
      const el = document.getElementById('ai');
      if (el) { el.innerHTML = msg.html; }
    }
  });
})();
`;
