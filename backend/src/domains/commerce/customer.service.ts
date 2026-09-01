import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { DatabaseService } from '../../database/database.service';
import type { IntegrationProvider } from '../integration/dto/connect-integration.schema';

/** A provider's customer record, already mapped into BRAYN's shape (doc 06 — Normalization output). */
export interface NormalizedCustomer {
  externalId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  sourceUpdatedAt: Date | null;
}

/**
 * Owns normalized commerce customer records (doc 22 — Commerce data area).
 * Consumed by Integration's import/webhook pipeline; never the reverse
 * (doc 06 — Integration produces, the owning domain stores).
 */
@Injectable()
export class CustomerService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Inserts or updates customers keyed on (workspace, provider, externalId)
   * — doc 20 Idempotency: "repeated imports" and "reconciliation" must not
   * create duplicate records. Returns the number of rows written.
   */
  async upsertMany(
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    customers: NormalizedCustomer[],
  ): Promise<number> {
    if (customers.length === 0) {
      return 0;
    }

    await this.database.client
      .insert(commerceCustomers)
      .values(
        customers.map((customer) => ({
          workspaceId,
          integrationId,
          provider,
          ...customer,
        })),
      )
      .onConflictDoUpdate({
        target: [commerceCustomers.workspaceId, commerceCustomers.provider, commerceCustomers.externalId],
        set: {
          email: sql`excluded.email`,
          firstName: sql`excluded.first_name`,
          lastName: sql`excluded.last_name`,
          phone: sql`excluded.phone`,
          sourceUpdatedAt: sql`excluded.source_updated_at`,
          updatedAt: new Date(),
        },
      });

    return customers.length;
  }

  /** This workspace/provider's current `sourceUpdatedAt` for each existing externalId (doc 06/20 — Reconciliation: detect missing/changed records before repairing). Absent from the map means no such row exists yet. */
  async findExistingUpdatedAt(
    workspaceId: string,
    provider: IntegrationProvider,
    externalIds: string[],
  ): Promise<Map<string, Date | null>> {
    if (externalIds.length === 0) {
      return new Map();
    }

    const rows = await this.database.client
      .select({ externalId: commerceCustomers.externalId, sourceUpdatedAt: commerceCustomers.sourceUpdatedAt })
      .from(commerceCustomers)
      .where(
        and(
          eq(commerceCustomers.workspaceId, workspaceId),
          eq(commerceCustomers.provider, provider),
          inArray(commerceCustomers.externalId, externalIds),
        ),
      );

    return new Map(rows.map((row) => [row.externalId, row.sourceUpdatedAt]));
  }
}
