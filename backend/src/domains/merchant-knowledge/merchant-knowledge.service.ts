import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { merchantKnowledgeEntries } from '../../database/schema/merchant-knowledge-entries';
import { merchantKnowledgeEntryHistory } from '../../database/schema/merchant-knowledge-entry-history';
import { DatabaseService } from '../../database/database.service';
import { NotFoundError } from '../../common/errors/app-error';
import type { CreateEntryInput } from './dto/create-entry.schema';
import type { UpdateEntryInput } from './dto/update-entry.schema';

/**
 * Merchant Knowledge & Policy Store (doc13; doc19 Phase 10). See
 * merchant-knowledge-entries schema's doc comment for Phase 1 scope —
 * merchant-authored text only, no upload/ingestion pipeline, no AI
 * retrieval wiring (nothing to hand context to yet).
 */
@Injectable()
export class MerchantKnowledgeService {
  constructor(private readonly database: DatabaseService) {}

  async create(workspaceId: string, input: CreateEntryInput) {
    const [entry] = await this.database.client
      .insert(merchantKnowledgeEntries)
      .values({ workspaceId, type: input.type, title: input.title, content: input.content, version: 1 })
      .returning();

    await this.recordHistory(workspaceId, entry);
    return entry;
  }

  async list(workspaceId: string, type?: 'knowledge' | 'policy') {
    return this.database.client
      .select()
      .from(merchantKnowledgeEntries)
      .where(and(eq(merchantKnowledgeEntries.workspaceId, workspaceId), type ? eq(merchantKnowledgeEntries.type, type) : undefined))
      .orderBy(desc(merchantKnowledgeEntries.createdAt));
  }

  async get(workspaceId: string, entryId: string) {
    return this.requireEntry(workspaceId, entryId);
  }

  async update(workspaceId: string, entryId: string, input: UpdateEntryInput) {
    const current = await this.requireEntry(workspaceId, entryId);
    const now = new Date();

    const [updated] = await this.database.client
      .update(merchantKnowledgeEntries)
      .set({
        title: input.title ?? current.title,
        content: input.content ?? current.content,
        version: current.version + 1,
        updatedAt: now,
      })
      .where(eq(merchantKnowledgeEntries.id, entryId))
      .returning();

    await this.recordHistory(workspaceId, updated);
    return updated;
  }

  async getHistory(workspaceId: string, entryId: string) {
    await this.requireEntry(workspaceId, entryId);

    return this.database.client
      .select()
      .from(merchantKnowledgeEntryHistory)
      .where(and(eq(merchantKnowledgeEntryHistory.workspaceId, workspaceId), eq(merchantKnowledgeEntryHistory.entryId, entryId)))
      .orderBy(desc(merchantKnowledgeEntryHistory.version));
  }

  private async requireEntry(workspaceId: string, entryId: string) {
    const [entry] = await this.database.client
      .select()
      .from(merchantKnowledgeEntries)
      .where(and(eq(merchantKnowledgeEntries.workspaceId, workspaceId), eq(merchantKnowledgeEntries.id, entryId)))
      .limit(1);

    if (!entry) {
      throw new NotFoundError('No knowledge/policy entry with that id exists in this workspace.');
    }

    return entry;
  }

  private async recordHistory(
    workspaceId: string,
    entry: { id: string; version: number; type: string; title: string; content: string },
  ): Promise<void> {
    await this.database.client.insert(merchantKnowledgeEntryHistory).values({
      workspaceId,
      entryId: entry.id,
      version: entry.version,
      type: entry.type as 'knowledge' | 'policy',
      title: entry.title,
      content: entry.content,
    });
  }
}
