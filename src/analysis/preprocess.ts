/**
 * Turns a raw Jenkins console log into clean lines with pipeline-stage attribution.
 */

// Jenkins ConsoleNote annotations: ESC[8mha:////<base64>ESC[0m
const CONSOLE_NOTE = /\x1b\[8mha:[^\x1b]*\x1b\[0m/g;
// CSI / OSC escape sequences.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// Timestamper plugin prefixes, e.g. "[2024-05-01T10:00:00.123Z] " or "10:00:00  ".
const TIMESTAMP_PREFIX = /^(?:\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\][ \t]?|\d{2}:\d{2}:\d{2}(?:\.\d+)?[ \t]{1,2})/;
const STAGE_OPEN = /^\[Pipeline\] \{ \((.+)\)$/;
const BLOCK_OPEN = /^\[Pipeline\] \{$/;
const BLOCK_CLOSE = /^\[Pipeline\] \}$/;

export const MAX_LINE_LENGTH = 4000;

export interface ProcessedLog {
  lines: string[];
  /** Index into `stageNames` for every line, or -1 when outside any stage. */
  stageIndex: Int32Array;
  stageNames: string[];
}

export function stripAnsi(text: string): string {
  return text.replace(CONSOLE_NOTE, '').replace(ANSI, '');
}

export function cleanLines(raw: string): string[] {
  const text = stripAnsi(raw).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i].replace(TIMESTAMP_PREFIX, '');
    if (l.length > MAX_LINE_LENGTH) {
      l = `${l.slice(0, MAX_LINE_LENGTH)} …[line truncated]`;
    }
    lines[i] = l;
  }
  return lines;
}

/** Attributes lines to pipeline stages using the `[Pipeline] { (Stage)` block markers. */
export function attributeStages(lines: readonly string[]): { stageIndex: Int32Array; stageNames: string[] } {
  const stageIndex = new Int32Array(lines.length).fill(-1);
  const stageNames: string[] = [];
  const nameToIndex = new Map<string, number>();
  // Stack entries: stage label, or null for an anonymous block (node, withEnv, …).
  const stack: (string | null)[] = [];
  let current = -1;

  const recompute = () => {
    const named = stack.filter((s): s is string => s !== null);
    if (named.length === 0) {
      current = -1;
      return;
    }
    const label = named.join(' › ');
    let idx = nameToIndex.get(label);
    if (idx === undefined) {
      idx = stageNames.length;
      stageNames.push(label);
      nameToIndex.set(label, idx);
    }
    current = idx;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('[Pipeline] ')) {
      const open = STAGE_OPEN.exec(line);
      if (open) {
        stack.push(open[1]);
        recompute();
      } else if (BLOCK_OPEN.test(line)) {
        stack.push(null);
      } else if (BLOCK_CLOSE.test(line)) {
        stageIndex[i] = current;
        stack.pop();
        recompute();
        continue;
      }
    }
    stageIndex[i] = current;
  }
  return { stageIndex, stageNames };
}

export function processLog(raw: string): ProcessedLog {
  const lines = cleanLines(raw);
  return { lines, ...attributeStages(lines) };
}
