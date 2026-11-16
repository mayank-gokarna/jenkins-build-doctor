import * as assert from 'node:assert/strict';
import { classifyJob, colorToStatus, JenkinsResponseError, parseBuildDetails, parseJobs, parseJson, parseStages, parseTestReport } from '../../src/jenkins/parse';
import { buildUrl, displayPath, isInsecureRemote, jobUrl, normalizeBaseUrl } from '../../src/jenkins/paths';

describe('Jenkins response parsing', () => {
  it('classifies job types', () => {
    assert.equal(classifyJob('com.cloudbees.hudson.plugins.folder.Folder', true), 'folder');
    assert.equal(classifyJob('org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject', true), 'multibranch');
    assert.equal(classifyJob('jenkins.branch.OrganizationFolder', true), 'organization');
    assert.equal(classifyJob('org.jenkinsci.plugins.workflow.job.WorkflowJob', false), 'pipeline');
    assert.equal(classifyJob('hudson.model.FreeStyleProject', false), 'freestyle');
    assert.equal(classifyJob('com.example.CustomContainer', true), 'folder');
  });

  it('maps ball colours to statuses', () => {
    assert.equal(colorToStatus('blue'), 'success');
    assert.equal(colorToStatus('red_anime'), 'building');
    assert.equal(colorToStatus('yellow'), 'unstable');
    assert.equal(colorToStatus('notbuilt'), 'never');
    assert.equal(colorToStatus(undefined), 'unknown');
  });

  it('drops malformed jobs and rejects names containing slashes', () => {
    const jobs = parseJobs({ jobs: [{ name: 'ok', _class: 'hudson.model.FreeStyleProject', color: 'red' }, { nope: 1 }, { name: 'a/b' }, 'junk'] }, ['root']);
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0].path, ['root', 'ok']);
    assert.equal(jobs[0].status, 'failure');
    assert.throws(() => parseJobs([], []), JenkinsResponseError);
  });

  it('detects HTML (SSO/login pages) instead of JSON', () => {
    assert.throws(() => parseJson('<!DOCTYPE html><html>', 'x'), /received HTML/);
    assert.throws(() => parseJson('{bad', 'x'), /Invalid JSON/);
  });

  it('parses build details and masks sensitive parameters', () => {
    const b = parseBuildDetails({
      number: 5,
      result: 'FAILURE',
      building: false,
      actions: [
        {},
        { causes: [{ shortDescription: 'Started by timer' }] },
        {
          parameters: [
            { name: 'ENV', value: 'prod' },
            { name: 'DB_PASSWORD', value: 'x' },
            { _class: 'hudson.model.PasswordParameterValue', name: 'other' },
          ],
        },
        { failCount: 2, skipCount: 1, totalCount: 10 },
      ],
    });
    assert.equal(b.status, 'failure');
    assert.deepEqual(b.causes, ['Started by timer']);
    assert.deepEqual(
      b.parameters.map((p) => [p.name, p.value]),
      [
        ['ENV', 'prod'],
        ['DB_PASSWORD', '******'],
        ['other', '******'],
      ],
    );
    assert.deepEqual(b.testCounts, { failed: 2, skipped: 1, total: 10 });
    assert.throws(() => parseBuildDetails({ result: 'FAILURE' }), JenkinsResponseError);
  });

  it('parses test reports including child reports', () => {
    const r = parseTestReport({
      failCount: 1,
      passCount: 1,
      suites: [{ name: 's', cases: [{ name: 't1', status: 'FAILED', errorDetails: 'boom' }, { name: 't2', status: 'PASSED' }] }],
      childReports: [{ result: { failCount: 1, suites: [{ cases: [{ name: 't3', status: 'REGRESSION' }] }] } }],
    });
    assert.deepEqual(
      r.failures.map((f) => f.name),
      ['t1', 't3'],
    );
    assert.equal(r.failCount, 2);
  });

  it('parses wfapi stages', () => {
    const s = parseStages({ stages: [{ id: '1', name: 'Build', status: 'FAILED', error: { type: 'AbortException', message: 'exit 1' } }, { bad: true }] });
    assert.equal(s.length, 1);
    assert.equal(s[0].error, 'AbortException: exit 1');
  });
});

describe('URL construction', () => {
  it('normalises base URLs and rejects embedded credentials', () => {
    assert.equal(normalizeBaseUrl(' https://ci.example.com/jenkins '), 'https://ci.example.com/jenkins/');
    assert.throws(() => normalizeBaseUrl('ftp://x'), /http/);
    assert.throws(() => normalizeBaseUrl('https://u:p@ci.example.com'), /credentials/);
  });

  it('encodes nested folder and multibranch branch names', () => {
    assert.equal(jobUrl('https://ci/', ['team a', 'app', 'feature%2Flogin']), 'https://ci/job/team%20a/job/app/job/feature%252Flogin/');
    assert.equal(buildUrl('https://ci/', ['x'], 7), 'https://ci/job/x/7/');
    assert.throws(() => buildUrl('https://ci/', ['x'], -1));
    assert.equal(displayPath(['app', 'feature%2Flogin']), 'app / feature/login');
  });

  it('flags plain-http remote servers', () => {
    assert.equal(isInsecureRemote('http://ci.example.com/'), true);
    assert.equal(isInsecureRemote('http://localhost:8080/'), false);
    assert.equal(isInsecureRemote('https://ci.example.com/'), false);
  });
});
