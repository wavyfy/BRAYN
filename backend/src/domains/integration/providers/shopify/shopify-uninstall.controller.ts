import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../../../common/auth/public.decorator';
import { SkipRateLimit } from '../../../../common/rate-limit/rate-limit.decorator';
import { ShopifyUninstallService } from './shopify-uninstall.service';

/**
 * App-level `app/uninstalled` endpoint (registered per shop by
 * ShopifyOAuthService). `@Public()` for the same reason as the compliance
 * route: the HMAC check against the app's client secret inside
 * ShopifyUninstallService is this request's authentication.
 */
@Controller('integrations/shopify/app-uninstalled')
export class ShopifyUninstallController {
  constructor(private readonly uninstallService: ShopifyUninstallService) {}

  @Public()
  @SkipRateLimit()
  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(@Req() request: FastifyRequest) {
    await this.uninstallService.handle(request.rawBody?.toString('utf8') ?? '', request.headers as Record<string, string>);
    return { received: true };
  }
}
