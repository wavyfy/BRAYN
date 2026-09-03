import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { commerceProducts } from '../../database/schema/commerce-products';
import { commerceProductVariants } from '../../database/schema/commerce-product-variants';
import { DatabaseService } from '../../database/database.service';
import type { IntegrationProvider } from '../integration/dto/connect-integration.schema';

export interface NormalizedVariant {
  externalId: string;
  sku: string | null;
  price: string | null;
  inventoryQuantity: number | null;
  sourceUpdatedAt: Date | null;
}

/** A provider's product record, already mapped into BRAYN's shape (doc 06 — Normalization output). */
export interface NormalizedProduct {
  externalId: string;
  title: string;
  sourceUpdatedAt: Date | null;
  variants: NormalizedVariant[];
}

/**
 * Owns normalized commerce product/variant records (doc 22 — Commerce data
 * area). Consumed by Integration's import/webhook pipeline; never the
 * reverse (doc 06 — Integration produces, the owning domain stores).
 */
@Injectable()
export class ProductService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Inserts or updates products (keyed on workspace+provider+externalId)
   * and their variants (same key shape) — doc 20 Idempotency: repeated
   * imports/reconciliation must not create duplicates. Variants are
   * linked to their parent product via the ids `products` upsert returns,
   * not the input order, so this is safe to call with partial re-imports.
   */
  async upsertMany(
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    products: NormalizedProduct[],
  ): Promise<{ productsWritten: number; variantsWritten: number }> {
    if (products.length === 0) {
      return { productsWritten: 0, variantsWritten: 0 };
    }

    const productRows = await this.database.client
      .insert(commerceProducts)
      .values(
        products.map((product) => ({
          workspaceId,
          integrationId,
          provider,
          externalId: product.externalId,
          title: product.title,
          sourceUpdatedAt: product.sourceUpdatedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [commerceProducts.workspaceId, commerceProducts.provider, commerceProducts.externalId],
        set: {
          title: sql`excluded.title`,
          sourceUpdatedAt: sql`excluded.source_updated_at`,
          updatedAt: new Date(),
        },
      })
      .returning({ id: commerceProducts.id, externalId: commerceProducts.externalId });

    const productIdByExternalId = new Map(productRows.map((row) => [row.externalId, row.id]));

    const variantValues = products.flatMap((product) => {
      const productId = productIdByExternalId.get(product.externalId);
      if (!productId) {
        return [];
      }
      return product.variants.map((variant) => ({
        workspaceId,
        integrationId,
        provider,
        productId,
        ...variant,
      }));
    });

    if (variantValues.length > 0) {
      await this.database.client
        .insert(commerceProductVariants)
        .values(variantValues)
        .onConflictDoUpdate({
          target: [
            commerceProductVariants.workspaceId,
            commerceProductVariants.provider,
            commerceProductVariants.externalId,
          ],
          set: {
            sku: sql`excluded.sku`,
            price: sql`excluded.price`,
            inventoryQuantity: sql`excluded.inventory_quantity`,
            sourceUpdatedAt: sql`excluded.source_updated_at`,
            updatedAt: new Date(),
          },
        });
    }

    return { productsWritten: products.length, variantsWritten: variantValues.length };
  }

  /** This workspace/provider's current `sourceUpdatedAt` for each existing product externalId (doc 06/20 — Reconciliation: detect missing/changed records before repairing; variant-level drift isn't tracked separately). Absent from the map means no such row exists yet. */
  async findExistingUpdatedAt(
    workspaceId: string,
    provider: IntegrationProvider,
    externalIds: string[],
  ): Promise<Map<string, Date | null>> {
    if (externalIds.length === 0) {
      return new Map();
    }

    const rows = await this.database.client
      .select({ externalId: commerceProducts.externalId, sourceUpdatedAt: commerceProducts.sourceUpdatedAt })
      .from(commerceProducts)
      .where(
        and(
          eq(commerceProducts.workspaceId, workspaceId),
          eq(commerceProducts.provider, provider),
          inArray(commerceProducts.externalId, externalIds),
        ),
      );

    return new Map(rows.map((row) => [row.externalId, row.sourceUpdatedAt]));
  }
}
