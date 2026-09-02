import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { integrations } from '../../database/schema/integrations';
import { ConflictError, NotFoundError, ProviderError, UnauthenticatedError } from '../../common/errors/app-error';
import {
  decryptCredential,
  encryptCredential,
  InvalidEncryptionKeyError,
  parseEncryptionKey,
} from '../../common/crypto/credential-cipher';
import { createEvent } from '../../common/events/domain-event';
import { EventBus } from '../../common/events/event-bus.service';
import { ImportRunService } from './import-run.service';
import { ReconciliationRunService } from './reconciliation-run.service';
import { ProviderRegistry } from './provider-registry.service';
import type { ImportRequestedPayload } from './import-processor.service';
import type { ReconciliationRequestedPayload } from './reconciliation-processor.service';
import type { SyncRequestedPayload } from './sync-processor.service';
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
  lastSyncedAt: integrations.lastSyncedAt,
  lastSyncError: integrations.lastSyncError,
  createdAt: integrations.createdAt,
  updatedAt: integrations.updatedAt,
};

@Injectable()
export class IntegrationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Env, true>,
    private readonly providerRegistry: ProviderRegistry,
    private readonly importRunService: ImportRunService,
    private readonly reconciliationRunService: ReconciliationRunService,
    private readonly eventBus: EventBus,
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

    if (existing && existing.status !== 'disconnected') {
      throw new ConflictError('This provider is already connected.');
    }

    if (existing) {
      const [reconnected] = await this.database.client
        .update(integrations)
        .set({ status: 'connected', lastSyncError: null })
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
      .set({ status: 'disconnected', lastSyncError: null })
      .where(eq(integrations.id, existing.id))
      .returning(integrationPublicColumns);

    return updated;
  }

  /**
   * Marks a sync run as started. Requires an existing connection that
   * isn't already mid-sync (doc 07 — idempotency: don't let two syncs run
   * concurrently for the same integration); allowed from `connected` or a
   * prior `error` (retry).
   */
  async startSync(workspaceId: string, provider: IntegrationProvider) {
    const existing = await this.findByProvider(workspaceId, provider);
    if (!existing) {
      throw new NotFoundError('This workspace has no connection for that provider.');
    }
    if (existing.status === 'disconnected') {
      throw new ConflictError('Cannot sync a disconnected integration.');
    }
    if (existing.status === 'syncing') {
      throw new ConflictError('A sync is already in progress for this provider.');
    }

    const [updated] = await this.database.client
      .update(integrations)
      .set({ status: 'syncing', lastSyncError: null })
      .where(eq(integrations.id, existing.id))
      .returning(integrationPublicColumns);

    return updated;
  }

  /** Marks an in-progress sync as succeeded. Requires startSync() to have been called first. */
  async completeSync(workspaceId: string, provider: IntegrationProvider) {
    const existing = await this.findByProvider(workspaceId, provider);
    if (!existing) {
      throw new NotFoundError('This workspace has no connection for that provider.');
    }
    if (existing.status !== 'syncing') {
      throw new ConflictError('No sync is in progress for this provider.');
    }

    const [updated] = await this.database.client
      .update(integrations)
      .set({ status: 'connected', lastSyncedAt: new Date(), lastSyncError: null })
      .where(eq(integrations.id, existing.id))
      .returning(integrationPublicColumns);

    return updated;
  }

  /** Marks an in-progress sync as failed. Requires startSync() to have been called first. */
  async failSync(workspaceId: string, provider: IntegrationProvider, error: string) {
    const existing = await this.findByProvider(workspaceId, provider);
    if (!existing) {
      throw new NotFoundError('This workspace has no connection for that provider.');
    }
    if (existing.status !== 'syncing') {
      throw new ConflictError('No sync is in progress for this provider.');
    }

    const [updated] = await this.database.client
      .update(integrations)
      .set({ status: 'error', lastSyncError: error })
      .where(eq(integrations.id, existing.id))
      .returning(integrationPublicColumns);

    return updated;
  }

  /**
   * Starts a background incremental sync (doc 06/20 — Incremental
   * Synchronization: the catch-up mechanism after webhooks, before
   * reconciliation), same async-job shape as startInitialImport/
   * startReconciliation. `startSync()` does the state transition and
   * returns the row still carrying the *previous* `lastSyncedAt` — exactly
   * the cursor SyncProcessorService needs to ask the provider "what
   * changed since then." Falls back to `createdAt` (connect time) if this
   * integration has never completed a sync.
   */
  async startIncrementalSync(workspaceId: string, provider: IntegrationProvider) {
    const adapter = this.providerRegistry.get(provider);
    if (!adapter.fetchCustomers) {
      throw new ProviderError(`Provider "${provider}" does not support incremental synchronization.`);
    }

    const updated = await this.startSync(workspaceId, provider);
    const updatedAtMin = updated.lastSyncedAt ?? updated.createdAt;

    this.eventBus.emit(
      createEvent<SyncRequestedPayload>({
        type: 'integration.sync.requested',
        workspaceId,
        entityId: updated.id,
        payload: { provider, updatedAtMin: updatedAtMin.toISOString() },
      }),
    );

    return updated;
  }

  /**
   * Verifies `credentials` against the provider (via its registered
   * ProviderAdapter) before storing them — never persist a credential the
   * provider itself rejects. This is what the controller's credentials
   * endpoint calls; setCredentials()/getCredentials() stay available for
   * internal use (e.g. a future OAuth callback storing a token it already
   * verified as part of the exchange itself).
   */
  async connectCredentials(
    workspaceId: string,
    provider: IntegrationProvider,
    credentials: Record<string, string>,
  ): Promise<void> {
    const adapter = this.providerRegistry.get(provider);
    const verified = await adapter.verifyConnection(credentials);
    if (!verified) {
      throw new UnauthenticatedError('Could not verify these credentials with the provider.');
    }

    await this.setCredentials(workspaceId, provider, credentials);
  }

  /**
   * Starts a background initial import (doc 20 — Initial Import; doc 23
   * Async Operations — "return an operation/job reference instead of
   * blocking the request"). Creates the run row synchronously (so the
   * caller gets an id to poll) then hands the actual paginated fetch to
   * ImportProcessorService via an event, off the request.
   */
  async startInitialImport(workspaceId: string, provider: IntegrationProvider) {
    const adapter = this.providerRegistry.get(provider);
    if (!adapter.fetchCustomers) {
      throw new ProviderError(`Provider "${provider}" does not support customer import.`);
    }

    const run = await this.importRunService.startImportRun(workspaceId, provider);

    this.eventBus.emit(
      createEvent<ImportRequestedPayload>({
        type: 'integration.import.requested',
        workspaceId,
        entityId: run.integrationId,
        payload: { provider, runId: run.id },
      }),
    );

    return run;
  }

  /**
   * Starts a manual reconciliation pass (doc 06/19/20 — Reconciliation:
   * detect/repair drift against provider state), same async-job shape as
   * startInitialImport. `manual` is the only trigger a caller can invoke
   * this way — the other triggers doc 06 lists (scheduled, sync_completion,
   * detected_inconsistency) need a scheduler/hook that doesn't exist yet
   * (doc 29 §32 defers queue/worker technology).
   */
  async startReconciliation(workspaceId: string, provider: IntegrationProvider) {
    const adapter = this.providerRegistry.get(provider);
    if (!adapter.fetchCustomers) {
      throw new ProviderError(`Provider "${provider}" does not support reconciliation.`);
    }

    const run = await this.reconciliationRunService.startReconciliationRun(workspaceId, provider, 'manual');

    this.eventBus.emit(
      createEvent<ReconciliationRequestedPayload>({
        type: 'integration.reconciliation.requested',
        workspaceId,
        entityId: run.integrationId,
        payload: { provider, runId: run.id },
      }),
    );

    return run;
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
