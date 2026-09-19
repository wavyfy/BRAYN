import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { merchantKnowledgeEntries } from '../../database/schema/merchant-knowledge-entries';
import { merchantKnowledgeEntryHistory } from '../../database/schema/merchant-knowledge-entry-history';
import { DatabaseService } from '../../database/database.service';
import { NotFoundError } from '../../common/errors/app-error';
import type { CreateEntryInput } from './dto/create-entry.schema';
import type { UpdateEntryInput } from './dto/update-entry.schema';

/**
 * Doc13 "Retrieval": "The system should retrieve only knowledge relevant
 * to the current task... The retrieval mechanism is an implementation
 * detail" — deterministic, bounded keyword-overlap scorer over
 * title+content, not embeddings/vector search (doc13 explicitly does not
 * require vector retrieval; doc02's pgvector lock only applies if/when a
 * vector approach is actually built). The schema has no metadata/tags/
 * full-text index to filter on beyond `type`, which `list()` already uses.
 */
const MAX_RELEVANT_ENTRIES = 5;

function scoreRelevance(queryWords: Set<string>, entry: { title: string; content: string }): number {
  const haystack = `${entry.title} ${entry.content}`.toLowerCase();
  let score = 0;
  for (const word of queryWords) {
    if (haystack.includes(word)) {
      score += 1;
    }
  }
  return score;
}

/**
 * Merchant Knowledge & Policy Store (doc13; doc19 Phase 10). See
 * merchant-knowledge-entries schema's doc comment for Phase 1 scope —
 * merchant-authored text only, no upload/ingestion pipeline.
 *
 * Owns relevance retrieval (`findRelevant`, moved here from
 * `MerchantBusinessAnalystService` — doc04 "One Owner": the Store owns
 * retrieval over its own data per doc13's Context Flow diagram
 * (Store → Relevant Retrieval → AI Context Builder), not a consumer
 * reimplementing it). Behavior/limits are unchanged from the moved code —
 * see `findRelevant`'s own doc comment.
 */
@Injectable()
export class MerchantKnowledgeService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Doc19 Phase 12 step 4 — "Merchant knowledge integration" (originally
   * implemented in `MerchantBusinessAnalystService`, relocated here
   * unchanged for domain ownership). Only meaningful for relevance-scored
   * knowledge — doc13: policy is NOT relevance-filtered (every policy is
   * always included regardless of query, since a policy can govern an
   * answer without sharing any keywords with it) — callers must keep
   * fetching policy via plain `list()`, never through this method.
   */
  async findRelevant(workspaceId: string, type: 'knowledge' | 'policy', query: string) {
    const entries = await this.list(workspaceId, type);
    const queryWords = new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
    if (queryWords.size === 0) {
      return [];
    }

    return entries
      .map((entry) => ({ entry, score: scoreRelevance(queryWords, entry) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RELEVANT_ENTRIES)
      .map(({ entry }) => entry);
  }

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
