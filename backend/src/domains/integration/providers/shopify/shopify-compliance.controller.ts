import { Controller, HttpCode, HttpStatus, Headers, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../../../common/auth/public.decorator';
import { ShopifyComplianceService } from './shopify-compliance.service';

/**
 * Workspace-agnostic — Shopify's three mandatory compliance webhooks
 * (`customers/data_request`, `customers/redact`, `shop/redact`) are
 * configured once per app in the Partner Dashboard and delivered to one
 * fixed URL for every shop, unlike the per-workspace topic webhooks
 * `WebhookController` handles. `@Public()` for the same reason as that
 * controller: a Shopify delivery carries no Clerk session — the HMAC
 * check inside `ShopifyComplianceService` (using `SHOPIFY_APP_CLIENT_SECRET`,
 * not a per-integration secret) is this request's actual authentication.
 */
@Controller('integrations/shopify/compliance')
export class ShopifyComplianceController {
  constructor(private readonly complianceService: ShopifyComplianceService) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(@Headers('x-shopify-topic') topic: string | undefined, @Req() request: FastifyRequest) {
    await this.complianceService.handle(topic ?? '', request.rawBody?.toString('utf8') ?? '', request.headers as Record<string, string>);
    return { received: true };
  }
}
