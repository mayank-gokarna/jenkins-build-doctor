import * as vscode from 'vscode';
import { type Logger, StructuredLogger } from '../core/logger';
import { Redactor } from '../core/redact';

/**
 * Creates the extension logger backed by a LogOutputChannel (level controlled by the user
 * via "Developer: Set Log Level"). Every line is redacted before it is written.
 */
export function createLogger(getKnownSecrets: () => string[]): { logger: Logger; channel: vscode.LogOutputChannel } {
  const channel = vscode.window.createOutputChannel('Jenkins Build Doctor', { log: true });
  let cachedKey = '';
  let redactor = new Redactor();
  const redact = (text: string) => {
    const secrets = getKnownSecrets();
    const key = secrets.join('\u0000');
    if (key !== cachedKey) {
      cachedKey = key;
      redactor = new Redactor({ knownSecrets: secrets });
    }
    return redactor.redactString(text);
  };
  const logger = new StructuredLogger(
    (level, line) => {
      switch (level) {
        case 'trace':
          channel.trace(line);
          break;
        case 'debug':
          channel.debug(line);
          break;
        case 'info':
          channel.info(line);
          break;
        case 'warn':
          channel.warn(line);
          break;
        case 'error':
          channel.error(line);
          break;
      }
    },
    '',
    { redact },
  );
  return { logger, channel };
}
