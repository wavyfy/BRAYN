import { Controller, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../common/auth/public.decorator';
import { WebhookIngestService } from './webhook-ingest.service';
import type { ConnectIntegrationInput } from './dto/connect-integration.schema';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by Nest's `rawBody: true` app option (see main.ts) — the exact request bytes, needed for webhook signature verification. */
    rawBody?: Buffer;
  }
}

/**
 * Separate from IntegrationController: a provider's webhook delivery
 * carries no Clerk session, so this route is `@Public()` and — unlike
 * every other integration route — deliberately does not sit behind
 * WorkspaceMembershipGuard (which requires an authenticated caller
 * regardless of `@Public()`; see workspace-membership.guard.ts). This
 * request's actual authentication is the signature check inside
 * WebhookIngestService, using this integration's stored secret.
 */
@Controller('workspaces/:workspaceId/integrations/:provider/webhooks')
export class WebhookController {
  constructor(private readonly webhookIngestService: WebhookIngestService) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param('workspaceId') workspaceId: string,
    @Param('provider') provider: ConnectIntegrationInput['provider'],
    @Req() request: FastifyRequest,
  ) {
    return this.webhookIngestService.ingest(
      workspaceId,
      provider,
      request.rawBody?.toString('utf8') ?? '',
      request.headers as Record<string, string>,
    );
  }
}
