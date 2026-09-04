import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodValidationPipe } from '../../../../common/api/zod-validation.pipe';
import { Public } from '../../../../common/auth/public.decorator';
import { AllowQueryToken } from '../../../../common/auth/allow-query-token.decorator';
import { WorkspaceMembershipGuard } from '../../../workspace/workspace-membership.guard';
import { RequireWorkspaceRole } from '../../../workspace/require-workspace-role.decorator';
import { ShopifyOAuthService, STATE_COOKIE_NAME } from './shopify-oauth.service';
import { startShopifyOAuthSchema, type StartShopifyOAuthInput } from './dto/start-shopify-oauth.schema';

/** Scoped to exactly the two routes that need it — least-privilege cookie exposure. */
const STATE_COOKIE_PATH = '/api/v1/integrations/shopify/oauth';

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/**
 * Split across two controllers deliberately (doc 05/28 Authorization
 * flow): `start` is a normal authenticated workspace action — same
 * WorkspaceMembershipGuard/RequireWorkspaceRole every other integration
 * mutation uses. `callback` carries no BRAYN session at all (Shopify
 * redirects the merchant's browser directly to it, same reasoning as
 * WebhookController) — `state` plus the session-binding cookie is what
 * authenticates it, not a bearer token, so it lives outside
 * `workspaces/:workspaceId` and is `@Public()`.
 *
 * `start` is a top-level browser navigation (GET), not a cross-origin
 * fetch — the merchant's browser hits this backend host directly as its
 * own top-level document, which is what lets the session-binding cookie
 * be stored as first-party (see ShopifyConnect on the frontend, and the
 * cookie doc comment on STATE_COOKIE_NAME in shopify-oauth.service.ts).
 * A top-level navigation can't attach an Authorization header, so this
 * route opts into AuthGuard's `?token=` query fallback via
 * @AllowQueryToken() instead — every other route still requires the
 * header.
 */
@Controller('workspaces/:workspaceId/integrations/shopify/oauth')
@UseGuards(WorkspaceMembershipGuard)
export class ShopifyOAuthStartController {
  constructor(private readonly shopifyOAuthService: ShopifyOAuthService) {}

  @Get('start')
  @AllowQueryToken()
  @RequireWorkspaceRole('owner', 'admin')
  start(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(startShopifyOAuthSchema)) query: StartShopifyOAuthInput,
    @Res() reply: FastifyReply,
  ) {
    const { authorizeUrl, cookieValue, cookieMaxAgeSeconds } = this.shopifyOAuthService.buildAuthorizeUrl(workspaceId, query.shopDomain);
    reply
      .header(
        'set-cookie',
        `${STATE_COOKIE_NAME}=${encodeURIComponent(cookieValue)}; HttpOnly; Secure; SameSite=Lax; Max-Age=${cookieMaxAgeSeconds}; Path=${STATE_COOKIE_PATH}`,
      )
      .status(302)
      .header('location', authorizeUrl)
      .send();
  }

  /**
   * Client-credentials grant (doc — ShopifyOAuthService.connectViaClientCredentials):
   * a direct, synchronous connect for a shop in BRAYN's own Shopify
   * organization — no redirect, no cookie, so no `Res` handling needed
   * here unlike `start`.
   */
  @Post('client-credentials')
  @RequireWorkspaceRole('owner', 'admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async connectViaClientCredentials(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(startShopifyOAuthSchema)) body: StartShopifyOAuthInput,
  ) {
    await this.shopifyOAuthService.connectViaClientCredentials(workspaceId, body.shopDomain);
  }
}

@Controller('integrations/shopify/oauth')
export class ShopifyOAuthCallbackController {
  constructor(private readonly shopifyOAuthService: ShopifyOAuthService) {}

  @Public()
  @Get('callback')
  async callback(@Query() query: Record<string, string | undefined>, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const cookieValue = readCookie(request, STATE_COOKIE_NAME);
    const redirectUrl = await this.shopifyOAuthService.handleCallback(query, cookieValue);
    reply
      .status(302)
      .header('set-cookie', `${STATE_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=${STATE_COOKIE_PATH}`)
      .header('location', redirectUrl)
      .send();
  }
}
