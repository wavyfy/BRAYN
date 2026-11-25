import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { Env } from '../../../../config/env.schema';
import { NotFoundError } from '../../../../common/errors/app-error';
import { IntegrationService } from '../../integration.service';
import { FLEXYPE_PROCESSED_EVENT_TYPES, FLEXYPE_WEBHOOK_VERSION } from './flexype.adapter';

export interface FlexyPeWebhookSettings {
  webhookUrl: string;
  webhookVersion: string;
  eventTypes: readonly string[];
  secretConfigured: boolean;
}

/**
 * Manual FlexyPe webhook setup — same pattern as WooCommerceWebhookSetupService: BRAYN generates the secret, stores
 * it encrypted as `webhookSecret` (the field WebhookIngestService verifies against), returns it exactly once, and the
 * merchant enters the URL, version and secret in the FlexyPe dashboard (Abandoned Checkout webhook destination).
 * Settings never return the secret; generating again rotates it (the old one stops verifying immediately).
 */
@Injectable()
export class FlexyPeWebhookSetupService {
  constructor(
    private readonly integrationService: IntegrationService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async getSettings(workspaceId: string): Promise<FlexyPeWebhookSettings> {
    const credentials = await this.integrationService.getCredentials(workspaceId, 'flexype');
    return this.settings(workspaceId, Boolean(credentials?.webhookSecret));
  }

  async generateSecret(
    workspaceId: string,
  ): Promise<FlexyPeWebhookSettings & { webhookSecret: string }> {
    const integration = (await this.integrationService.listByWorkspace(workspaceId)).find(
      (row) => row.provider === 'flexype',
    );
    if (!integration || integration.status === 'disconnected') {
      throw new NotFoundError('Connect FlexyPe before setting up its webhook.');
    }
    const credentials =
      (await this.integrationService.getCredentials(workspaceId, 'flexype')) ?? {};
    const webhookSecret = randomBytes(32).toString('base64url');
    await this.integrationService.setCredentials(workspaceId, 'flexype', {
      ...credentials,
      webhookSecret,
    });
    return { ...this.settings(workspaceId, true), webhookSecret };
  }

  private settings(workspaceId: string, secretConfigured: boolean): FlexyPeWebhookSettings {
    return {
      webhookUrl: `${this.config.get('BACKEND_URL', { infer: true })}/api/v1/workspaces/${workspaceId}/integrations/flexype/webhooks`,
      webhookVersion: FLEXYPE_WEBHOOK_VERSION,
      eventTypes: FLEXYPE_PROCESSED_EVENT_TYPES,
      secretConfigured,
    };
  }
}
