import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { commerceCollections } from '../../database/schema/commerce-collections';
import { commerceCollectionProducts } from '../../database/schema/commerce-collection-products';
import { commerceProducts } from '../../database/schema/commerce-products';
import { DatabaseService } from '../../database/database.service';
import type { IntegrationProvider } from '../integration/dto/connect-integration.schema';

/** A provider's collection record, already mapped into BRAYN's shape (doc 06 — Normalization output). */
export interface NormalizedCollection {
  externalId: string;
  title: string;
  sourceUpdatedAt: Date | null;
}

/**
 * A provider's product-collection membership link (Shopify's `Collect`
 * resource) — its own top-level resource, not embedded in either side,
 * so it's fetched/applied independently of NormalizedCollection.
 */
export interface NormalizedCollect {
  externalId: string;
  collectionExternalId: string;
  productExternalId: string;
}

/**
 * Owns normalized commerce collection/membership records (doc 22 —
 * Commerce data area). Consumed by Integration's import/webhook pipeline;
 * never the reverse (doc 06 — Integration produces, the owning domain
 * stores).
 *
 * Membership (`upsertCollects`) is a separate method, not folded into
 * `upsertMany`, because Shopify's Collect resource is its own paginated
 * endpoint (`/collects.json`) with no relationship to a specific
 * collection page — unlike order line items/refunds, it isn't embedded
 * in the parent's payload.
 */
@Injectable()
export class CollectionService {
  constructor(private readonly database: DatabaseService) {}

  async upsertMany(
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    collections: NormalizedCollection[],
  ): Promise<number> {
    if (collections.length === 0) {
      return 0;
    }

    await this.database.client
      .insert(commerceCollections)
      .values(
        collections.map((collection) => ({
          workspaceId,
          integrationId,
          provider,
          externalId: collection.externalId,
          title: collection.title,
          sourceUpdatedAt: collection.sourceUpdatedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [commerceCollections.workspaceId, commerceCollections.provider, commerceCollections.externalId],
        set: {
          title: sql`excluded.title`,
          sourceUpdatedAt: sql`excluded.source_updated_at`,
          updatedAt: new Date(),
        },
      });

    return collections.length;
  }

  /**
   * Resolves each collect's collection/product by external id and writes
   * only the ones where both sides already exist — see
   * commerce_collection_products' doc comment for why a partial link
   * isn't written.
   */
  async upsertCollects(
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    collects: NormalizedCollect[],
  ): Promise<number> {
    if (collects.length === 0) {
      return 0;
    }

    const collectionIdByExternalId = await this.lookupIds(
      commerceCollections,
      workspaceId,
      provider,
      collects.map((c) => c.collectionExternalId),
    );
    const productIdByExternalId = await this.lookupIds(
      commerceProducts,
      workspaceId,
      provider,
      collects.map((c) => c.productExternalId),
    );

    const rows = collects.flatMap((collect) => {
      const collectionId = collectionIdByExternalId.get(collect.collectionExternalId);
      const productId = productIdByExternalId.get(collect.productExternalId);
      if (!collectionId || !productId) {
        return [];
      }
      return [{ workspaceId, integrationId, provider, collectionId, productId, externalId: collect.externalId }];
    });

    if (rows.length === 0) {
      return 0;
    }

    await this.database.client
      .insert(commerceCollectionProducts)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          commerceCollectionProducts.workspaceId,
          commerceCollectionProducts.provider,
          commerceCollectionProducts.externalId,
        ],
        set: {
          collectionId: sql`excluded.collection_id`,
          productId: sql`excluded.product_id`,
          updatedAt: new Date(),
        },
      });

    return rows.length;
  }

  /** This workspace/provider's current `sourceUpdatedAt` for each existing collection externalId (doc 06/20 — Reconciliation). Absent from the map means no such row exists yet. */
  async findExistingUpdatedAt(
    workspaceId: string,
    provider: IntegrationProvider,
    externalIds: string[],
  ): Promise<Map<string, Date | null>> {
    if (externalIds.length === 0) {
      return new Map();
    }

    const rows = await this.database.client
      .select({ externalId: commerceCollections.externalId, sourceUpdatedAt: commerceCollections.sourceUpdatedAt })
      .from(commerceCollections)
      .where(
        and(
          eq(commerceCollections.workspaceId, workspaceId),
          eq(commerceCollections.provider, provider),
          inArray(commerceCollections.externalId, externalIds),
        ),
      );

    return new Map(rows.map((row) => [row.externalId, row.sourceUpdatedAt]));
  }

  /** Resolves a batch of external ids to this workspace/provider's existing row ids for `table`. */
  private async lookupIds(
    table: typeof commerceCollections | typeof commerceProducts,
    workspaceId: string,
    provider: IntegrationProvider,
    externalIds: string[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(externalIds)];
    if (ids.length === 0) {
      return new Map();
    }

    const rows = await this.database.client
      .select({ id: table.id, externalId: table.externalId })
      .from(table)
      .where(and(eq(table.workspaceId, workspaceId), eq(table.provider, provider), inArray(table.externalId, ids)));

    return new Map(rows.map((row) => [row.externalId, row.id]));
  }
}
