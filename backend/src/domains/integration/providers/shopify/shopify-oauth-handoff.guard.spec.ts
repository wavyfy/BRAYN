import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ShopifyOAuthHandoffGuard } from './shopify-oauth-handoff.guard';
import { RequestContext } from '../../../../common/logging/request-context';
import type { ShopifyOAuthHandoffService } from './shopify-oauth-handoff.service';

function makeContext(workspaceId: string, query: Record<string, string | undefined>) {
  const request = { params: { workspaceId }, query };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('ShopifyOAuthHandoffGuard', () => {
  it('rejects when no ?handoff= query param is present', async () => {
    const handoffService = { consume: vi.fn() };
    const guard = new ShopifyOAuthHandoffGuard(handoffService as unknown as ShopifyOAuthHandoffService);
    const { context } = makeContext('ws_1', {});

    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(handoffService.consume).not.toHaveBeenCalled();
  });

  it('rejects when the handoff service reports the token invalid, expired, consumed, or workspace-mismatched', async () => {
    const handoffService = { consume: vi.fn(async () => null) };
    const guard = new ShopifyOAuthHandoffGuard(handoffService as unknown as ShopifyOAuthHandoffService);
    const { context } = makeContext('ws_1', { handoff: 'bad-token' });

    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(handoffService.consume).toHaveBeenCalledWith('bad-token', 'ws_1');
  });

  it('consumes the token scoped to the route\'s workspaceId, and populates RequestContext/request.userId on success', async () => {
    const handoffService = { consume: vi.fn(async () => ({ clerkUserId: 'clerk_1' })) };
    const guard = new ShopifyOAuthHandoffGuard(handoffService as unknown as ShopifyOAuthHandoffService);
    const { context, request } = makeContext('ws_1', { handoff: 'good-token' });

    await RequestContext.run({ correlationId: 'c1' }, async () => {
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
      expect(RequestContext.get()?.userId).toBe('clerk_1');
    });

    expect(handoffService.consume).toHaveBeenCalledWith('good-token', 'ws_1');
    expect((request as unknown as { userId: string }).userId).toBe('clerk_1');
  });
});
