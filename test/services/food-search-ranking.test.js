import { describe, it, expect } from 'vitest';
import { escapeLike, escapeRegex, tokenize, buildRelevanceOrder } from '../../src/helpers/food-search-ranking.js';

describe('food-search-ranking helpers', () => {
  it('should tokenize on whitespace and drop empties', () => {
    expect(tokenize('  ovo   cozido ')).toEqual(['ovo', 'cozido']);
    expect(tokenize(undefined)).toEqual([]);
  });

  it('should escape LIKE wildcards', () => {
    expect(escapeLike('50%_a\\')).toBe('50\\%\\_a\\\\');
  });

  it('should escape regex metacharacters', () => {
    expect(escapeRegex('a.b(c)+')).toBe('a\\.b\\(c\\)\\+');
  });

  it('should fall back to alphabetical order without tokens', () => {
    const order = buildRelevanceOrder('   ');

    expect(order.sql).toBe('ORDER BY f.name ASC');
    expect(order.values).toEqual([]);
  });

  it('should pass user input only as bound parameters', () => {
    const order = buildRelevanceOrder("o'vo; DROP");

    expect(order.sql).not.toContain('DROP');
    expect(order.values.some((value) => String(value).includes('DROP'))).toBe(true);
  });

  it('should bind a whole-word pattern per token, with the first token as prefix', () => {
    const { values } = buildRelevanceOrder('ovo cozido');

    expect(values).toContain('ovo%');
    expect(values).toContain(String.raw`\yovo\y`);
    expect(values).toContain(String.raw`\ycozido\y`);
  });

  it('should order by prefix, whole words, word count, length, composite, source, name', () => {
    const { sql } = buildRelevanceOrder('ovo');
    const positions = ['LIKE', ' ~ ', 'cardinality', 'char_length', 'CASE f.source', 'f.name ASC'].map((part) =>
      sql.indexOf(part),
    );

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('should rank custom before taco before tbca', () => {
    const { values } = buildRelevanceOrder('ovo');
    const sourceValues = values.filter((value) => ['custom', 'taco', 'tbca'].includes(value));

    expect(sourceValues).toEqual(['custom', 'taco', 'tbca']);
  });
});
