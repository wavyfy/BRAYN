import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withoutUnverifiedCheckouts, type ActivityEntry } from './customer-intelligence.service';

/**
 * Guard (FlexyPe review, Nov 24, 2026): a checkout attributed only by a shopper-typed email is unverified. Only the
 * merchant UI (labelled) may receive it; every other `getActivity` consumer — AI read tools, AI summaries, and any
 * future recommendation/automation input — must pass the result through `withoutUnverifiedCheckouts`.
 */
const RAW_ACTIVITY_ALLOWED: Record<string, string> = {
  'customer-intelligence/customer-intelligence.controller.ts':
    'Merchant UI — the timeline labels email-attributed checkouts as unverified',
  'customer-intelligence/customer-intelligence.service.ts': 'Defines getActivity',
};

const domainsDir = join(__dirname, '..');
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('checkout attribution boundary', () => {
  const callers = sourceFiles(domainsDir)
    .filter((file) => /\.getActivity\(/.test(readFileSync(file, 'utf8')))
    .map((file) => ({
      file: relative(domainsDir, file).split(sep).join('/'),
      source: readFileSync(file, 'utf8'),
    }));

  it('every non-UI consumer of getActivity filters unverified checkout attributions', () => {
    const unfiltered = callers.filter(
      ({ file, source }) =>
        !(file in RAW_ACTIVITY_ALLOWED) && !source.includes('withoutUnverifiedCheckouts('),
    );
    expect(unfiltered.map(({ file }) => file)).toEqual([]);
  });

  it('scans real consumers (guards against a broken path silently passing)', () => {
    expect(callers.map(({ file }) => file)).toEqual(
      expect.arrayContaining([
        'ai-agents/read-tools.service.ts',
        'customer-intelligence/customer-summary.service.ts',
        'customer-intelligence/customer-intelligence.controller.ts',
      ]),
    );
  });

  it('withoutUnverifiedCheckouts drops only email-attributed checkout entries', () => {
    const at = new Date('2026-11-24T10:00:00Z');
    const entries: ActivityEntry[] = [
      {
        type: 'checkout_abandoned',
        occurredAt: at,
        provider: 'flexype',
        externalId: 's_email',
        stage: 'PAYMENT_INITIATED',
        completedOrderExternalId: null,
        attribution: 'email',
      },
      {
        type: 'checkout_abandoned',
        occurredAt: at,
        provider: 'flexype',
        externalId: 's_order',
        stage: 'PAYMENT_INITIATED',
        completedOrderExternalId: 'o_1',
        attribution: 'order',
      },
      {
        type: 'order_placed',
        occurredAt: at,
        provider: 'shopify',
        externalId: 'o_1',
        totalPrice: '10.00',
      },
      { type: 'website_activity', occurredAt: at, eventType: 'page_view' },
    ];
    expect(
      withoutUnverifiedCheckouts(entries).map((entry) =>
        'externalId' in entry ? entry.externalId : entry.type,
      ),
    ).toEqual(['s_order', 'o_1', 'website_activity']);
  });
});
