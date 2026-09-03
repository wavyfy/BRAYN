import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationController } from './conversation.controller';
import { ConversationService } from './conversation.service';
import { UserService } from '../workspace/user.service';
import { WorkspaceMembershipService } from '../workspace/workspace-membership.service';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { AuthGuard } from '../../common/auth/auth.guard';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter';
import { registerHttpLogging } from '../../common/logging/http-logging.hook';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';

vi.mock('@clerk/backend', () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token === 'valid-token') {
      return { sub: 'clerk_1' };
    }
    throw new Error('invalid token');
  }),
}));

/**
 * Owner/admin-only surface (doc15/doc18 — conversation messages are
 * free-text customer communication and can carry PII). Full role matrix
 * on `list`; one owner-success check on each other handler to prove the
 * class-level `@RequireWorkspaceRole` reaches all four.
 */
describe('ConversationController (e2e)', () => {
  let app: NestFastifyApplication;

  const conversationService = {
    listConversations: vi.fn(async () => [{ id: 'conv_1', channel: 'whatsapp', status: 'open' }]),
    startConversation: vi.fn(async () => ({ id: 'conv_1', channel: 'whatsapp', status: 'open' })),
    listMessages: vi.fn(async () => [{ id: 'msg_1', direction: 'outbound', content: 'hi' }]),
    sendMessage: vi.fn(async () => ({ id: 'msg_1', direction: 'outbound', content: 'hi' })),
  };
  const userService = {
    findOrCreateByClerkId: vi.fn(async (clerkUserId: string) => ({ id: 'user_1', clerkUserId })),
  };
  const membershipService = {
    findMembership: vi.fn(async (workspaceId: string, userId: string) =>
      workspaceId === 'ws_1' && userId === 'user_1' ? { id: 'mem_1', workspaceId, userId, role: 'owner' } : null,
    ),
  };

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = 'test-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [ConversationController],
      providers: [
        { provide: ConversationService, useValue: conversationService },
        { provide: UserService, useValue: userService },
        { provide: WorkspaceMembershipService, useValue: membershipService },
        WorkspaceMembershipGuard,
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new AllExceptionsFilter(new StructuredLoggerService()));
    registerHttpLogging(app.getHttpAdapter().getInstance(), new StructuredLoggerService());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    delete process.env.CLERK_SECRET_KEY;
    await app.close();
  });

  beforeEach(() => {
    conversationService.listConversations.mockClear();
    conversationService.startConversation.mockClear();
    conversationService.listMessages.mockClear();
    conversationService.sendMessage.mockClear();
  });

  function memberWithRole(role: string) {
    membershipService.findMembership.mockResolvedValueOnce({ id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role });
  }

  describe('GET /workspaces/:workspaceId/customers/:canonicalCustomerId/conversations', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await app.inject({ method: 'GET', url: '/workspaces/ws_1/customers/canon_1/conversations' });

      expect(res.statusCode).toBe(401);
      expect(conversationService.listConversations).not.toHaveBeenCalled();
    });

    it('rejects a caller who is not a member of the workspace', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_2/customers/canon_1/conversations',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(403);
      expect(conversationService.listConversations).not.toHaveBeenCalled();
    });

    for (const role of ['marketing', 'support', 'analyst']) {
      it(`rejects a ${role} member with 403 before the service executes`, async () => {
        memberWithRole(role);

        const res = await app.inject({
          method: 'GET',
          url: '/workspaces/ws_1/customers/canon_1/conversations',
          headers: { authorization: 'Bearer valid-token' },
        });

        expect(res.statusCode).toBe(403);
        expect(conversationService.listConversations).not.toHaveBeenCalled();
      });
    }

    it('allows an owner', async () => {
      memberWithRole('owner');

      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_1/customers/canon_1/conversations',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(conversationService.listConversations).toHaveBeenCalledWith('ws_1', 'canon_1');
    });

    it('allows an admin', async () => {
      memberWithRole('admin');

      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_1/customers/canon_1/conversations',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(conversationService.listConversations).toHaveBeenCalled();
    });
  });

  describe('POST /workspaces/:workspaceId/customers/:canonicalCustomerId/conversations', () => {
    it('rejects a marketing member', async () => {
      memberWithRole('marketing');

      const res = await app.inject({
        method: 'POST',
        url: '/workspaces/ws_1/customers/canon_1/conversations',
        headers: { authorization: 'Bearer valid-token' },
        payload: { channel: 'whatsapp' },
      });

      expect(res.statusCode).toBe(403);
      expect(conversationService.startConversation).not.toHaveBeenCalled();
    });

    it('allows an owner', async () => {
      memberWithRole('owner');

      const res = await app.inject({
        method: 'POST',
        url: '/workspaces/ws_1/customers/canon_1/conversations',
        headers: { authorization: 'Bearer valid-token' },
        payload: { channel: 'whatsapp' },
      });

      expect(res.statusCode).toBe(200);
      expect(conversationService.startConversation).toHaveBeenCalledWith('ws_1', 'canon_1', { channel: 'whatsapp' });
    });
  });

  describe('GET /workspaces/:workspaceId/customers/:canonicalCustomerId/conversations/:conversationId/messages', () => {
    it('rejects a support member', async () => {
      memberWithRole('support');

      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_1/customers/canon_1/conversations/conv_1/messages',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(403);
      expect(conversationService.listMessages).not.toHaveBeenCalled();
    });

    it('allows an admin', async () => {
      memberWithRole('admin');

      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_1/customers/canon_1/conversations/conv_1/messages',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(conversationService.listMessages).toHaveBeenCalledWith('ws_1', 'canon_1', 'conv_1');
    });
  });

  describe('POST /workspaces/:workspaceId/customers/:canonicalCustomerId/conversations/:conversationId/messages', () => {
    it('rejects an analyst member', async () => {
      memberWithRole('analyst');

      const res = await app.inject({
        method: 'POST',
        url: '/workspaces/ws_1/customers/canon_1/conversations/conv_1/messages',
        headers: { authorization: 'Bearer valid-token' },
        payload: { content: 'hi' },
      });

      expect(res.statusCode).toBe(403);
      expect(conversationService.sendMessage).not.toHaveBeenCalled();
    });

    it('allows an owner', async () => {
      memberWithRole('owner');

      const res = await app.inject({
        method: 'POST',
        url: '/workspaces/ws_1/customers/canon_1/conversations/conv_1/messages',
        headers: { authorization: 'Bearer valid-token' },
        payload: { content: 'hi' },
      });

      expect(res.statusCode).toBe(200);
      expect(conversationService.sendMessage).toHaveBeenCalledWith('ws_1', 'canon_1', 'conv_1', 'hi');
    });
  });
});
