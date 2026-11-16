import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

/**
 * Launches a VS Code instance with the extension under development and runs the suite in
 * ./suite. Set VSCODE_EXECUTABLE to use an installed VS Code instead of downloading one
 * (useful behind restrictive proxies).
 */
async function main(): Promise<void> {
  // When launched from a VS Code terminal this is inherited and would start Code.exe as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jbd-user-'));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jbd-ext-'));
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || undefined,
      launchArgs: ['--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${userDataDir}`, `--extensions-dir=${extensionsDir}`],
    });
  } catch (err) {
    process.stderr.write(`Extension host tests failed: ${String(err)}\n`);
    process.exit(1);
  }
}

void main();
