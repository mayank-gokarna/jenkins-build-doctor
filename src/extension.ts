import * as vscode from 'vscode';
import { Controller, type TestApi } from './vscode/controller';
import { createLogger } from './vscode/output';

let controller: Controller | undefined;

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  let knownSecrets: string[] = [];
  const { logger, channel } = createLogger(() => knownSecrets);
  context.subscriptions.push(channel);
  logger.info('Activating Jenkins Build Doctor', { version: context.extension.packageJSON.version as string, vscode: vscode.version });

  controller = new Controller(
    context,
    logger,
    () => channel.show(true),
    (secrets) => (knownSecrets = secrets),
  );
  context.subscriptions.push(controller);

  return context.extensionMode === vscode.ExtensionMode.Test ? controller.testApi() : undefined;
}

export function deactivate(): void {
  controller = undefined;
}
