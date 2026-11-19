import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray, sql } from 'drizzle-orm';

vi.hoisted(() => {
  process.env.ERASURE_HMAC_SECRET = 'customer-erasure-blockers-spec-secret-0123456789';
});

import { AppModule } from '../../app.module';
import { DatabaseService } from '../../database/database.service';
import { workspaces } from '../../database/schema/workspaces';
import { integrations } from '../../database/schema/integrations';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { canonicalCustomerDuplicates } from '../../database/schema/canonical-customer-duplicates';
import { websiteVisitors } from '../../database/schema/website-visitors';
import { websiteSessions } from '../../database/schema/website-sessions';
import { websiteEvents } from '../../database/schema/website-events';
import { erasedCustomerIdentifiers } from '../../database/schema/erased-customer-identifiers';
import { customerErasures } from '../../database/schema/customer-erasures';
import { idempotencyKeys } from '../../database/schema/idempotency-keys';
import { CustomerService } from '../commerce/customer.service';
import { ErasedIdentifierService } from '../commerce/erased-identifier.service';
import { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import { WebsiteTrackingKeyService } from '../website-tracking/website-tracking-key.service';
import {
  WebsiteEventIngestService,
  identitySignaturePayload,
  type WebsiteEventRequestContext,
} from '../website-tracking/website-event-ingest.service';
import type { IngestWebsiteEventInput } from '../website-tracking/dto/ingest-website-event.schema';
import { IntegrationService } from './integration.service';
import { CustomerErasureService } from './customer-erasure.service';

/**
 * Release-blocker regressions for person-level erasure:
 * - B1: identity resolution racing an erasure never re-creates a canonical customer with the erased email.
 * - B2: website identity data carrying the erased email is erased, linked or not.
 * - L4: later website identity signals with the erased email are stored anonymously and never linked; replay stays
 *   de-duplicated.
 * - No deadlocks under concurrent upserts, resolution and erasure.
 */
describe('Customer erasure release blockers (real DB)', { timeout: 180_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let erasure: CustomerErasureService;
  let identity: IdentityResolutionService;
  let ingest: WebsiteEventIngestService;
  const ws = {
    a: {
      id: randomUUID(),
      origin: 'https://erase-a.example',
      writeKey: '',
      identitySecret: '',
      woo: '',
    },
    b: {
      id: randomUUID(),
      origin: 'https://erase-b.example',
      writeKey: '',
      identitySecret: '',
      woo: '',
    },
  };
  const ctx = (w: typeof ws.a): WebsiteEventRequestContext => ({
    writeKey: w.writeKey,
    origin: w.origin,
    ip: '127.0.0.1',
  });
  const sign = (email: string, secret: string) =>
    createHmac('sha256', secret).update(identitySignaturePayload(email)).digest('hex');
  const identityEvent = (
    visitorId: string,
    email: string,
    secret?: string,
    eventId = `evt-${randomUUID()}`,
  ): IngestWebsiteEventInput => ({
    visitorId,
    sessionId: `s-${visitorId}`,
    eventId,
    eventType: 'identity_signal',
    payload: secret ? { email, signature: sign(email, secret) } : { email },
  });
  const pageView = (visitorId: string): IngestWebsiteEventInput => ({
    visitorId,
    sessionId: `s-${visitorId}`,
    eventId: `evt-${randomUUID()}`,
    eventType: 'page_view',
  });
  const visitor = async (workspaceId: string, visitorId: string) =>
    (
      await db.client
        .select()
        .from(websiteVisitors)
        .where(
          and(
            eq(websiteVisitors.workspaceId, workspaceId),
            eq(websiteVisitors.visitorId, visitorId),
          ),
        )
    )[0];
  const eventsMentioning = async (workspaceId: string, email: string) =>
    db.client
      .select({ id: websiteEvents.id })
      .from(websiteEvents)
      .where(
        and(
          eq(websiteEvents.workspaceId, workspaceId),
          sql`${websiteEvents.payload}::text ilike ${`%${email}%`}`,
        ),
      );
  const canonicalWithEmail = async (workspaceId: string, email: string) =>
    db.client
      .select()
      .from(canonicalCustomers)
      .where(
        and(
          eq(canonicalCustomers.workspaceId, workspaceId),
          eq(canonicalCustomers.primaryEmail, email),
        ),
      );

  /** A canonical customer with one linked WooCommerce source row, as identity resolution leaves it. */
  async function person(
    workspaceId: string,
    integrationId: string,
    email: string,
    externalId: string,
  ) {
    const [canonical] = await db.client
      .insert(canonicalCustomers)
      .values({ workspaceId, primaryEmail: email })
      .returning();
    await db.client
      .insert(commerceCustomers)
      .values({
        workspaceId,
        integrationId,
        provider: 'woocommerce',
        externalId,
        email,
        canonicalCustomerId: canonical.id,
      });
    return canonical.id;
  }

  /** Polls pg_locks until some session is queued on this workspace's erasure lock. */
  async function waitUntilQueuedOnErasureLock(workspaceId: string) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const { rows } = await db.client.execute(sql`
        select count(*) as n from pg_locks l, (select hashtextextended(${`customer-erasure:${workspaceId}`}, 0) as k) key
        where l.locktype = 'advisory' and not l.granted
          and l.classid::bigint = ((key.k >> 32) & 4294967295) and l.objid::bigint = (key.k & 4294967295)`);
      if (Number(rows[0].n) > 0) return;
      if (Date.now() > deadline) throw new Error('nothing ever queued on the erasure lock');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured())
      throw new Error(
        'DATABASE_URL is not configured — this integration test requires the real dev database.',
      );
    erasure = moduleRef.get(CustomerErasureService);
    identity = moduleRef.get(IdentityResolutionService);
    ingest = moduleRef.get(WebsiteEventIngestService);
    const integrationService = moduleRef.get(IntegrationService);
    const keys = moduleRef.get(WebsiteTrackingKeyService);
    for (const w of [ws.a, ws.b]) {
      await db.client
        .insert(workspaces)
        .values({ id: w.id, name: 'Customer Erasure Blockers Test' });
      await integrationService.connect(w.id, 'website_tracking');
      w.writeKey = (await keys.generate(w.id)).writeKey;
      w.identitySecret = (await keys.generateIdentitySecret(w.id)).identitySecret;
      await keys.setAllowedOrigins(w.id, [w.origin]);
      w.woo = (await integrationService.connect(w.id, 'woocommerce')).id;
    }
  }, 90_000);

  afterAll(async () => {
    if (db?.isConfigured()) {
      const ids = [ws.a.id, ws.b.id];
      for (const id of ids)
        await db.client
          .delete(idempotencyKeys)
          .where(sql`${idempotencyKeys.key} like ${`website-event:${id}:%`}`);
      await db.client.delete(websiteEvents).where(inArray(websiteEvents.workspaceId, ids));
      await db.client.delete(websiteSessions).where(inArray(websiteSessions.workspaceId, ids));
      await db.client.delete(websiteVisitors).where(inArray(websiteVisitors.workspaceId, ids));
      await db.client
        .delete(canonicalCustomerDuplicates)
        .where(inArray(canonicalCustomerDuplicates.workspaceId, ids));
      await db.client.delete(commerceCustomers).where(inArray(commerceCustomers.workspaceId, ids));
      await db.client
        .delete(canonicalCustomers)
        .where(inArray(canonicalCustomers.workspaceId, ids));
      await db.client
        .delete(erasedCustomerIdentifiers)
        .where(inArray(erasedCustomerIdentifiers.workspaceId, ids));
      await db.client.delete(customerErasures).where(inArray(customerErasures.workspaceId, ids));
      await db.client.delete(integrations).where(inArray(integrations.workspaceId, ids));
      await db.client.delete(workspaces).where(inArray(workspaces.id, ids));
    }
    await moduleRef?.close();
  }, 90_000);

  it('B1: identity resolution that races an erasure waits for it, then re-creates nothing', async () => {
    // An unresolved row and the person's canonical customer, both with the email.
    const canonicalId = (
      await db.client
        .insert(canonicalCustomers)
        .values({ workspaceId: ws.a.id, primaryEmail: 'race@example.com' })
        .returning()
    )[0].id;
    await db.client
      .insert(commerceCustomers)
      .values({
        workspaceId: ws.a.id,
        integrationId: ws.a.woo,
        provider: 'woocommerce',
        externalId: 'race-1',
        email: 'race@example.com',
      });

    // An erasure mid-transaction: holds the erasure lock, has deleted both rows, not yet committed.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let erasing!: () => void;
    const midErasure = new Promise<void>((resolve) => (erasing = resolve));
    const simulatedErasure = db.transaction(async (tx) => {
      await moduleRef.get(ErasedIdentifierService).lockExclusive(tx, ws.a.id);
      await tx
        .delete(commerceCustomers)
        .where(
          and(
            eq(commerceCustomers.workspaceId, ws.a.id),
            eq(commerceCustomers.externalId, 'race-1'),
          ),
        );
      await tx.delete(canonicalCustomers).where(eq(canonicalCustomers.id, canonicalId));
      erasing();
      await gate;
    });
    await midErasure;

    const resolving = identity.resolveMany(ws.a.id, 'woocommerce', ['race-1']);
    await waitUntilQueuedOnErasureLock(ws.a.id);
    release();
    await simulatedErasure;
    await resolving;

    expect(await canonicalWithEmail(ws.a.id, 'race@example.com')).toEqual([]);
    expect(
      await db.client
        .select()
        .from(commerceCustomers)
        .where(
          and(
            eq(commerceCustomers.workspaceId, ws.a.id),
            eq(commerceCustomers.externalId, 'race-1'),
          ),
        ),
    ).toEqual([]);
  });

  it('B2 + L4: website identity data with the erased email is erased (linked or not), and later signals never store or link it', async () => {
    const email = 'web.person@example.com';
    const personId = await person(ws.a.id, ws.a.woo, email, 'web-1');
    const otherId = await person(ws.a.id, ws.a.woo, 'other@example.com', 'web-2');
    const erasedEventId = `evt-${randomUUID()}`;

    await ingest.ingest(
      ws.a.id,
      identityEvent('v-unlinked', email, undefined, erasedEventId),
      ctx(ws.a),
    ); // unsigned: stored, never linked
    await ingest.ingest(ws.a.id, pageView('v-unlinked'), ctx(ws.a));
    await ingest.ingest(ws.a.id, identityEvent('v-linked', email, ws.a.identitySecret), ctx(ws.a)); // signed: linked to the person
    await ingest.ingest(ws.a.id, pageView('v-linked'), ctx(ws.a));
    await ingest.ingest(
      ws.a.id,
      identityEvent('v-other', 'other@example.com', ws.a.identitySecret),
      ctx(ws.a),
    ); // linked to someone else
    await ingest.ingest(ws.a.id, identityEvent('v-other', email), ctx(ws.a)); // …who also typed the erased email once
    await ingest.ingest(ws.a.id, pageView('v-other'), ctx(ws.a));
    await ingest.ingest(ws.b.id, identityEvent('v-unlinked', email), ctx(ws.b));
    expect((await visitor(ws.a.id, 'v-linked')).canonicalCustomerId).toBe(personId);
    expect((await visitor(ws.a.id, 'v-other')).canonicalCustomerId).toBe(otherId);

    await erasure.eraseCanonicalCustomer(ws.a.id, personId, 'clerk_owner');

    expect(await visitor(ws.a.id, 'v-unlinked')).toBeUndefined();
    expect(await visitor(ws.a.id, 'v-linked')).toBeUndefined();
    const other = await visitor(ws.a.id, 'v-other');
    expect(other.canonicalCustomerId).toBe(otherId);
    const otherEvents = await db.client
      .select({ eventType: websiteEvents.eventType, payload: websiteEvents.payload })
      .from(websiteEvents)
      .where(eq(websiteEvents.visitorId, other.id));
    expect(otherEvents.map((e) => e.eventType).sort()).toEqual(['identity_signal', 'page_view']);
    expect(await eventsMentioning(ws.a.id, email)).toEqual([]);
    expect((await eventsMentioning(ws.b.id, email)).length).toBe(1);
    const orphanSessions = await db.client
      .select({ id: websiteSessions.id })
      .from(websiteSessions)
      .where(
        and(
          eq(websiteSessions.workspaceId, ws.a.id),
          sql`${websiteSessions.visitorId} not in (select id from website_visitors)`,
        ),
      );
    expect(orphanSessions).toEqual([]);

    // L4: a later, validly signed signal with the erased email — stored anonymously, never linked, no profile.
    const later = await ingest.ingest(
      ws.a.id,
      identityEvent('v-returning', ` ${email.toUpperCase()} `, ws.a.identitySecret),
      ctx(ws.a),
    );
    expect(later).toEqual({ status: 'accepted' });
    const returning = await visitor(ws.a.id, 'v-returning');
    expect(returning.canonicalCustomerId).toBeNull();
    const [stored] = await db.client
      .select({ payload: websiteEvents.payload })
      .from(websiteEvents)
      .where(eq(websiteEvents.visitorId, returning.id));
    expect(stored.payload).toBeNull();
    expect(await eventsMentioning(ws.a.id, email)).toEqual([]);
    expect(await canonicalWithEmail(ws.a.id, email)).toEqual([]);

    // Replay of an erased event's id stays de-duplicated: not stored again.
    expect(
      await ingest.ingest(
        ws.a.id,
        identityEvent('v-unlinked', email, undefined, erasedEventId),
        ctx(ws.a),
      ),
    ).toEqual({ status: 'duplicate' });
    expect(await visitor(ws.a.id, 'v-unlinked')).toBeUndefined();

    // Other emails still link normally.
    await ingest.ingest(
      ws.a.id,
      identityEvent('v-other-2', 'other@example.com', ws.a.identitySecret),
      ctx(ws.a),
    );
    expect((await visitor(ws.a.id, 'v-other-2')).canonicalCustomerId).toBe(otherId);
  });

  it('no deadlocks: concurrent upserts, identity resolution and an erasure in one workspace all settle', async () => {
    const customers = moduleRef.get(CustomerService);
    const victim = await person(ws.b.id, ws.b.woo, 'victim@example.com', 'load-0');
    const work = Array.from({ length: 12 }, (_, i) => async () => {
      const externalId = `load-${(i % 4) + 1}`; // overlapping rows on purpose
      await customers.upsertMany(ws.b.id, ws.b.woo, 'woocommerce', [
        {
          externalId,
          email: `load-${i % 3}@example.com`,
          firstName: null,
          lastName: null,
          phone: '+14155550142',
          sourceUpdatedAt: null,
          sourceCreatedAt: null,
        },
      ]);
      await identity.resolveMany(ws.b.id, 'woocommerce', [externalId, 'load-0']);
    });

    const results = await Promise.allSettled([
      ...work.map((run) => run()),
      erasure.eraseCanonicalCustomer(ws.b.id, victim, 'clerk_owner'),
    ]);

    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => String((result as PromiseRejectedResult).reason));
    expect(failures).toEqual([]);
    expect(await canonicalWithEmail(ws.b.id, 'victim@example.com')).toEqual([]);
  });
});
