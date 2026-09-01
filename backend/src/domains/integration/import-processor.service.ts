import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { DomainEvent } from '../../common/events/domain-event';
import { CustomerService } from '../commerce/customer.service';
import { ImportRunService } from './import-run.service';
import { IntegrationService } from './integration.service';
import { ProviderRegistry } from './provider-registry.service';
import type { IntegrationProvider } from './dto/connect-integration.schema';

export interface ImportRequestedPayload {
  provider: IntegrationProvider;
  runId: string;
}

/**
 * Drives the initial-import pagination loop (doc 06/20 — Initial Import:
 * pagination, progress tracking, partial-failure handling, completion
 * state). Reacts to `integration.import.requested` off the request that
 * triggered it (doc 07 — event/job, not direct call, since this is
 * long-running and talks to an external system).
 *
 * ponytail: a page whose upsert throws counts every record on that page as
 * failed rather than isolating which record broke — per-record partial
 * failure needs re-fetching/re-validating individually, add when a real
 * provider payload demonstrates it's needed.
 */
@Injectable()
export class ImportProcessorService {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly importRunService: ImportRunService,
    private readonly integrationService: IntegrationService,
    private readonly customerService: CustomerService,
  ) {}

  @OnEvent('integration.import.requested')
  async handleImportRequested(event: DomainEvent<ImportRequestedPayload>): Promise<void> {
    const workspaceId = event.workspaceId;
    const integrationId = event.entityId;
    const { provider, runId } = event.payload;
    if (!workspaceId || !integrationId) {
      await this.importRunService.failImportRun(runId, 'Import event was missing workspace or integration context.');
      return;
    }

    const credentials = await this.integrationService.getCredentials(workspaceId, provider);
    if (!credentials) {
      await this.importRunService.failImportRun(runId, 'No credentials stored for this provider.');
      return;
    }

    const adapter = this.providerRegistry.get(provider);
    let cursor: string | undefined;
    let imported = 0;
    let failed = 0;

    try {
      do {
        const page = await adapter.fetchCustomers!(credentials, cursor);
        try {
          imported += await this.customerService.upsertMany(workspaceId, integrationId, provider, page.customers);
        } catch {
          failed += page.customers.length;
        }
        cursor = page.nextCursor ?? undefined;
        await this.importRunService.recordProgress(runId, { recordsImported: imported, recordsFailed: failed, cursor });
      } while (cursor);

      await this.importRunService.completeImportRun(runId);
    } catch (error) {
      await this.importRunService.failImportRun(runId, error instanceof Error ? error.message : 'Unknown import error.');
    }
  }
}
