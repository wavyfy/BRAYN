import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationController } from './integration.controller';
import { IntegrationService } from './integration.service';
import { IntegrationHealthService } from './integration-health.service';
import { ImportRunService } from './import-run.service';
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

describe('IntegrationController (e2e)', () => {
  let app: NestFastifyApplication;

  const integrationService = {
    listByWorkspace: vi.fn(async (workspaceId: string) => [
      { id: 'int_1', workspaceId, provider: 'shopify', status: 'connected' },
    ]),
    connect: vi.fn(async (workspaceId: string, provider: string) => ({
      id: 'int_new',
      workspaceId,
      provider,
      status: 'connected',
    })),
    disconnect: vi.fn(async () => undefined),
    connectCredentials: vi.fn(async () => undefined),
    startInitialImport: vi.fn(async (workspaceId: string, provider: string) => ({
      id: 'run_1',
      workspaceId,
      integrationId: 'int_1',
      provider,
      status: 'running',
    })),
  };
  const integrationHealthService = {
    getHealth: vi.fn(async (workspaceId: string, provider: string) => ({
      provider,
      status: 'connected',
      health: 'healthy',
      lastSyncedAt: null,
      lastSyncError: null,
      latestImport: null,
    })),
  };
  const importRunService = {
    getLatestImportRun: vi.fn(async () => ({ id: 'run_1', status: 'running' })),
  };
  const userService = {
    findOrCreateByClerkId: vi.fn(async (clerkUserId: string) => ({ id: 'user_1', clerkUserId })),
  };
  const membershipService = {
    // Caller ('user_1') is an owner member of 'ws_1' by default — the
    // dedicated non-member tests override this with mockResolvedValueOnce(null).
    findMembership: vi.fn(async (workspaceId: string, userId: string) =>
      workspaceId === 'ws_1' && userId === 'user_1' ? { id: 'mem_1', workspaceId, userId, role: 'owner' } : null,
    ),
  };

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = 'test-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [IntegrationController],
      providers: [
        { provide: IntegrationService, useValue: integrationService },
        { provide: IntegrationHealthService, useValue: integrationHealthService },
        { provide: ImportRunService, useValue: importRunService },
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
    integrationService.listByWorkspace.mockClear();
    integrationService.connect.mockClear();
    integrationService.disconnect.mockClear();
    integrationService.connectCredentials.mockClear();
    integrationService.startInitialImport.mockClear();
    integrationHealthService.getHealth.mockClear();
    importRunService.getLatestImportRun.mockClear();
  });

  it('rejects an unauthenticated list request', async () => {
    const res = await app.inject({ method: 'GET', url: '/workspaces/ws_1/integrations' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects listing integrations for a caller who is not a member of the workspace', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/ws_2/integrations',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    expect(integrationService.listByWorkspace).not.toHaveBeenCalled();
  });

  it('lists integrations for a member', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/ws_1/integrations',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected' }]);
  });

  it('rejects connect from a member without owner/admin role', async () => {
    membershipService.findMembership.mockResolvedValueOnce({
      id: 'mem_1',
      workspaceId: 'ws_1',
      userId: 'user_1',
      role: 'support',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/integrations',
      headers: { authorization: 'Bearer valid-token' },
      payload: { provider: 'shopify' },
    });

    expect(res.statusCode).toBe(403);
    expect(integrationService.connect).not.toHaveBeenCalled();
  });

  it('rejects connect for a caller who is not a member of the workspace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_2/integrations',
      headers: { authorization: 'Bearer valid-token' },
      payload: { provider: 'shopify' },
    });

    expect(res.statusCode).toBe(403);
    expect(integrationService.connect).not.toHaveBeenCalled();
  });

  it('connects a provider for an owner/admin caller', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/integrations',
      headers: { authorization: 'Bearer valid-token' },
      payload: { provider: 'shopify' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 'int_new', workspaceId: 'ws_1', provider: 'shopify', status: 'connected' });
    expect(integrationService.connect).toHaveBeenCalledWith('ws_1', 'shopify');
  });

  it('rejects an invalid provider with the canonical validation error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/integrations',
      headers: { authorization: 'Bearer valid-token' },
      payload: { provider: 'stripe' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects disconnect from a member without owner/admin role', async () => {
    membershipService.findMembership.mockResolvedValueOnce({
      id: 'mem_1',
      workspaceId: 'ws_1',
      userId: 'user_1',
      role: 'support',
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/workspaces/ws_1/integrations/shopify',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(403);
    expect(integrationService.disconnect).not.toHaveBeenCalled();
  });

  it('rejects disconnect for a caller who is not a member of the workspace', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/workspaces/ws_2/integrations/shopify',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(403);
    expect(integrationService.disconnect).not.toHaveBeenCalled();
  });

  it('disconnects a provider for an owner/admin caller', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/workspaces/ws_1/integrations/shopify',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(204);
    expect(integrationService.disconnect).toHaveBeenCalledWith('ws_1', 'shopify');
  });

  it('rejects submitting credentials from a member without owner/admin role', async () => {
    membershipService.findMembership.mockResolvedValueOnce({
      id: 'mem_1',
      workspaceId: 'ws_1',
      userId: 'user_1',
      role: 'support',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/integrations/shopify/credentials',
      headers: { authorization: 'Bearer valid-token' },
      payload: { credentials: { shopDomain: 'acme.myshopify.com', accessToken: 'shpat_x' } },
    });

    expect(res.statusCode).toBe(403);
    expect(integrationService.connectCredentials).not.toHaveBeenCalled();
  });

  it('rejects submitting credentials for a caller who is not a member of the workspace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_2/integrations/shopify/credentials',
      headers: { authorization: 'Bearer valid-token' },
      payload: { credentials: { shopDomain: 'acme.myshopify.com', accessToken: 'shpat_x' } },
    });

    expect(res.statusCode).toBe(403);
    expect(integrationService.connectCredentials).not.toHaveBeenCalled();
  });

  it('accepts credentials for an owner/admin caller and never echoes them back', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/integrations/shopify/credentials',
      headers: { authorization: 'Bearer valid-token' },
      payload: { credentials: { shopDomain: 'acme.myshopify.com', accessToken: 'shpat_x' } },
    });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(integrationService.connectCredentials).toHaveBeenCalledWith('ws_1', 'shopify', {
      shopDomain: 'acme.myshopify.com',
      accessToken: 'shpat_x',
    });
  });

  it('rejects a credential value that is not a non-empty string with the canonical validation error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/integrations/shopify/credentials',
      headers: { authorization: 'Bearer valid-token' },
      payload: { credentials: { accessToken: '' } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(integrationService.connectCredentials).not.toHaveBeenCalled();
  });

  it('returns health for a member (view-only, no owner/admin role required)', async () => {
    membershipService.findMembership.mockResolvedValueOnce({
      id: 'mem_1',
      workspaceId: 'ws_1',
      userId: 'user_1',
      role: 'support',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/ws_1/integrations/shopify/health',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ provider: 'shopify', status: 'connected', health: 'healthy' });
    expect(integrationHealthService.getHealth).toHaveBeenCalledWith('ws_1', 'shopify');
  });

  it('rejects health for a caller who is not a member of the workspace', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/ws_2/integrations/shopify/health',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(403);
    expect(integrationHealthService.getHealth).not.toHaveBeenCalled();
  });

  it('starts an import for an owner/admin caller', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/integrations/shopify/import',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ id: 'run_1', status: 'running' });
    expect(integrationService.startInitialImport).toHaveBeenCalledWith('ws_1', 'shopify');
  });

  it('rejects starting an import from a member without owner/admin role', async () => {
    membershipService.findMembership.mockResolvedValueOnce({
      id: 'mem_1',
      workspaceId: 'ws_1',
      userId: 'user_1',
      role: 'support',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/integrations/shopify/import',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(403);
    expect(integrationService.startInitialImport).not.toHaveBeenCalled();
  });

  it('returns the latest import run for a member (view-only, no owner/admin role required)', async () => {
    membershipService.findMembership.mockResolvedValueOnce({
      id: 'mem_1',
      workspaceId: 'ws_1',
      userId: 'user_1',
      role: 'support',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/ws_1/integrations/shopify/import',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'run_1', status: 'running' });
    expect(importRunService.getLatestImportRun).toHaveBeenCalledWith('ws_1', 'shopify');
  });
});
