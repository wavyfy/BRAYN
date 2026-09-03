import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceMembershipGuard } from './workspace-membership.guard';
import { RequestContext } from '../../common/logging/request-context';
import type { UserService } from './user.service';
import type { WorkspaceMembershipService } from './workspace-membership.service';

function makeContext(workspaceId: string, roles: string[] | undefined) {
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(roles);
  const request = { params: { workspaceId } };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
  return { context, reflector };
}

describe('WorkspaceMembershipGuard', () => {
  it('throws UnauthenticatedError when RequestContext has no userId', async () => {
    const userService = { findOrCreateByClerkId: vi.fn() };
    const membershipService = { findMembership: vi.fn() };
    const { context, reflector } = makeContext('ws_1', undefined);
    const guard = new WorkspaceMembershipGuard(
      reflector,
      userService as unknown as UserService,
      membershipService as unknown as WorkspaceMembershipService,
    );

    await RequestContext.run({ correlationId: 'c1' }, async () => {
      await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    });
    expect(userService.findOrCreateByClerkId).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedError when the caller has no membership in the workspace', async () => {
    const userService = { findOrCreateByClerkId: vi.fn(async () => ({ id: 'user_1' })) };
    const membershipService = { findMembership: vi.fn(async () => null) };
    const { context, reflector } = makeContext('ws_1', undefined);
    const guard = new WorkspaceMembershipGuard(
      reflector,
      userService as unknown as UserService,
      membershipService as unknown as WorkspaceMembershipService,
    );

    await RequestContext.run({ correlationId: 'c1', userId: 'clerk_1' }, async () => {
      await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  it('throws UnauthorizedError when the caller is a member but lacks the required role', async () => {
    const userService = { findOrCreateByClerkId: vi.fn(async () => ({ id: 'user_1' })) };
    const membershipService = {
      findMembership: vi.fn(async () => ({ id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role: 'support' })),
    };
    const { context, reflector } = makeContext('ws_1', ['owner', 'admin']);
    const guard = new WorkspaceMembershipGuard(
      reflector,
      userService as unknown as UserService,
      membershipService as unknown as WorkspaceMembershipService,
    );

    await RequestContext.run({ correlationId: 'c1', userId: 'clerk_1' }, async () => {
      await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  it('allows the request and sets RequestContext.workspaceId when the role check passes', async () => {
    const userService = { findOrCreateByClerkId: vi.fn(async () => ({ id: 'user_1' })) };
    const membershipService = {
      findMembership: vi.fn(async () => ({ id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role: 'owner' })),
    };
    const { context, reflector } = makeContext('ws_1', ['owner', 'admin']);
    const guard = new WorkspaceMembershipGuard(
      reflector,
      userService as unknown as UserService,
      membershipService as unknown as WorkspaceMembershipService,
    );

    await RequestContext.run({ correlationId: 'c1', userId: 'clerk_1' }, async () => {
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
      expect(RequestContext.get()?.workspaceId).toBe('ws_1');
    });
  });

  it('allows any member when no roles are required', async () => {
    const userService = { findOrCreateByClerkId: vi.fn(async () => ({ id: 'user_1' })) };
    const membershipService = {
      findMembership: vi.fn(async () => ({ id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role: 'analyst' })),
    };
    const { context, reflector } = makeContext('ws_1', undefined);
    const guard = new WorkspaceMembershipGuard(
      reflector,
      userService as unknown as UserService,
      membershipService as unknown as WorkspaceMembershipService,
    );

    await RequestContext.run({ correlationId: 'c1', userId: 'clerk_1' }, async () => {
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });
  });
});
