import * as assert from 'node:assert/strict';
import { analyzeBuild } from '../../src/analysis/engine';
import { Redactor } from '../../src/core/redact';
import { esc, formatDuration, renderDiagnosisHtml, renderMarkdown } from '../../src/report/html';
import { diagnosisToMarkdown } from '../../src/report/markdown';
import { MAVEN_COMPILE_FAILURE } from '../fixtures/logs';

async function diagnose(text: string) {
  return (
    await analyzeBuild(
      {
        jobPath: ['team', '<script>job</script>'],
        jobDisplayName: 'job',
        jobKind: 'pipeline',
        build: { number: 3, status: 'failure', building: false, causes: ['Started by "x"'], parameters: [], scm: { remoteUrls: [] }, changes: [] },
        log: { text, truncated: false, totalBytes: text.length },
      },
      { redactor: new Redactor(), redactLog: true, contextLines: 1 },
    )
  ).diagnosis;
}

describe('report rendering', () => {
  it('escapes log content and job names (no markup injection)', async () => {
    const d = await diagnose(`[ERROR] /src/A.java:[1,1] <img src=x onerror=alert(1)>\n${MAVEN_COMPILE_FAILURE}`);
    const html = renderDiagnosisHtml(d, { nonce: 'abc', cspSource: 'vscode-resource:', ai: { status: 'unavailable' }, hasLog: true });
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('<script>job'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.match(html, /Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: data:; style-src 'nonce-abc'; script-src 'nonce-abc';/);
    assert.equal((html.match(/<script/g) ?? []).length, 1, 'only the nonce-protected script tag');
    assert.ok(html.includes('Most probable root cause'));
    assert.ok(html.includes('data-line='));
  });

  it('renders AI markdown safely', () => {
    const html = renderMarkdown('## Root cause\n- **bold** `code` <b>x</b>\n```\n<script>\n```');
    assert.ok(html.includes('<h4>Root cause</h4>'));
    assert.ok(html.includes('<strong>bold</strong>'));
    assert.ok(html.includes('<code>code</code>'));
    assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  it('exports Markdown', async () => {
    const md = diagnosisToMarkdown(await diagnose(MAVEN_COMPILE_FAILURE), 'AI says hi');
    assert.match(md, /## Most probable root cause/);
    assert.match(md, /JVM compilation error \(Compilation, confirmed\)/);
    assert.match(md, /## AI analysis \(unverified\)/);
  });

  it('formats helpers', () => {
    assert.equal(esc(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
    assert.equal(formatDuration(95_000), '1m 35s');
    assert.equal(formatDuration(3_700_000), '1h 1m');
    assert.equal(formatDuration(undefined), '—');
  });
});
