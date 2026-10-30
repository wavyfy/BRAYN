import { describe, expect, it } from 'vitest';
import { buildCustomerNotesContext, estimateTokens } from './customer-context-builder.service';

type Pref = Parameters<typeof buildCustomerNotesContext>[0][number];
type Mem = Parameters<typeof buildCustomerNotesContext>[1][number];

let seq = 0;
const at = (day: number) => new Date(Date.UTC(2026, 9, day));
const pref = (category: Pref['category'], content: string, day = 1): Pref => ({
  id: `p${++seq}`,
  workspaceId: 'ws',
  canonicalCustomerId: 'c',
  category,
  content,
  provenance: 'merchant_provided',
  status: 'active',
  createdByUserId: 'u',
  archivedAt: null,
  createdAt: at(day),
  updatedAt: at(day),
});
const mem = (content: string, day = 1): Mem => ({
  id: `m${String(++seq).padStart(4, '0')}`,
  workspaceId: 'ws',
  canonicalCustomerId: 'c',
  content,
  provenance: 'merchant_provided',
  status: 'active',
  createdByUserId: 'u',
  archivedAt: null,
  createdAt: at(day),
  updatedAt: at(day),
});
const BIG = 10_000;
const memoryLines = (block: string | null) => (block ?? '').split('Memory:\n')[1]?.split('\n').filter((l) => l.startsWith('- ')) ?? [];

describe('buildCustomerNotesContext', () => {
  it('returns no block for an empty context', () => {
    expect(buildCustomerNotesContext([], [], 'anything', BIG)).toEqual({ block: null, preferences: 0, memories: 0, omitted: 0 });
  });

  it('labels the block as unverified merchant notes and puts preferences before memory', () => {
    const { block } = buildCustomerNotesContext([pref('communication', 'Prefers email over SMS', 3)], [mem('Allergic to wool', 2)], 'q', BIG);

    expect(block).toMatch(/^CATEGORY: Merchant notes about this customer/);
    expect(block).toContain('NOT verified customer facts');
    expect(block).toContain('- [communication] Prefers email over SMS (recorded 2026-10-03)');
    expect(block!.indexOf('Preferences:')).toBeLessThan(block!.indexOf('Memory:'));
  });

  it('preference precedence: preferences take the budget first, and a memory repeating a preference is dropped', () => {
    const preference = pref('product', 'Only buys organic cotton');
    const result = buildCustomerNotesContext([preference], [mem('only buys   ORGANIC cotton'), mem('Long note '.repeat(40))], 'organic cotton', 140);

    expect(result.preferences).toBe(1);
    expect(memoryLines(result.block).some((l) => /organic/i.test(l))).toBe(false);
    // The long memory didn't fit after the preference took its share.
    expect(result.memories).toBe(0);
    expect(result.omitted).toBe(1);
  });

  it('ranks memories by keyword overlap with the question, then by most recent', () => {
    const memories = [mem('Likes gift wrap', 9), mem('Asked about delivery windows on weekends', 1), mem('Weekend delivery only, never weekdays', 2), mem('Prefers phone calls', 8)];
    const lines = memoryLines(buildCustomerNotesContext([], memories, 'Can we do weekend delivery?', BIG).block);

    // 2 matching words, then 1, then the non-matching ones newest first.
    expect(lines.map((l) => l.split(' (')[0])).toEqual([
      '- Weekend delivery only, never weekdays',
      '- Asked about delivery windows on weekends',
      '- Likes gift wrap',
      '- Prefers phone calls',
    ]);
  });

  it('with no keyword overlap, still includes the most recent memories first (recency fill)', () => {
    const lines = memoryLines(buildCustomerNotesContext([], [mem('Old note', 1), mem('Newest note', 5), mem('Middle note', 3)], 'xyz', BIG).block);
    expect(lines.map((l) => l.split(' (')[0])).toEqual(['- Newest note', '- Middle note', '- Old note']);
  });

  it('deduplicates: same category+content preferences keep the newest; repeated memories appear once', () => {
    const result = buildCustomerNotesContext(
      [pref('communication', 'Prefers email', 5), pref('communication', '  prefers EMAIL ', 1), pref('interaction', 'Prefers email', 4)],
      [mem('Gift wrap every order', 3), mem('gift wrap every   order', 2)],
      'q',
      BIG,
    );

    expect(result.preferences).toBe(2);
    expect(result.block).toContain('[communication] Prefers email (recorded 2026-10-05)');
    expect(result.block).not.toContain('2026-10-01');
    expect(result.block).toContain('[interaction] Prefers email');
    expect(result.memories).toBe(1);
    expect(result.omitted).toBe(0);
  });

  it('never exceeds the token budget, skips what does not fit, and says how many were left out', () => {
    const memories = Array.from({ length: 30 }, (_, i) => mem(`Note number ${i} about this customer's habits`, i + 1));
    for (const budget of [120, 200, 400]) {
      const result = buildCustomerNotesContext([pref('behavioural', 'Shops late evenings')], memories, 'habits', budget);
      expect(estimateTokens(result.block ?? '')).toBeLessThanOrEqual(budget);
      expect(result.preferences + result.memories + result.omitted).toBe(31);
      expect(result.omitted).toBeGreaterThan(0);
      expect(result.block).toContain(`(${result.omitted} more notes not shown to fit the context budget.)`);
    }
  });

  it('a later, smaller memory still fits after a larger one is skipped', () => {
    const result = buildCustomerNotesContext([], [mem('x'.repeat(800), 5), mem('Short note', 1)], 'q', 150);
    expect(result.memories).toBe(1);
    expect(result.block).toContain('- Short note');
    expect(result.omitted).toBe(1);
  });

  it('returns no block when nothing fits the budget at all', () => {
    const result = buildCustomerNotesContext([pref('product', 'y'.repeat(2000))], [], 'q', 50);
    expect(result).toEqual({ block: null, preferences: 0, memories: 0, omitted: 1 });
  });

  it('is deterministic: same inputs give the same block', () => {
    const prefs = [pref('product', 'Cotton only', 2)];
    const memories = [mem('Weekend delivery', 3), mem('Weekend pickup', 3), mem('Gift wrap', 1)];
    const a = buildCustomerNotesContext(prefs, memories, 'weekend', BIG).block;
    const b = buildCustomerNotesContext(prefs, [...memories].reverse(), 'weekend', BIG).block;
    expect(a).toBe(b);
  });
});
