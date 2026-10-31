import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Slice 4.6 guard — doc08 "Canonical Customer Rule": consumers read
 * customer context through the UCIR (`CustomerIntelligenceService`), never
 * by resolving customers from the identity tables themselves. Only the
 * files below may import them; a new consumer that does fails here.
 */
const GUARDED_TABLES = ['canonical-customers', 'commerce-customers', 'website-visitors'];

const ALLOWED: Record<string, string> = {
  // Source data owners (write side) — doc08: Source Data → Identity Resolution → UCIR → Consumers.
  'commerce/customer.service.ts': 'Commerce owns commerce_customers',
  'commerce/order.service.ts': 'Commerce links orders to their source customer',
  'website-tracking/website-event-ingest.service.ts': 'Website tracking owns website_visitors',
  'identity-resolution/identity-resolution.service.ts': 'Identity Resolution owns canonical customers, links and merge',
  'integration/integration.service.ts': 'Canonical erasure path (purgeCanonicalCustomerIfOrphaned)',
  // The UCIR itself.
  'customer-intelligence/customer-intelligence.service.ts': 'Unified Customer Intelligence Record',
  // Allowed analytical read model (Slice 4.6 decision): product/line-item affinity UCIR does not carry; runs after getCustomer().
  'intelligence-engines/revenue-opportunity.service.ts': 'Allowed analytical read model',
};

const domainsDir = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('UCIR boundary (doc08 Canonical Customer Rule)', () => {
  const importPattern = new RegExp(`schema/(${GUARDED_TABLES.join('|')})['"]`);
  const importers = sourceFiles(domainsDir)
    .filter((file) => importPattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(domainsDir, file).split(sep).join('/'));

  it('only allow-listed domain files import the customer identity tables', () => {
    expect(importers.filter((file) => !(file in ALLOWED))).toEqual([]);
  });

  it('the allow-list names only files that exist (keeps it current)', () => {
    expect(Object.keys(ALLOWED).filter((file) => !existsSync(join(domainsDir, file)))).toEqual([]);
  });

  it('scans a non-empty source tree (guards against a broken path silently passing)', () => {
    expect(importers).toContain('customer-intelligence/customer-intelligence.service.ts');
  });
});
