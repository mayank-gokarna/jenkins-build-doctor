import type { Category, Certainty, RuleDefinition } from '../types';
import { ACCESS_RULES } from './access';
import { BUILD_RULES } from './build';
import { PIPELINE_RULES } from './pipeline';
import { PLATFORM_RULES } from './platform';

export const BUILT_IN_RULES: readonly RuleDefinition[] = [...BUILD_RULES, ...ACCESS_RULES, ...PLATFORM_RULES, ...PIPELINE_RULES];

const CATEGORIES: readonly Category[] = [
  'compilation',
  'test',
  'dependency',
  'authentication',
  'infrastructure',
  'resource',
  'kubernetes',
  'deployment',
  'docker',
  'scm',
  'pipeline',
  'configuration',
  'quality',
  'timeout',
  'generic',
];

/** Shape of a rule in the `jenkinsBuildDoctor.analysis.customRules` setting. */
export interface CustomRuleConfig {
  id?: unknown;
  title?: unknown;
  category?: unknown;
  pattern?: unknown;
  flags?: unknown;
  certainty?: unknown;
  weight?: unknown;
  summary?: unknown;
  causes?: unknown;
  remediation?: unknown;
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 20) : []);

/** Validates user-defined rules. Invalid entries are reported, never thrown. */
export function compileCustomRules(raw: unknown): { rules: RuleDefinition[]; errors: string[] } {
  const rules: RuleDefinition[] = [];
  const errors: string[] = [];
  if (!Array.isArray(raw)) {
    return { rules, errors };
  }
  raw.forEach((entry: CustomRuleConfig, i) => {
    const label = typeof entry?.id === 'string' ? entry.id : `#${i + 1}`;
    if (typeof entry !== 'object' || entry === null || typeof entry.id !== 'string' || typeof entry.title !== 'string' || typeof entry.pattern !== 'string') {
      errors.push(`Custom rule ${label}: "id", "title" and "pattern" are required strings.`);
      return;
    }
    const flags = typeof entry.flags === 'string' ? entry.flags.replace(/[^imsu]/g, '') : 'i';
    let regex: RegExp;
    try {
      regex = new RegExp(entry.pattern, flags);
    } catch (e) {
      errors.push(`Custom rule ${label}: invalid regular expression (${(e as Error).message}).`);
      return;
    }
    if (regex.test('')) {
      errors.push(`Custom rule ${label}: pattern matches the empty string.`);
      return;
    }
    const category = CATEGORIES.includes(entry.category as Category) ? (entry.category as Category) : 'generic';
    const certainty: Certainty = entry.certainty === 'hypothesis' ? 'hypothesis' : 'confirmed';
    const weight = typeof entry.weight === 'number' && entry.weight >= 1 && entry.weight <= 100 ? entry.weight : 85;
    rules.push({
      id: `custom.${entry.id}`,
      title: entry.title,
      category,
      certainty,
      weight,
      patterns: [regex],
      summary: typeof entry.summary === 'string' ? entry.summary : '{0}',
      causes: strList(entry.causes),
      remediation: strList(entry.remediation),
    });
  });
  return { rules, errors };
}
