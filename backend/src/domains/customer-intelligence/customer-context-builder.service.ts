import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import type { customerMemoryEntries } from '../../database/schema/customer-memory-entries';
import type { customerPreferences } from '../../database/schema/customer-preferences';
import { CustomerMemoryService } from './customer-memory.service';
import { CustomerPreferenceService } from './customer-preference.service';

type MemoryEntry = typeof customerMemoryEntries.$inferSelect;
type Preference = typeof customerPreferences.$inferSelect;

export interface CustomerNotesContext {
  /** The formatted block for the model, or `null` when there is nothing to include. */
  block: string | null;
  preferences: number;
  memories: number;
  /** Active entries left out (budget) — duplicates are dropped silently, not counted here. */
  omitted: number;
}

/** Rough provider-neutral estimate (~4 chars/token for English) — deterministic, no tokenizer dependency. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const HEADER =
  "CATEGORY: Merchant notes about this customer (doc08 Customer Preferences / Customer Memory). Recorded by the merchant's " +
  'own team (provenance: merchant_provided) — NOT verified customer facts and not confirmed by the customer. Use them as ' +
  "the team's notes, say so when an answer relies on them, and never present them as verified.";
const OMISSION_NOTE = (count: number) => `(${count} more note${count === 1 ? '' : 's'} not shown to fit the context budget.)`;
// Reserved up front so the final block never exceeds the budget, whether or not anything is omitted.
const OMISSION_NOTE_TOKENS = estimateTokens(OMISSION_NOTE(9999));

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
// Same tokenizer as merchant knowledge relevance (`MerchantKnowledgeService.findRelevant`).
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
const day = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Slice 4.3 — deterministic AI context from merchant-provided preferences
 * and memory. Preferences first (all active, newest kept per duplicate
 * category+content); then memories ranked by keyword overlap with the
 * question, ties and non-matching ones by most recently updated (so a
 * question with no overlap still gets the newest notes); memories that
 * repeat a preference or each other are dropped. Items that don't fit
 * `maxTokens` are skipped (later, smaller ones may still fit) and counted
 * as omitted. Inputs are expected active-only and newest-first, as the
 * memory/preference services return them.
 */
export function buildCustomerNotesContext(
  preferences: Preference[],
  memories: MemoryEntry[],
  question: string,
  maxTokens: number,
): CustomerNotesContext {
  const seenPreferences = new Set<string>();
  const uniquePreferences = preferences.filter((preference) => {
    const key = `${preference.category}:${normalize(preference.content)}`;
    if (seenPreferences.has(key)) return false;
    seenPreferences.add(key);
    return true;
  });

  const seenContent = new Set(uniquePreferences.map((preference) => normalize(preference.content)));
  const uniqueMemories = memories.filter((memory) => {
    const key = normalize(memory.content);
    if (seenContent.has(key)) return false;
    seenContent.add(key);
    return true;
  });

  const questionWords = words(question);
  const rankedMemories = uniqueMemories
    .map((memory) => {
      let score = 0;
      for (const word of words(memory.content)) if (questionWords.has(word)) score += 1;
      return { memory, score };
    })
    .sort((a, b) => b.score - a.score || b.memory.updatedAt.getTime() - a.memory.updatedAt.getTime() || a.memory.id.localeCompare(b.memory.id))
    .map(({ memory }) => memory);

  let used = estimateTokens(HEADER) + OMISSION_NOTE_TOKENS;
  let omitted = 0;
  const section = (title: string, lines: string[]) => {
    const included: string[] = [];
    for (const line of lines) {
      const cost = estimateTokens(line) + (included.length === 0 ? estimateTokens(title) : 0);
      if (used + cost > maxTokens) {
        omitted += 1;
        continue;
      }
      used += cost;
      included.push(line);
    }
    return included;
  };

  const preferenceLines = section(
    'Preferences:',
    uniquePreferences.map((preference) => `- [${preference.category}] ${preference.content} (recorded ${day(preference.updatedAt)})`),
  );
  const memoryLines = section(
    'Memory:',
    rankedMemories.map((memory) => `- ${memory.content} (recorded ${day(memory.updatedAt)})`),
  );

  if (preferenceLines.length === 0 && memoryLines.length === 0) {
    return { block: null, preferences: 0, memories: 0, omitted };
  }

  const block = [
    HEADER,
    ...(preferenceLines.length > 0 ? ['', 'Preferences:', ...preferenceLines] : []),
    ...(memoryLines.length > 0 ? ['', 'Memory:', ...memoryLines] : []),
    ...(omitted > 0 ? ['', OMISSION_NOTE(omitted)] : []),
  ].join('\n');
  return { block, preferences: preferenceLines.length, memories: memoryLines.length, omitted };
}

/**
 * doc08 "AI Relationship" / doc12 Context Builder for the customer's
 * merchant notes: the only way AI reads memory/preferences. Reads through
 * the memory/preference services, so it inherits their rules — workspace
 * scoped, active only, and a 404 for an unknown, other-workspace, merged
 * or erased customer (erasure deletes the rows, so nothing erased can
 * reach the model). Callers decide who may see it (Slice 4.3: Merchant
 * Business Analyst, owner/admin only).
 */
@Injectable()
export class CustomerContextBuilder {
  constructor(
    private readonly memory: CustomerMemoryService,
    private readonly preferences: CustomerPreferenceService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async build(workspaceId: string, canonicalCustomerId: string, question: string): Promise<CustomerNotesContext> {
    const [preferences, memories] = await Promise.all([
      this.preferences.list(workspaceId, canonicalCustomerId),
      this.memory.list(workspaceId, canonicalCustomerId),
    ]);
    return buildCustomerNotesContext(preferences, memories, question, this.config.get('AI_CUSTOMER_CONTEXT_MAX_TOKENS', { infer: true }));
  }
}
