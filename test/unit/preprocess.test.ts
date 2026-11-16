import * as assert from 'node:assert/strict';
import { attributeStages, cleanLines, MAX_LINE_LENGTH, stripAnsi } from '../../src/analysis/preprocess';
import { MAVEN_COMPILE_FAILURE } from '../fixtures/logs';

describe('preprocess', () => {
  it('strips ANSI colours and Jenkins console notes', () => {
    const raw = '\x1b[8mha:////4LVsdGVzdA==\x1b[0m[Pipeline] sh\n\x1b[31mERROR\x1b[0m: boom';
    assert.equal(stripAnsi(raw), '[Pipeline] sh\nERROR: boom');
  });

  it('removes timestamper prefixes and normalises line endings', () => {
    const lines = cleanLines('[2026-10-01T10:00:00.123Z] first\r\n12:00:01  second\nthird\n');
    assert.deepEqual(lines, ['first', 'second', 'third']);
  });

  it('truncates pathological lines', () => {
    const [line] = cleanLines('x'.repeat(MAX_LINE_LENGTH * 3));
    assert.ok(line.length < MAX_LINE_LENGTH + 50);
  });

  it('attributes lines to pipeline stages, ignoring anonymous blocks', () => {
    const lines = cleanLines(MAVEN_COMPILE_FAILURE);
    const { stageIndex, stageNames } = attributeStages(lines);
    const stageOf = (needle: string) => {
      const i = lines.findIndex((l) => l.includes(needle));
      return stageIndex[i] >= 0 ? stageNames[stageIndex[i]] : undefined;
    };
    assert.equal(stageOf('Checking out Revision'), 'Checkout');
    assert.equal(stageOf('cannot find symbol'), 'Build');
    assert.equal(stageOf('skipped due to earlier failure'), 'Test');
    assert.equal(stageOf('Finished: FAILURE'), undefined);
  });

  it('labels nested parallel branches', () => {
    const lines = ['[Pipeline] { (Tests)', '[Pipeline] parallel', '[Pipeline] { (Branch: unit)', 'unit output', '[Pipeline] }', '[Pipeline] }', 'after'];
    const { stageIndex, stageNames } = attributeStages(lines);
    assert.equal(stageNames[stageIndex[3]], 'Tests › Branch: unit');
    assert.equal(stageIndex[6], -1);
  });
});
