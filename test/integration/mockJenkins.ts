import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { K8S_IMAGE_PULL, MAVEN_COMPILE_FAILURE } from '../fixtures/logs';

export const MOCK_USER = 'alice';
export const MOCK_TOKEN = 'token-1234567890abcdef';

type Handler = (url: URL) => { status?: number; json?: unknown; text?: string } | undefined;

const now = Date.UTC(2026, 9, 1, 12, 0, 0);
const build = (number: number, result: string | null, building = false) => ({ number, result, building, timestamp: now - number * 60_000, duration: 95_000 });

/**
 * A small in-process Jenkins imitation covering the endpoints the extension uses:
 * nested folders, a multibranch project, builds, console logs, test reports and wfapi stages.
 */
export const ROUTES: Record<string, Handler> = {
  '/api/json': () => ({
    json: {
      _class: 'hudson.model.Hudson',
      jobs: [
        { _class: 'com.cloudbees.hudson.plugins.folder.Folder', name: 'team-a', displayName: 'Team A', jobs: [{ name: 'x' }] },
        { _class: 'org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject', name: 'app', displayName: 'app', jobs: [] },
        { _class: 'hudson.model.FreeStyleProject', name: 'nightly', displayName: 'nightly', color: 'blue', lastBuild: build(10, 'SUCCESS') },
      ],
    },
  }),
  '/me/api/json': () => ({ json: { id: MOCK_USER, fullName: 'Alice' } }),
  '/job/team-a/api/json': () => ({
    json: {
      jobs: [
        { _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob', name: 'backend-build', displayName: 'backend-build', color: 'red', lastBuild: build(42, 'FAILURE') },
        { _class: 'com.cloudbees.hudson.plugins.folder.Folder', name: 'nested', displayName: 'nested', jobs: [] },
        { bogus: true },
      ],
    },
  }),
  '/job/team-a/job/nested/api/json': () => ({
    json: { jobs: [{ _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob', name: 'deploy-prod', displayName: 'deploy-prod', color: 'red_anime' }] },
  }),
  '/job/app/api/json': () => ({
    json: {
      jobs: [
        { _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob', name: 'main', displayName: 'main', color: 'blue' },
        { _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob', name: 'feature%2Flogin', displayName: 'feature/login', color: 'yellow' },
      ],
    },
  }),
  '/job/team-a/job/backend-build/api/json': (url) =>
    url.searchParams.get('tree')?.includes('builds[')
      ? {
          json: {
            _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob',
            name: 'backend-build',
            displayName: 'backend-build',
            color: 'red',
            builds: [build(42, 'FAILURE'), build(41, 'SUCCESS'), build(43, null, true)],
            lastFailedBuild: { number: 42 },
            lastUnsuccessfulBuild: { number: 42 },
          },
        }
      : undefined,
  '/job/team-a/job/backend-build/42/api/json': () => ({
    json: {
      ...build(42, 'FAILURE'),
      fullDisplayName: 'Team A » backend-build #42',
      builtOn: 'agent-linux-01',
      actions: [
        { causes: [{ shortDescription: 'Started by user Alice' }] },
        { parameters: [{ name: 'ENV', value: 'staging' }, { name: 'API_TOKEN', value: 'should-not-show' }] },
        { lastBuiltRevision: { SHA1: '3f2a9c1d000', branch: [{ name: 'refs/remotes/origin/main' }] }, remoteUrls: ['https://git.example.com/team/backend.git'] },
      ],
      changeSets: [{ items: [{ msg: 'Refactor PriceCalculator', commitId: '3f2a9c1d000', author: { fullName: 'Bob' } }] }],
    },
  }),
  '/job/team-a/job/backend-build/42/consoleText': () => ({ text: MAVEN_COMPILE_FAILURE }),
  '/job/team-a/job/backend-build/42/testReport/api/json': () => ({ status: 404, text: 'Not found' }),
  '/job/team-a/job/backend-build/42/wfapi/describe': () => ({
    json: {
      stages: [
        { id: '6', name: 'Checkout', status: 'SUCCESS', durationMillis: 3000 },
        { id: '12', name: 'Build', status: 'FAILED', durationMillis: 60000, error: { type: 'hudson.AbortException', message: 'script returned exit code 1' } },
        { id: '20', name: 'Test', status: 'NOT_EXECUTED', durationMillis: 0 },
      ],
    },
  }),
  '/job/team-a/job/nested/job/deploy-prod/api/json': () => ({
    json: { name: 'deploy-prod', color: 'red', builds: [build(7, 'FAILURE')], lastFailedBuild: { number: 7 } },
  }),
  '/job/team-a/job/nested/job/deploy-prod/7/api/json': () => ({ json: { ...build(7, 'FAILURE'), actions: [] } }),
  '/job/team-a/job/nested/job/deploy-prod/7/consoleText': () => ({ text: K8S_IMAGE_PULL }),
  '/job/team-a/job/nested/job/deploy-prod/7/testReport/api/json': () => ({ status: 404 }),
  '/job/team-a/job/nested/job/deploy-prod/7/wfapi/describe': () => ({
    json: { stages: [{ id: '5', name: 'Deploy', status: 'FAILED', durationMillis: 130000 }] },
  }),
  '/job/app/job/feature%252Flogin/api/json': () => ({ json: { name: 'feature%2Flogin', color: 'yellow', builds: [build(3, 'UNSTABLE')] } }),
  '/job/app/job/feature%252Flogin/3/api/json': () => ({ json: { ...build(3, 'UNSTABLE'), actions: [{ failCount: 1, skipCount: 0, totalCount: 20 }] } }),
  '/job/app/job/feature%252Flogin/3/consoleText': () => ({
    text: '[Pipeline] { (Test)\n+ npm test\nTests:       1 failed, 19 passed, 20 total\n[Pipeline] }\nFinished: UNSTABLE\n',
  }),
  '/job/app/job/feature%252Flogin/3/testReport/api/json': () => ({
    json: {
      failCount: 1,
      passCount: 19,
      skipCount: 0,
      suites: [
        {
          name: 'login',
          cases: [
            { className: 'login.spec', name: 'rejects bad password', status: 'FAILED', errorDetails: 'expected 401 but got 500', errorStackTrace: 'Error: expected 401\n    at login.spec.ts:12' },
            { className: 'login.spec', name: 'accepts good password', status: 'PASSED' },
          ],
        },
      ],
    },
  }),
  '/job/app/job/feature%252Flogin/3/wfapi/describe': () => ({ json: { stages: [{ id: '1', name: 'Test', status: 'UNSTABLE' }] } }),
  '/redirect-elsewhere/api/json': () => ({ status: 302, text: '' }),
};

export interface MockJenkins {
  url: string;
  requests: { path: string; auth?: string }[];
  close(): Promise<void>;
}

export async function startMockJenkins(contextPath = ''): Promise<MockJenkins> {
  const requests: MockJenkins['requests'] = [];
  const expectedAuth = `Basic ${Buffer.from(`${MOCK_USER}:${MOCK_TOKEN}`).toString('base64')}`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push({ path: url.pathname, auth: req.headers.authorization });
    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401, { 'Content-Type': 'text/html' }).end('<html>Unauthorized</html>');
      return;
    }
    if (!url.pathname.startsWith(`${contextPath}/`)) {
      res.writeHead(404).end();
      return;
    }
    const route = url.pathname.slice(contextPath.length);
    if (route === '/redirect-elsewhere/api/json') {
      res.writeHead(302, { Location: 'http://evil.example.com/steal' }).end();
      return;
    }
    const result = ROUTES[route]?.(url);
    if (!result) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found');
      return;
    }
    const headers: Record<string, string> = { 'X-Jenkins': '2.462.3' };
    if (result.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      res.writeHead(result.status ?? 200, headers).end(JSON.stringify(result.json));
    } else {
      headers['Content-Type'] = 'text/plain; charset=utf-8';
      res.writeHead(result.status ?? 200, headers).end(result.text ?? '');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${contextPath}/`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
