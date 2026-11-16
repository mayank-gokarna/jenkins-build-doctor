import * as assert from 'node:assert/strict';
import { analyzeBuild } from '../../src/analysis/engine';
import { Redactor } from '../../src/core/redact';
import { JenkinsClient, JenkinsError } from '../../src/jenkins/client';
import type { BuildContext } from '../../src/jenkins/types';
import { MOCK_TOKEN, MOCK_USER, startMockJenkins, type MockJenkins } from './mockJenkins';

/** Integration: real HTTP against a mock Jenkins, then the full analysis pipeline. */
describe('Jenkins client + analysis (integration, mock server)', () => {
  let jenkins: MockJenkins;
  let client: JenkinsClient;

  before(async () => {
    jenkins = await startMockJenkins('/ci');
    client = new JenkinsClient({ baseUrl: jenkins.url, username: MOCK_USER, token: MOCK_TOKEN, strictSSL: true, timeoutMs: 5000 });
  });
  after(() => jenkins.close());

  it('validates the connection and identifies the user', async () => {
    const info = await client.validate();
    assert.deepEqual(info, { version: '2.462.3', user: 'alice', anonymous: false, rootJobCount: 3 });
    assert.ok(jenkins.requests.every((r) => r.auth?.startsWith('Basic ')));
  });

  it('reports bad credentials as an auth error', async () => {
    const bad = new JenkinsClient({ baseUrl: jenkins.url, username: MOCK_USER, token: 'wrong', strictSSL: true, timeoutMs: 5000 });
    await assert.rejects(bad.validate(), (e: unknown) => e instanceof JenkinsError && e.kind === 'auth');
  });

  it('lists folders, multibranch projects and nested jobs', async () => {
    const root = await client.listJobs([]);
    assert.deepEqual(
      root.map((j) => [j.name, j.kind, j.isContainer]),
      [
        ['team-a', 'folder', true],
        ['app', 'multibranch', true],
        ['nightly', 'freestyle', false],
      ],
    );
    const teamA = await client.listJobs(['team-a']);
    assert.equal(teamA.length, 2, 'malformed entry dropped');
    const branches = await client.listJobs(['app']);
    assert.equal(branches[1].displayName, 'feature/login');
  });

  it('crawls the whole tree for search', async () => {
    const { jobs, complete } = await client.crawlJobs({ maxDepth: 5, maxJobs: 100 });
    assert.ok(complete);
    assert.deepEqual(jobs.filter((j) => !j.isContainer).map((j) => j.path.join('/')).sort(), [
      'app/feature%2Flogin',
      'app/main',
      'nightly',
      'team-a/backend-build',
      'team-a/nested/deploy-prod',
    ]);
    const limited = await client.crawlJobs({ maxDepth: 1, maxJobs: 100 });
    assert.equal(limited.complete, false);
  });

  it('loads build history', async () => {
    const d = await client.getJob(['team-a', 'backend-build'], 10);
    assert.deepEqual(
      d.builds.map((b) => [b.number, b.status]),
      [
        [43, 'building'],
        [42, 'failure'],
        [41, 'success'],
      ],
    );
    assert.equal(d.lastFailedBuild, 42);
  });

  it('refuses to follow redirects to another origin', async () => {
    const redirecting = new JenkinsClient({ baseUrl: `${jenkins.url}redirect-elsewhere/`, username: MOCK_USER, token: MOCK_TOKEN, strictSSL: true, timeoutMs: 5000 });
    await assert.rejects(redirecting.validate(), (e: unknown) => e instanceof JenkinsError && e.kind === 'redirect');
  });

  async function diagnose(path: string[], n: number) {
    const [build, log, testReport, stages] = await Promise.all([
      client.getBuild(path, n),
      client.getConsoleLog(path, n, 1024 * 1024),
      client.getTestReport(path, n),
      client.getStages(path, n),
    ]);
    const ctx: BuildContext = { jobPath: path, jobDisplayName: path[path.length - 1], jobKind: 'pipeline', build, log, testReport, stages };
    return (await analyzeBuild(ctx, { redactor: new Redactor({ knownSecrets: [MOCK_TOKEN] }), redactLog: true, contextLines: 3 })).diagnosis;
  }

  it('diagnoses a compilation failure end to end', async () => {
    const d = await diagnose(['team-a', 'backend-build'], 42);
    assert.equal(d.primary?.ruleId, 'compile.jvm');
    assert.equal(d.failedStages[0].name, 'Build');
    assert.match(d.headline, /Failed in stage “Build”: JVM compilation error/);
    assert.equal(d.build.builtOn, 'agent-linux-01');
    assert.equal(d.build.parameters.find((p) => p.name === 'API_TOKEN')?.value, '******');
    assert.equal(d.build.changes[0].author, 'Bob');
    assert.ok(d.notes.some((n) => n.includes('script returned exit code 1')));
  });

  it('diagnoses a Kubernetes deployment failure in a nested folder', async () => {
    const d = await diagnose(['team-a', 'nested', 'deploy-prod'], 7);
    assert.equal(d.primary?.ruleId, 'k8s.image-pull');
    assert.ok(d.findings.some((f) => f.ruleId === 'k8s.rollout'));
  });

  it('diagnoses an unstable multibranch build from the JUnit report', async () => {
    const d = await diagnose(['app', 'feature%2Flogin'], 3);
    assert.equal(d.build.status, 'unstable');
    assert.equal(d.primary?.ruleId, 'test.report');
    assert.equal(d.failedTests[0].name, 'rejects bad password');
    assert.deepEqual(d.testSummary, { failed: 1, passed: 19, skipped: 0 });
  });

  it('treats missing test reports as absent, not as errors', async () => {
    assert.equal(await client.getTestReport(['team-a', 'backend-build'], 42), undefined);
  });
});
