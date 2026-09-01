import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { integrations } from '../../database/schema/integrations';
import { ConflictError, NotFoundError, ProviderError } from '../../common/errors/app-error';
import {
  decryptCredential,
  encryptCredential,
  InvalidEncryptionKeyError,
  parseEncryptionKey,
} from '../../common/crypto/credential-cipher';
import type { IntegrationProvider } from './dto/connect-integration.schema';
import type { Env } from '../../config/env.schema';

/**
 * Columns safe to return from the API. Excludes `credentials` — the
 * encrypted payload must never leave the service layer (doc 18: provider
 * credentials are never exposed to users or AI).
 */
const integrationPublicColumns = {
  id: integrations.id,
  workspaceId: integrations.workspaceId,
  provider: integrations.provider,
  status: integrations.status,
  createdAt: integrations.createdAt,
  updatedAt: integrations.updatedAt,
};

@Injectable()
export class IntegrationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async listByWorkspace(workspaceId: string) {
    return this.database.client
      .select(integrationPublicColumns)
      .from(integrations)
      .where(eq(integrations.workspaceId, workspaceId));
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
        .returning(integrationPublicColumns);

      return reconnected;
    }

    const [created] = await this.database.client
      .insert(integrations)
      .values({ workspaceId, provider })
      .returning(integrationPublicColumns);

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
      .returning(integrationPublicColumns);

    return updated;
  }

  /**
   * Encrypts and stores a provider's credential payload. Internal-only —
   * not exposed through the controller; provider-specific connect flows
   * (Phase 4) call this after completing their own auth handshake.
   */
  async setCredentials(
    workspaceId: string,
    provider: IntegrationProvider,
    credentials: Record<string, string>,
  ): Promise<void> {
    const existing = await this.findByProvider(workspaceId, provider);
    if (!existing) {
      throw new NotFoundError('This workspace has no connection for that provider.');
    }

    const key = this.resolveEncryptionKey();
    const encrypted = encryptCredential(JSON.stringify(credentials), key);

    await this.database.client.update(integrations).set({ credentials: encrypted }).where(eq(integrations.id, existing.id));
  }

  /** Decrypts a provider's stored credential payload. Internal-only, same as setCredentials(). */
  async getCredentials(workspaceId: string, provider: IntegrationProvider): Promise<Record<string, string> | null> {
    const existing = await this.findByProvider(workspaceId, provider);
    if (!existing?.credentials) {
      return null;
    }

    const key = this.resolveEncryptionKey();
    return JSON.parse(decryptCredential(existing.credentials, key)) as Record<string, string>;
  }

  private resolveEncryptionKey() {
    try {
      return parseEncryptionKey(this.config.get('BRAYN_CREDENTIAL_ENCRYPTION_KEY', { infer: true }));
    } catch (error) {
      if (error instanceof InvalidEncryptionKeyError) {
        // Fail closed rather than silently storing/returning credentials
        // unprotected — see "18. BRAYN Security, Observability & Reliability".
        throw new ProviderError('Credential encryption is not configured.');
      }
      throw error;
    }
  }
}
