/**
 * URL construction. Job URLs are always built from the configured base URL plus encoded
 * job names, never taken from the `url` fields Jenkins returns. Jenkins' self-reported URLs
 * are frequently wrong behind proxies, and trusting them could send credentials to
 * another host.
 */

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  const url = new URL(trimmed);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Jenkins URL must start with http:// or https://');
  }
  if (url.username || url.password) {
    throw new Error('Do not put credentials in the URL; use the username and API token fields.');
  }
  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/';
  }
  return url.toString();
}

export function jobRelativePath(path: readonly string[]): string {
  return path.map((segment) => `job/${encodeURIComponent(segment)}/`).join('');
}

export function jobUrl(baseUrl: string, path: readonly string[]): string {
  return baseUrl + jobRelativePath(path);
}

export function buildUrl(baseUrl: string, path: readonly string[], buildNumber: number): string {
  if (!Number.isInteger(buildNumber) || buildNumber < 0) {
    throw new Error(`Invalid build number: ${buildNumber}`);
  }
  return `${jobUrl(baseUrl, path)}${buildNumber}/`;
}

/** Human readable job name (decodes branch names like `feature%2Fx`). */
export function displayPath(path: readonly string[]): string {
  return path.map(safeDecode).join(' / ');
}

export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** True for http:// URLs that are not loopback, where credentials would travel in clear text. */
export function isInsecureRemote(baseUrl: string): boolean {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:') {
    return false;
  }
  return !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
}
