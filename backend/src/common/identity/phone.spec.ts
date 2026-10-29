import { describe, expect, it } from 'vitest';
import { normalizePhoneE164 } from './phone';

describe('normalizePhoneE164()', () => {
  it.each([
    ['+919876543210', '+919876543210'],
    ['+91 98765-43210', '+919876543210'],
    ['(+1) 415.555.2671', '+14155552671'],
    ['+1 (415) 555-2671', '+14155552671'],
    ['0044 20 7946 0958', '+442079460958'],
    ['  +44 20 7946 0958  ', '+442079460958'],
  ])('normalizes %j to %j', (raw, expected) => {
    expect(normalizePhoneE164(raw)).toBe(expected);
  });

  it.each([
    ['9876543210', 'national number, no country code'],
    ['098765 43210', 'national number with trunk prefix'],
    ['+0919876543210', 'country code starting with 0'],
    ['+1234567', 'too short'],
    ['+1234567890123456', 'too long'],
    ['+1 415 555 2671 x123', 'extension'],
    ['+1 415 CALL NOW', 'letters'],
    ['+44 20+7946', 'stray plus'],
    ['', 'empty'],
    ['   ', 'whitespace'],
  ])('returns null for %j (%s)', (raw) => {
    expect(normalizePhoneE164(raw)).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(normalizePhoneE164(null)).toBeNull();
    expect(normalizePhoneE164(undefined)).toBeNull();
  });
});
