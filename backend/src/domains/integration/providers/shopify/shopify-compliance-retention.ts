import { and, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { shopifyComplianceWebhooks } from '../../../../database/schema/shopify-compliance-webhooks';

/**
 * PROVISIONAL (user, Nov 26, 2026; privacy/legal confirmation pending): an unresolved compliance delivery keeps its
 * encrypted payload at most 30 days after receipt — Shopify's own completion deadline. After that the payload is
 * cleared; the delivery stays open (`failed` / `exception` / abandoned) and keeps alerting, so the deadline breach is
 * never silent, but the erasure-request identifiers do not outlive it.
 */
export const COMPLIANCE_PAYLOAD_RETENTION_DAYS = 30;
/** Escalation thresholds for open deliveries (monitor body + daily error log): overdue, then near Shopify's deadline. */
export const COMPLIANCE_OVERDUE_DAYS = 7;
export const COMPLIANCE_NEAR_DEADLINE_DAYS = 25;

const OPEN = sql`(${shopifyComplianceWebhooks.status} in ('failed', 'exception') or (${shopifyComplianceWebhooks.status} = 'processing' and ${shopifyComplianceWebhooks.claimedAt} < now() - interval '5 minutes'))`;
const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

/** Open-issue counts for alerting. Counts and one timestamp only — never a shop, customer or payload value. */
export async function complianceOpenIssueCounts(db: NodePgDatabase, now: Date) {
  const t = shopifyComplianceWebhooks;
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      overdue: sql<number>`(count(*) filter (where ${t.receivedAt} < ${daysAgo(now, COMPLIANCE_OVERDUE_DAYS)}))::int`,
      nearDeadline: sql<number>`(count(*) filter (where ${t.receivedAt} < ${daysAgo(now, COMPLIANCE_NEAR_DEADLINE_DAYS)}))::int`,
      payloadExpired: sql<number>`(count(*) filter (where ${t.payload} is null))::int`,
      oldest: sql<string | null>`min(${t.receivedAt})`,
    })
    .from(t)
    .where(OPEN);
  return {
    count: row?.count ?? 0,
    overdue: row?.overdue ?? 0,
    nearDeadline: row?.nearDeadline ?? 0,
    payloadExpired: row?.payloadExpired ?? 0,
    oldestReceivedAt: row?.oldest ? new Date(row.oldest) : null,
  };
}

/** Daily-job maintenance: clears expired payloads of open deliveries and reports what still needs an operator. */
export async function applyCompliancePayloadRetention(db: NodePgDatabase, now: Date) {
  const t = shopifyComplianceWebhooks;
  const cleared = await db
    .update(t)
    .set({ payload: null })
    .where(
      and(
        isNotNull(t.payload),
        lt(t.receivedAt, daysAgo(now, COMPLIANCE_PAYLOAD_RETENTION_DAYS)),
        inArray(t.status, ['failed', 'exception', 'processing']),
      ),
    )
    .returning({ id: t.id });
  const open = await complianceOpenIssueCounts(db, now);
  return {
    compliancePayloadsCleared: cleared.length,
    complianceOpen: open.count,
    complianceOverdue: open.overdue,
    complianceNearDeadline: open.nearDeadline,
  };
}
