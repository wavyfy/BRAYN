import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { customerMemoryEntries } from '../../database/schema/customer-memory-entries';
import { customerMemoryEntryHistory } from '../../database/schema/customer-memory-entry-history';
import { DatabaseService } from '../../database/database.service';
import { RequestContext } from '../../common/logging/request-context';
import { ConflictError, NotFoundError, UnauthenticatedError } from '../../common/errors/app-error';
import { CustomerIntelligenceService } from './customer-intelligence.service';
import type { CreateMemoryEntryInput, UpdateMemoryEntryInput } from './dto/memory-entry.schema';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MemoryEntry = typeof customerMemoryEntries.$inferSelect;

/**
 * doc08 UCIR "Customer Memory", Slice 4.1: merchant-provided memory only —
 * create, edit, archive; every change appends a history row in the same
 * transaction. No AI/derived/source-backed writes exist yet.
 *
 * Deliberately not part of `CustomerRecord`/`getCustomer()`: every AI agent
 * reads that, and memory must not reach AI context until a later slice
 * decides how (doc08 "AI Relationship" — Context Builder).
 */
@Injectable()
export class CustomerMemoryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly customerIntelligence: CustomerIntelligenceService,
  ) {}

  /** Active entries, newest first. Archived entries are kept but not listed. */
  async list(workspaceId: string, canonicalCustomerId: string): Promise<MemoryEntry[]> {
    await this.requireCustomer(workspaceId, canonicalCustomerId);
    return this.database.client
      .select()
      .from(customerMemoryEntries)
      .where(
        and(
          eq(customerMemoryEntries.workspaceId, workspaceId),
          eq(customerMemoryEntries.canonicalCustomerId, canonicalCustomerId),
          eq(customerMemoryEntries.status, 'active'),
        ),
      )
      .orderBy(desc(customerMemoryEntries.createdAt));
  }

  async create(workspaceId: string, canonicalCustomerId: string, input: CreateMemoryEntryInput): Promise<MemoryEntry> {
    const actorUserId = this.requireActor();
    await this.requireCustomer(workspaceId, canonicalCustomerId);

    return this.database.transaction(async (tx) => {
      const [entry] = await tx
        .insert(customerMemoryEntries)
        .values({ workspaceId, canonicalCustomerId, content: input.content, provenance: 'merchant_provided', createdByUserId: actorUserId })
        .returning();
      await this.recordHistory(tx, entry, 'created', actorUserId);
      return entry;
    });
  }

  async update(workspaceId: string, canonicalCustomerId: string, memoryEntryId: string, input: UpdateMemoryEntryInput): Promise<MemoryEntry> {
    const actorUserId = this.requireActor();
    await this.requireCustomer(workspaceId, canonicalCustomerId);

    return this.database.transaction(async (tx) => {
      await this.lockActiveEntry(tx, workspaceId, canonicalCustomerId, memoryEntryId);
      const [entry] = await tx
        .update(customerMemoryEntries)
        .set({ content: input.content, updatedAt: new Date() })
        .where(eq(customerMemoryEntries.id, memoryEntryId))
        .returning();
      await this.recordHistory(tx, entry, 'edited', actorUserId);
      return entry;
    });
  }

  async archive(workspaceId: string, canonicalCustomerId: string, memoryEntryId: string): Promise<MemoryEntry> {
    const actorUserId = this.requireActor();
    await this.requireCustomer(workspaceId, canonicalCustomerId);

    return this.database.transaction(async (tx) => {
      await this.lockActiveEntry(tx, workspaceId, canonicalCustomerId, memoryEntryId);
      const now = new Date();
      const [entry] = await tx
        .update(customerMemoryEntries)
        .set({ status: 'archived', archivedAt: now, updatedAt: now })
        .where(eq(customerMemoryEntries.id, memoryEntryId))
        .returning();
      await this.recordHistory(tx, entry, 'archived', actorUserId);
      return entry;
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

  private async lockActiveEntry(tx: NodePgDatabase, workspaceId: string, canonicalCustomerId: string, memoryEntryId: string): Promise<void> {
    const [entry] = UUID_PATTERN.test(memoryEntryId)
      ? await tx
          .select({ status: customerMemoryEntries.status })
          .from(customerMemoryEntries)
          .where(
            and(
              eq(customerMemoryEntries.workspaceId, workspaceId),
              eq(customerMemoryEntries.canonicalCustomerId, canonicalCustomerId),
              eq(customerMemoryEntries.id, memoryEntryId),
            ),
          )
          .for('update')
      : [];
    if (!entry) {
      throw new NotFoundError('No memory entry with that id exists for this customer.');
    }
    if (entry.status !== 'active') {
      throw new ConflictError('This memory entry has been archived.');
    }
  }

  private async recordHistory(tx: NodePgDatabase, entry: MemoryEntry, action: 'created' | 'edited' | 'archived', actorUserId: string): Promise<void> {
    await tx.insert(customerMemoryEntryHistory).values({
      workspaceId: entry.workspaceId,
      memoryEntryId: entry.id,
      action,
      content: entry.content,
      provenance: entry.provenance,
      status: entry.status,
      changedByUserId: actorUserId,
    });
  }
}
