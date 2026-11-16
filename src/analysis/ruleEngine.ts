import type { RuleDefinition, RuleMatch } from './types';

export interface CompiledRule {
  def: RuleDefinition;
  regexes: RegExp[];
}

export function compileRules(defs: readonly RuleDefinition[]): CompiledRule[] {
  return defs.map((def) => ({
    def,
    regexes: def.patterns.map((p) => {
      const flags = new Set(p.flags.split(''));
      flags.add('g');
      flags.add('m');
      flags.delete('y');
      return new RegExp(p.source, [...flags].join(''));
    }),
  }));
}

export class CancelledError extends Error {
  constructor() {
    super('Analysis cancelled');
    this.name = 'CancelledError';
  }
}

export interface ScanOptions {
  maxMatchesPerRule?: number;
  signal?: AbortSignal;
}

/**
 * Runs every rule over the whole log. Each regex is executed against the joined text
 * (much faster than per-line testing for large logs) and matches are mapped back to lines.
 * At most one match per line per regex is recorded. Yields to the event loop between rules
 * so the extension host stays responsive.
 */
export async function scanLines(lines: readonly string[], rules: readonly CompiledRule[], options: ScanOptions = {}): Promise<Map<string, RuleMatch[]>> {
  const max = options.maxMatchesPerRule ?? 200;
  const text = lines.join('\n');
  const starts = new Int32Array(lines.length + 1);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = offset;
    offset += lines[i].length + 1;
  }
  starts[lines.length] = offset;

  const lineOf = (index: number): number => {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  };

  const results = new Map<string, RuleMatch[]>();
  for (const rule of rules) {
    if (options.signal?.aborted) {
      throw new CancelledError();
    }
    const matches: RuleMatch[] = [];
    const seenLines = new Set<number>();
    for (const regex of rule.regexes) {
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while (matches.length < max && (m = regex.exec(text)) !== null) {
        if (m[0].length === 0) {
          regex.lastIndex++;
          continue;
        }
        const line = lineOf(m.index);
        // Continue scanning from the next line.
        regex.lastIndex = Math.max(regex.lastIndex, starts[line + 1]);
        if (seenLines.has(line)) {
          continue;
        }
        const lineText = lines[line];
        if (rule.def.exclude && rule.def.exclude.test(lineText)) {
          continue;
        }
        seenLines.add(line);
        matches.push({ line: line + 1, text: lineText, match: m[0], groups: m.slice(1) });
      }
    }
    if (matches.length > 0) {
      matches.sort((a, b) => a.line - b.line);
      results.set(rule.def.id, matches);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return results;
}

/** Fills `{0}`, `{1}`… and `{g}` placeholders from a match. */
export function fillTemplate(template: string, match: RuleMatch | undefined): string {
  const clip = (s: string) => {
    const t = s.trim();
    return t.length > 240 ? `${t.slice(0, 240)}…` : t;
  };
  if (!match) {
    return template.replace(/\{(?:\d+|g)\}/g, '').replace(/\s*[:—-]\s*$/, '').trim();
  }
  const filled = template.replace(/\{(\d+|g)\}/g, (_m, key: string) => {
    if (key === 'g') {
      return clip(match.groups.find((g) => g !== undefined && g.trim() !== '') ?? match.match);
    }
    const idx = Number(key);
    if (idx === 0) {
      return clip(match.match);
    }
    return clip(match.groups[idx - 1] ?? '');
  });
  return filled.replace(/\s+/g, ' ').trim();
}
