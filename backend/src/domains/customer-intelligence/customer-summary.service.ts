import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { customerSummaries } from '../../database/schema/customer-summaries';
import { DatabaseService } from '../../database/database.service';
import { RequestContext } from '../../common/logging/request-context';
import { NotFoundError, ProviderError, UnauthenticatedError } from '../../common/errors/app-error';
import { AiGatewayService } from '../ai/ai-gateway.service';
import { CustomerIntelligenceService, type ActivityEntry, type CustomerRecord } from './customer-intelligence.service';
import { CustomerContextBuilder } from './customer-context-builder.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPABILITY = 'customer-summary';
const PROMPT_VERSION = 'customer-summary-v1';
const MAX_ACTIVITY_ENTRIES = 20;

const SYSTEM_PROMPT =
  "You write a short summary of one customer for the merchant's own team. Use only the data given. Keep it under 120 " +
  'words, plain text, no headings. Say what kind of customer this is, their purchase pattern and anything the team ' +
  'should keep in mind. Keep verified data and merchant notes distinct (e.g. "the team notes that…"). Never invent ' +
  'facts, figures or intentions; if data is thin, say so briefly.';

type Summary = typeof customerSummaries.$inferSelect;

export interface CustomerSummaryView {
  summary: Pick<Summary, 'content' | 'provenance' | 'model' | 'generatedAt' | 'generatedByUserId'> | null;
  /** True when the customer's data has changed since the summary was generated. */
  stale: boolean;
}

const fingerprint = (input: string) => createHash('sha256').update(input).digest('hex');

/**
 * The exact data the model sees, as stable text: UCIR facts (no email/phone — not needed for a summary) and merchant
 * notes via the Context Builder. Time-relative values (e.g. orders in the last 90 days) are left out so the
 * fingerprint only changes when the underlying data does.
 */
function buildSummaryInput(customer: CustomerRecord, activity: ActivityEntry[], notesBlock: string | null): string {
  const { profile, commerceContext, behaviouralContext } = customer;
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || 'unknown';
  const iso = (date: Date | null) => (date ? date.toISOString() : 'unknown');
  const activityLines = activity
    .map(({ type, occurredAt, ...rest }) => `- ${occurredAt.toISOString()} ${type} ${JSON.stringify(rest)}`)
    .sort()
    .reverse()
    .slice(0, MAX_ACTIVITY_ENTRIES);

  return [
    'VERIFIED CUSTOMER DATA (doc08 Unified Customer Intelligence Record):',
    `- Name: ${name}`,
    `- Sources: ${customer.sourceCustomers.map((source) => source.provider).sort().join(', ') || 'none'}`,
    `- Total orders: ${commerceContext.ordersCount}`,
    `- Total spent: ${commerceContext.totalSpent}`,
    `- Last order at: ${iso(commerceContext.lastOrderAt)}`,
    `- Website events: ${behaviouralContext.eventsCount}, last activity at ${iso(behaviouralContext.lastActivityAt)}`,
    '',
    `RECENT ACTIVITY (newest first, up to ${MAX_ACTIVITY_ENTRIES}):`,
    ...(activityLines.length > 0 ? activityLines : ['- none']),
    '',
    notesBlock ?? 'MERCHANT NOTES: none.',
  ].join('\n');
}

/**
 * doc08 UCIR "Customer Summary", Slice 4.5: an AI-generated summary,
 * persisted one per customer and regenerated only on request (no
 * scheduler). Reads go through `CustomerIntelligenceService` (same 404
 * rules: unknown, other workspace, merged, erased) and the Context
 * Builder for merchant notes. The saved summary is display-only — it is
 * never part of any AI context.
 */
@Injectable()
export class CustomerSummaryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly customerIntelligence: CustomerIntelligenceService,
    private readonly customerContext: CustomerContextBuilder,
    private readonly aiGateway: AiGatewayService,
  ) {}

  async get(workspaceId: string, canonicalCustomerId: string): Promise<CustomerSummaryView> {
    this.requireUuid(canonicalCustomerId);
    await this.customerIntelligence.requireCanonical(workspaceId, canonicalCustomerId);
    const [summary] = await this.database.client
      .select()
      .from(customerSummaries)
      .where(and(eq(customerSummaries.workspaceId, workspaceId), eq(customerSummaries.canonicalCustomerId, canonicalCustomerId)));
    if (!summary) {
      return { summary: null, stale: false };
    }
    const input = await this.loadInput(workspaceId, canonicalCustomerId);
    return this.toView(summary, fingerprint(input) !== summary.sourceFingerprint);
  }

  async generate(workspaceId: string, canonicalCustomerId: string): Promise<CustomerSummaryView> {
    const actorUserId = RequestContext.get()?.actorUserId;
    if (!actorUserId) {
      throw new UnauthenticatedError();
    }
    this.requireUuid(canonicalCustomerId);
    const input = await this.loadInput(workspaceId, canonicalCustomerId);

    const result = await this.aiGateway.generate({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: input },
      ],
      capability: CAPABILITY,
    });

    const content = result.content.trim();
    if (!content) {
      throw new ProviderError('The AI returned an empty summary.');
    }
    const now = new Date();
    const values = {
      content,
      model: result.model,
      promptVersion: PROMPT_VERSION,
      sourceFingerprint: fingerprint(input),
      generatedByUserId: actorUserId,
      generatedAt: now,
      updatedAt: now,
    };
    const [summary] = await this.database.client
      .insert(customerSummaries)
      .values({ workspaceId, canonicalCustomerId, ...values })
      .onConflictDoUpdate({ target: [customerSummaries.workspaceId, customerSummaries.canonicalCustomerId], set: values })
      .returning();
    return this.toView(summary, false);
  }

  private async loadInput(workspaceId: string, canonicalCustomerId: string): Promise<string> {
    const [customer, activity, notes] = await Promise.all([
      this.customerIntelligence.getCustomer(workspaceId, canonicalCustomerId),
      this.customerIntelligence.getActivity(workspaceId, canonicalCustomerId),
      // No question: notes come out in recency order, so the input is stable.
      this.customerContext.build(workspaceId, canonicalCustomerId, ''),
    ]);
    return buildSummaryInput(customer, activity, notes.block);
  }

  private requireUuid(canonicalCustomerId: string): void {
    if (!UUID_PATTERN.test(canonicalCustomerId)) {
      throw new NotFoundError('No customer with that id exists in this workspace.');
    }
  }

  private toView(summary: Summary, stale: boolean): CustomerSummaryView {
    const { content, provenance, model, generatedAt, generatedByUserId } = summary;
    return { summary: { content, provenance, model, generatedAt, generatedByUserId }, stale };
  }
}
