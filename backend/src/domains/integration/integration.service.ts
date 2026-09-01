import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { integrations } from '../../database/schema/integrations';
import { ConflictError, NotFoundError } from '../../common/errors/app-error';
import type { IntegrationProvider } from './dto/connect-integration.schema';

@Injectable()
export class IntegrationService {
  constructor(private readonly database: DatabaseService) {}

  async listByWorkspace(workspaceId: string) {
    return this.database.client.select().from(integrations).where(eq(integrations.workspaceId, workspaceId));
  }

  private async findByProvider(workspaceId: string, provider: IntegrationProvider) {
    const [integration] = await this.database.client
      .select()
      .from(integrations)
      .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, provider)))
      .limit(1);

    return integration ?? null;
  }

  /** Connects a provider, or reconnects one this workspace previously disconnected. */
  async connect(workspaceId: string, provider: IntegrationProvider) {
    const existing = await this.findByProvider(workspaceId, provider);

    if (existing?.status === 'connected') {
      throw new ConflictError('This provider is already connected.');
    }

    if (existing) {
      const [reconnected] = await this.database.client
        .update(integrations)
        .set({ status: 'connected' })
        .where(eq(integrations.id, existing.id))
        .returning();

      return reconnected;
    }

    const [created] = await this.database.client.insert(integrations).values({ workspaceId, provider }).returning();

    return created;
  }

  async disconnect(workspaceId: string, provider: IntegrationProvider) {
    const existing = await this.findByProvider(workspaceId, provider);
    if (!existing) {
      throw new NotFoundError('This workspace has no connection for that provider.');
    }

    const [updated] = await this.database.client
      .update(integrations)
      .set({ status: 'disconnected' })
      .where(eq(integrations.id, existing.id))
      .returning();

    return updated;
  }
}
