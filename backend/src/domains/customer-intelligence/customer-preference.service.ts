import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { customerPreferenceHistory, customerPreferences } from '../../database/schema/customer-preferences';
import { DatabaseService } from '../../database/database.service';
import { RequestContext } from '../../common/logging/request-context';
import { ConflictError, NotFoundError, UnauthenticatedError } from '../../common/errors/app-error';
import { CustomerIntelligenceService } from './customer-intelligence.service';
import type { CreatePreferenceInput, UpdatePreferenceInput } from './dto/preference.schema';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Preference = typeof customerPreferences.$inferSelect;

/**
 * doc08 UCIR "Customer Preferences", Slice 4.2: merchant-provided only —
 * create, edit, archive with history in the same transaction. Same rules
 * as `CustomerMemoryService`, including staying out of `CustomerRecord`
 * (and so out of AI context) until Slice 4.3 decides how AI sees it.
 */
@Injectable()
export class CustomerPreferenceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly customerIntelligence: CustomerIntelligenceService,
  ) {}

  /** Active preferences, newest first. Archived ones are kept but not listed. */
  async list(workspaceId: string, canonicalCustomerId: string): Promise<Preference[]> {
    await this.requireCustomer(workspaceId, canonicalCustomerId);
    return this.database.client
      .select()
      .from(customerPreferences)
      .where(
        and(
          eq(customerPreferences.workspaceId, workspaceId),
          eq(customerPreferences.canonicalCustomerId, canonicalCustomerId),
          eq(customerPreferences.status, 'active'),
        ),
      )
      .orderBy(desc(customerPreferences.createdAt));
  }

  async create(workspaceId: string, canonicalCustomerId: string, input: CreatePreferenceInput): Promise<Preference> {
    const actorUserId = this.requireActor();
    await this.requireCustomer(workspaceId, canonicalCustomerId);

    return this.database.transaction(async (tx) => {
      const [preference] = await tx
        .insert(customerPreferences)
        .values({
          workspaceId,
          canonicalCustomerId,
          category: input.category,
          content: input.content,
          provenance: 'merchant_provided',
          createdByUserId: actorUserId,
        })
        .returning();
      await this.recordHistory(tx, preference, 'created', actorUserId);
      return preference;
    });
  }

  async update(workspaceId: string, canonicalCustomerId: string, preferenceId: string, input: UpdatePreferenceInput): Promise<Preference> {
    const actorUserId = this.requireActor();
    await this.requireCustomer(workspaceId, canonicalCustomerId);

    return this.database.transaction(async (tx) => {
      await this.lockActive(tx, workspaceId, canonicalCustomerId, preferenceId);
      const [preference] = await tx
        .update(customerPreferences)
        .set({ category: input.category, content: input.content, updatedAt: new Date() })
        .where(eq(customerPreferences.id, preferenceId))
        .returning();
      await this.recordHistory(tx, preference, 'edited', actorUserId);
      return preference;
    });
  }

  async archive(workspaceId: string, canonicalCustomerId: string, preferenceId: string): Promise<Preference> {
    const actorUserId = this.requireActor();
    await this.requireCustomer(workspaceId, canonicalCustomerId);

    return this.database.transaction(async (tx) => {
      await this.lockActive(tx, workspaceId, canonicalCustomerId, preferenceId);
      const now = new Date();
      const [preference] = await tx
        .update(customerPreferences)
        .set({ status: 'archived', archivedAt: now, updatedAt: now })
        .where(eq(customerPreferences.id, preferenceId))
        .returning();
      await this.recordHistory(tx, preference, 'archived', actorUserId);
      return preference;
    });
  }

  private requireActor(): string {
    const actorUserId = RequestContext.get()?.actorUserId;
    if (!actorUserId) {
      throw new UnauthenticatedError();
    }
    return actorUserId;
  }

  /** Same 404 rules as the customer detail (unknown, other workspace, or merged → `mergedIntoId`). */
  private async requireCustomer(workspaceId: string, canonicalCustomerId: string): Promise<void> {
    if (!UUID_PATTERN.test(canonicalCustomerId)) {
      throw new NotFoundError('No customer with that id exists in this workspace.');
    }
    await this.customerIntelligence.requireCanonical(workspaceId, canonicalCustomerId);
  }

  private async lockActive(tx: NodePgDatabase, workspaceId: string, canonicalCustomerId: string, preferenceId: string): Promise<void> {
    const [preference] = UUID_PATTERN.test(preferenceId)
      ? await tx
          .select({ status: customerPreferences.status })
          .from(customerPreferences)
          .where(
            and(
              eq(customerPreferences.workspaceId, workspaceId),
              eq(customerPreferences.canonicalCustomerId, canonicalCustomerId),
              eq(customerPreferences.id, preferenceId),
            ),
          )
          .for('update')
      : [];
    if (!preference) {
      throw new NotFoundError('No preference with that id exists for this customer.');
    }
    if (preference.status !== 'active') {
      throw new ConflictError('This preference has been archived.');
    }
  }

  private async recordHistory(tx: NodePgDatabase, preference: Preference, action: 'created' | 'edited' | 'archived', actorUserId: string): Promise<void> {
    await tx.insert(customerPreferenceHistory).values({
      workspaceId: preference.workspaceId,
      preferenceId: preference.id,
      action,
      category: preference.category,
      content: preference.content,
      provenance: preference.provenance,
      status: preference.status,
      changedByUserId: actorUserId,
    });
  }
}
