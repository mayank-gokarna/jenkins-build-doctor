import * as assert from 'node:assert/strict';
import { analyzeBuild, type AnalyzeOptions } from '../../src/analysis/engine';
import { compileCustomRules } from '../../src/analysis/rules';
import { BUILT_IN_RULES } from '../../src/analysis/rules';
import { compileRules, fillTemplate, scanLines } from '../../src/analysis/ruleEngine';
import { Redactor } from '../../src/core/redact';
import type { BuildContext, BuildStatus, StageInfo, TestReport } from '../../src/jenkins/types';
import * as logs from '../fixtures/logs';

function ctx(text: string, status: BuildStatus = 'failure', extra: { stages?: StageInfo[]; testReport?: TestReport } = {}): BuildContext {
  return {
    jobPath: ['team', 'job'],
    jobDisplayName: 'job',
    jobKind: 'pipeline',
    build: { number: 1, status, building: false, causes: [], parameters: [], scm: { remoteUrls: [] }, changes: [] },
    log: { text, truncated: false, totalBytes: text.length },
    ...extra,
  };
}

const opts = (over: Partial<AnalyzeOptions> = {}): AnalyzeOptions => ({ redactor: new Redactor(), redactLog: true, contextLines: 2, ...over });

describe('analysis engine', () => {
  const cases: [string, string, string][] = [
    ['Maven compile error', logs.MAVEN_COMPILE_FAILURE, 'compile.jvm'],
    ['Kubernetes image pull', logs.K8S_IMAGE_PULL, 'k8s.image-pull'],
    ['npm 404', logs.NPM_E404, 'dep.npm'],
    ['git auth', logs.GIT_AUTH, 'auth.git'],
    ['Jenkinsfile syntax', logs.GROOVY_ERROR, 'pipeline.syntax'],
    ['missing credentials', logs.CREDENTIALS_MISSING, 'auth.jenkins-credentials-missing'],
    ['killed / OOM', logs.OOM_137, 'resource.killed'],
  ];
  for (const [name, text, expected] of cases) {
    it(`identifies the root cause: ${name}`, async () => {
      const { diagnosis } = await analyzeBuild(ctx(text), opts());
      assert.equal(diagnosis.primary?.ruleId, expected, `findings: ${diagnosis.findings.map((f) => `${f.ruleId}=${f.score}`).join(', ')}`);
      assert.ok(!diagnosis.primary?.symptom);
      assert.ok(diagnosis.primary!.evidence.length > 0);
    });
  }

  it('provides evidence with line numbers, context and stage', async () => {
    const { diagnosis, log } = await analyzeBuild(ctx(logs.MAVEN_COMPILE_FAILURE), opts());
    const ev = diagnosis.primary!.evidence[0];
    assert.ok(ev.line && log.lines[ev.line - 1].includes('cannot find symbol'));
    assert.equal(ev.stage, 'Build');
    assert.equal(ev.before.length, 2);
    assert.equal(ev.after.length, 2);
    assert.match(diagnosis.primary!.summary, /OrderService\.java:57 — cannot find symbol/);
  });

  it('separates confirmed findings from hypotheses', async () => {
    const { diagnosis } = await analyzeBuild(ctx(logs.OOM_137), opts());
    assert.equal(diagnosis.primary!.certainty, 'hypothesis');
    const exit = diagnosis.findings.find((f) => f.ruleId === 'generic.script-exit')!;
    assert.equal(exit.certainty, 'confirmed');
    assert.ok(exit.symptom);
    assert.ok(exit.causes.some((c) => c.includes('137')), 'exit-code enrichment');
  });

  it('boosts findings inside the stage Jenkins reports as failed', async () => {
    const stages: StageInfo[] = [{ id: '1', name: 'Build', status: 'FAILED' }];
    const { diagnosis } = await analyzeBuild(ctx(logs.MAVEN_COMPILE_FAILURE, 'failure', { stages }), opts());
    assert.ok(diagnosis.primary!.rankingNotes.some((n) => n.includes('failed stage “Build”')));
    assert.match(diagnosis.headline, /in stage “Build”/);
  });

  it('uses the Jenkins test report as confirmed evidence', async () => {
    const testReport: TestReport = {
      failCount: 1,
      passCount: 3,
      skipCount: 0,
      failures: [{ className: 'a.B', name: 'c', status: 'FAILED', errorDetails: 'expected true password=hunter22' }],
    };
    const { diagnosis } = await analyzeBuild(ctx('Finished: UNSTABLE\n', 'unstable', { testReport }), opts());
    assert.equal(diagnosis.primary?.ruleId, 'test.report');
    assert.equal(diagnosis.failedTests.length, 1);
    assert.ok(!diagnosis.failedTests[0].errorDetails!.includes('hunter22'), 'test details are redacted');
  });

  it('falls back to the lines before the failure when nothing matches', async () => {
    const { diagnosis } = await analyzeBuild(ctx(logs.UNKNOWN_FAILURE), opts());
    assert.equal(diagnosis.primary?.ruleId, 'generic.unknown');
    assert.equal(diagnosis.primary?.certainty, 'hypothesis');
    assert.ok(diagnosis.primary!.evidence[0].before.some((l) => l.text.includes('calibration drift')));
  });

  it('does not invent a root cause for successful builds', async () => {
    const { diagnosis } = await analyzeBuild(ctx(logs.SUCCESS, 'success'), opts());
    assert.equal(diagnosis.primary, undefined);
    assert.match(diagnosis.headline, /succeeded/);
  });

  it('redacts secrets in evidence and reports the count', async () => {
    const { diagnosis, log } = await analyzeBuild(ctx(`${logs.WITH_SECRETS}\n${logs.GIT_AUTH}`), opts());
    assert.ok(diagnosis.stats.redactions > 0);
    assert.ok(!log.lines.join('\n').includes('hunter2secret'));
    assert.ok(diagnosis.notes.some((n) => n.includes('redacted')));
  });

  it('applies custom rules from settings and reports invalid ones', async () => {
    const { rules, errors } = compileCustomRules([
      { id: 'drift', title: 'Calibration drift', category: 'infrastructure', pattern: 'calibration drift exceeded', summary: 'Drift: {0}', remediation: ['Recalibrate'] },
      { id: 'bad', title: 'Bad', pattern: '(' },
      { title: 'missing id', pattern: 'x' },
    ]);
    assert.equal(rules.length, 1);
    assert.equal(errors.length, 2);
    const { diagnosis } = await analyzeBuild(ctx(logs.UNKNOWN_FAILURE), opts({ customRules: rules }));
    assert.equal(diagnosis.primary?.ruleId, 'custom.drift');
    assert.equal(diagnosis.primary?.summary, 'Drift: calibration drift exceeded');
  });

  it('honours cancellation', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(analyzeBuild(ctx(logs.MAVEN_COMPILE_FAILURE), opts({ signal: ctrl.signal })), /cancelled/);
  });

  it('notes truncated logs', async () => {
    const c = ctx(logs.NPM_E404);
    c.log = { ...c.log, truncated: true, totalBytes: 50 * 1024 * 1024 };
    const { diagnosis } = await analyzeBuild(c, opts());
    assert.ok(diagnosis.notes.some((n) => n.includes('50.0 MB')));
  });

  it('scans large logs quickly', async function () {
    this.timeout(20000);
    const filler = Array.from({ length: 200_000 }, (_, i) => `[INFO] Downloading artifact ${i} from central`).join('\n');
    const started = Date.now();
    const { diagnosis } = await analyzeBuild(ctx(`${filler}\n${logs.MAVEN_COMPILE_FAILURE}`), opts());
    assert.equal(diagnosis.primary?.ruleId, 'compile.jvm');
    assert.ok(Date.now() - started < 15000, `took ${Date.now() - started}ms`);
  });
});

describe('rule engine primitives', () => {
  it('all built-in rule ids are unique and patterns compile', () => {
    const ids = BUILT_IN_RULES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.doesNotThrow(() => compileRules(BUILT_IN_RULES));
    for (const r of BUILT_IN_RULES) {
      for (const p of r.patterns) {
        assert.ok(!p.test(''), `${r.id} matches empty string`);
      }
    }
  });

  it('records at most one match per line per rule and respects exclude', async () => {
    const rules = compileRules([
      { id: 't', title: 't', category: 'generic', certainty: 'confirmed', weight: 1, patterns: [/foo/, /bar/], exclude: /skip/, summary: '', causes: [], remediation: [] },
    ]);
    const res = await scanLines(['foo bar foo', 'skip foo', 'bar'], rules);
    assert.deepEqual(
      res.get('t')!.map((m) => m.line),
      [1, 3],
    );
  });

  it('fills templates', () => {
    const m = { line: 1, text: 'x', match: 'whole', groups: [undefined, 'second'] };
    assert.equal(fillTemplate('A {0} B {2} C {g}', m), 'A whole B second C second');
    assert.equal(fillTemplate('Exit {1}', undefined), 'Exit');
  });
});
