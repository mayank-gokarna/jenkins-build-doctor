import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/vscode/controller';
import { MAVEN_COMPILE_FAILURE } from '../../fixtures/logs';
import { MOCK_TOKEN, MOCK_USER, startMockJenkins, type MockJenkins } from '../mockJenkins';

const EXTENSION_ID = 'jenkins-build-doctor.jenkins-build-doctor';

describe('Extension (VS Code extension host)', () => {
  let api: TestApi;
  let jenkins: MockJenkins;

  before(async () => {
    jenkins = await startMockJenkins();
    const ext = vscode.extensions.getExtension<TestApi>(EXTENSION_ID);
    assert.ok(ext, 'extension is installed');
    api = (await ext.activate())!;
    assert.ok(api, 'test API exposed in test mode');
    const config = vscode.workspace.getConfiguration('jenkinsBuildDoctor');
    await config.update('server.url', jenkins.url, vscode.ConfigurationTarget.Global);
    await config.update('server.username', MOCK_USER, vscode.ConfigurationTarget.Global);
    await api.setToken(MOCK_TOKEN);
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await jenkins.close();
  });

  it('registers all contributed commands', async () => {
    const all = await vscode.commands.getCommands(true);
    const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON as { contributes: { commands: { command: string }[] } };
    for (const { command } of pkg.contributes.commands) {
      assert.ok(all.includes(command), `${command} registered`);
    }
  });

  it('never stores the token in settings', () => {
    const inspect = JSON.stringify(vscode.workspace.getConfiguration('jenkinsBuildDoctor'));
    assert.ok(!inspect.includes(MOCK_TOKEN));
  });

  it('populates the job tree, including nested folders and builds', async () => {
    const root = await api.getChildren();
    assert.deepEqual(
      root.map((n) => (n.type === 'message' ? `msg:${n.label}` : `${n.type}:${n.job.name}`)),
      ['folder:app', 'folder:team-a', 'job:nightly'],
    );
    const teamA = root.find((n) => n.type === 'folder' && n.job.name === 'team-a')!;
    const children = await api.getChildren(teamA);
    const job = children.find((n) => n.type === 'job')!;
    const builds = await api.getChildren(job);
    assert.deepEqual(
      builds.map((b) => (b.type === 'build' ? b.build.number : -1)),
      [43, 42, 41],
    );
  });

  it('diagnoses a build from Jenkins and opens the diagnosis panel', async () => {
    const d = await api.diagnose(['team-a', 'backend-build'], 42);
    assert.equal(d?.primary?.ruleId, 'compile.jvm');
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label);
    assert.ok(tabs.some((t) => t.includes('backend-build #42')), `tabs: ${tabs.join(', ')}`);
  });

  it('analyses a log from text without Jenkins', async () => {
    const d = await api.analyzeText(MAVEN_COMPILE_FAILURE);
    assert.equal(d?.primary?.ruleId, 'compile.jvm');
  });
});
