import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodValidationPipe } from '../../../../common/api/zod-validation.pipe';
import { Public } from '../../../../common/auth/public.decorator';
import { WorkspaceMembershipGuard } from '../../../workspace/workspace-membership.guard';
import { RequireWorkspaceRole } from '../../../workspace/require-workspace-role.decorator';
import { RequestContext } from '../../../../common/logging/request-context';
import { UnauthenticatedError } from '../../../../common/errors/app-error';
import { ShopifyOAuthService, STATE_COOKIE_NAME } from './shopify-oauth.service';
import { ShopifyOAuthHandoffService } from './shopify-oauth-handoff.service';
import { ShopifyOAuthHandoffGuard } from './shopify-oauth-handoff.guard';
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
 * A top-level navigation can't attach an Authorization header, and the
 * real Clerk JWT must never appear in a URL (doc 20 Part 4B) — so `start`
 * is `@Public()` (skips the global AuthGuard's own check) and instead
 * authenticates via `ShopifyOAuthHandoffGuard`, which consumes a
 * short-lived single-use handoff token minted by `mintHandoffToken`
 * below. `WorkspaceMembershipGuard` is applied per-method rather than at
 * class level specifically so it can run *after* the handoff guard on
 * `start` (Nest always runs class-level guards before method-level
 * ones, and WorkspaceMembershipGuard needs RequestContext.userId, which
 * only the handoff guard sets for this route) — `mintHandoffToken` and
 * `client-credentials` keep the same header-based AuthGuard everything
 * else uses, so this is purely a route-ordering fix for `start`.
 */
@Controller('workspaces/:workspaceId/integrations/shopify/oauth')
export class ShopifyOAuthStartController {
  constructor(
    private readonly shopifyOAuthService: ShopifyOAuthService,
    private readonly handoffService: ShopifyOAuthHandoffService,
  ) {}

  /**
   * Mints the single-use handoff token `start` consumes — a normal
   * authenticated call (Authorization header, no cookie in the
   * response), made by the frontend just before it navigates. 60s TTL,
   * bound to the caller's clerkUserId and this workspace.
   */
  @Post('handoff-token')
  @UseGuards(WorkspaceMembershipGuard)
  @RequireWorkspaceRole('owner', 'admin')
  async mintHandoffToken(@Param('workspaceId') workspaceId: string) {
    const clerkUserId = RequestContext.get()?.userId;
    if (!clerkUserId) {
      // AuthGuard already guarantees this is set for a non-@Public() route — fail closed if that ever stops being true.
      throw new UnauthenticatedError('A bearer token is required.');
    }
    const { token, expiresAt } = await this.handoffService.mint(clerkUserId, workspaceId);
    return { handoffToken: token, expiresAt: expiresAt.toISOString() };
  }

  @Public()
  @Get('start')
  @UseGuards(ShopifyOAuthHandoffGuard, WorkspaceMembershipGuard)
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
  @UseGuards(WorkspaceMembershipGuard)
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
    // request.url is the raw, undecoded path+query as received — needed so verifyHmac
    // can percent-decode without Fastify's @Query() form-decoding a literal '+' into a space first.
    const queryIndex = request.url.indexOf('?');
    const rawQuery = queryIndex === -1 ? '' : request.url.slice(queryIndex + 1);
    const redirectUrl = await this.shopifyOAuthService.handleCallback(query, cookieValue, rawQuery);
    reply
      .status(302)
      .header('set-cookie', `${STATE_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=${STATE_COOKIE_PATH}`)
      .header('location', redirectUrl)
      .send();
  }
}
