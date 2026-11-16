import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import * as zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { BodyCollector, httpRequest } from '../../src/core/http';

describe('BodyCollector', () => {
  it('keeps head and tail of oversized bodies', () => {
    const c = new BodyCollector({ headBytes: 10, tailBytes: 20 }, 0);
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}\n`).join('');
    for (let i = 0; i < lines.length; i += 7) {
      c.push(Buffer.from(lines.slice(i, i + 7)));
    }
    const out = c.result().toString();
    assert.ok(c.truncated);
    assert.ok(out.startsWith('line0\nline'));
    assert.ok(out.endsWith('line98\nline99\n'));
    assert.match(out, /console log truncated/);
  });

  it('returns small bodies untouched', () => {
    const c = new BodyCollector({ headBytes: 10, tailBytes: 100 }, 0);
    c.push(Buffer.from('hello world, this is short'));
    assert.equal(c.result().toString(), 'hello world, this is short');
    assert.equal(c.truncated, false);
  });

  it('enforces the hard cap in non-truncating mode', () => {
    const c = new BodyCollector(undefined, 5);
    assert.equal(c.push(Buffer.from('1234')), true);
    assert.equal(c.push(Buffer.from('56')), false);
  });
});

describe('httpRequest', () => {
  let server: http.Server;
  let base: string;
  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/gzip') {
        res.writeHead(200, { 'Content-Encoding': 'gzip' }).end(zlib.gzipSync('compressed body'));
      } else if (req.url === '/same-origin-redirect') {
        res.writeHead(302, { Location: '/gzip' }).end();
      } else if (req.url === '/cross-origin-redirect') {
        res.writeHead(302, { Location: 'http://example.invalid/' }).end();
      } else if (req.url === '/slow') {
        setTimeout(() => res.end('late'), 2000);
      } else {
        res.end('ok');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it('decompresses gzip', async () => {
    const res = await httpRequest({ url: `${base}/gzip`, timeoutMs: 2000 });
    assert.equal(res.body.toString(), 'compressed body');
  });

  it('follows same-origin redirects only', async () => {
    assert.equal((await httpRequest({ url: `${base}/same-origin-redirect`, timeoutMs: 2000 })).body.toString(), 'compressed body');
    await assert.rejects(httpRequest({ url: `${base}/cross-origin-redirect`, timeoutMs: 2000 }), (e: Error & { code?: string }) => e.code === 'redirect');
  });

  it('times out and supports cancellation', async () => {
    await assert.rejects(httpRequest({ url: `${base}/slow`, timeoutMs: 100 }), (e: Error & { code?: string }) => e.code === 'timeout');
    const ctrl = new AbortController();
    const p = httpRequest({ url: `${base}/slow`, timeoutMs: 5000, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 50);
    await assert.rejects(p, (e: Error & { code?: string }) => e.code === 'aborted');
  });

  it('enforces size limits', async () => {
    await assert.rejects(httpRequest({ url: `${base}/gzip`, timeoutMs: 2000, maxBytes: 3 }), (e: Error & { code?: string }) => e.code === 'too_large');
  });
});
