import * as assert from 'node:assert/strict';
import { MASK, Redactor } from '../../src/core/redact';
import { StructuredLogger } from '../../src/core/logger';
import { WITH_SECRETS } from '../fixtures/logs';

describe('Redactor', () => {
  const r = new Redactor({ knownSecrets: ['my-jenkins-token-value'] });

  it('redacts common secret formats', () => {
    const out = r.redactString(WITH_SECRETS);
    for (const secret of ['abcDEF123456ghiJKL', 'hunter2secret', 'SuperSecret123', 'AKIAIOSFODNN7EXAMPLE', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB', 'MIIEowIBAAKCAQEAx']) {
      assert.ok(!out.includes(secret), `leaked ${secret}`);
    }
    assert.ok(out.includes(`https://${MASK}:${MASK}@git.example.com/repo.git`));
    assert.ok(out.includes('[REDACTED PRIVATE KEY]'));
  });

  it('preserves line count so evidence line numbers stay valid', () => {
    const out = r.redactString(WITH_SECRETS);
    assert.equal(out.split('\n').length, WITH_SECRETS.split('\n').length);
    assert.equal(out.split('\n')[9], 'after key');
  });

  it('redacts known secrets verbatim', () => {
    assert.equal(r.redactString('echo my-jenkins-token-value done'), `echo ${MASK} done`);
  });

  it('counts redactions and leaves ordinary text alone', () => {
    const plain = 'Tests run: 10, Failures: 0\n[INFO] BUILD SUCCESS\nTokenizer loaded';
    const res = r.redact(plain);
    assert.equal(res.text, plain);
    assert.equal(res.count, 0);
    assert.ok(r.redact('password=abc12345').count >= 1);
  });

  it('masks JSON-style and CLI-flag secrets', () => {
    assert.ok(!r.redactString('{"apiKey": "zzzz-1111-yyyy"}').includes('zzzz-1111-yyyy'));
    assert.ok(!r.redactString('mytool --token s3cr3tvalue --verbose').includes('s3cr3tvalue'));
    assert.ok(!r.redactString('docker login -u ci -p Pa55word registry.example.com').includes('Pa55word'));
  });

  it('applies valid extra patterns and reports invalid ones', () => {
    const custom = new Redactor({ extraPatterns: ['ACME-[0-9]{6}', '(', '.*'] });
    assert.deepEqual(custom.invalidPatterns, ['(', '.*']);
    assert.equal(custom.redactString('id ACME-123456 ok'), `id ${MASK} ok`);
  });
});

describe('StructuredLogger', () => {
  it('formats fields and redacts the final line', () => {
    const lines: string[] = [];
    const redactor = new Redactor({ knownSecrets: ['supersecrettoken'] });
    const logger = new StructuredLogger((level, line) => lines.push(`${level}:${line}`), 'root', { redact: (t) => redactor.redactString(t) });
    logger.child('jenkins').info('GET', { status: 200, header: 'Basic supersecrettoken' });
    logger.error('boom', new Error('bad thing'));
    assert.equal(lines[0], `info:[root.jenkins] GET {"status":200,"header":"Basic ${MASK}"}`);
    assert.match(lines[1], /^error:\[root\] boom \{"error":\{"name":"Error","message":"bad thing"\}\}$/);
  });
});
