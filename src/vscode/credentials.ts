import type * as vscode from 'vscode';

/**
 * All secrets live in VS Code SecretStorage (OS keychain backed). Nothing secret is written
 * to settings, globalState or logs.
 */
export class CredentialStore {
  private static readonly PREFIX = 'jenkinsBuildDoctor.';

  constructor(private readonly secrets: vscode.SecretStorage) {}

  private jenkinsKey(baseUrl: string, username: string): string {
    return `${CredentialStore.PREFIX}jenkinsToken|${baseUrl}|${username}`;
  }

  getJenkinsToken(baseUrl: string, username: string): Thenable<string | undefined> {
    return this.secrets.get(this.jenkinsKey(baseUrl, username));
  }

  setJenkinsToken(baseUrl: string, username: string, token: string): Thenable<void> {
    return this.secrets.store(this.jenkinsKey(baseUrl, username), token);
  }

  deleteJenkinsToken(baseUrl: string, username: string): Thenable<void> {
    return this.secrets.delete(this.jenkinsKey(baseUrl, username));
  }

  get(name: AiSecretName): Thenable<string | undefined> {
    return this.secrets.get(CredentialStore.PREFIX + name);
  }

  set(name: AiSecretName, value: string): Thenable<void> {
    return this.secrets.store(CredentialStore.PREFIX + name, value);
  }

  delete(name: AiSecretName): Thenable<void> {
    return this.secrets.delete(CredentialStore.PREFIX + name);
  }

  onDidChange(listener: () => void): vscode.Disposable {
    return this.secrets.onDidChange((e) => {
      if (e.key.startsWith(CredentialStore.PREFIX)) {
        listener();
      }
    });
  }
}

export type AiSecretName =
  | 'ai.bedrock.apiKey'
  | 'ai.bedrock.accessKeyId'
  | 'ai.bedrock.secretAccessKey'
  | 'ai.bedrock.sessionToken'
  | 'ai.openaiCompatible.apiKey';
