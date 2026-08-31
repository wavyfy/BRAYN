import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';
import { AuthGuard } from '../../common/auth/auth.guard';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';

vi.mock('@clerk/backend', () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token === 'valid-token') {
      return { sub: 'user_1' };
    }
    throw new Error('invalid token');
  }),
}));

describe('WorkspaceController (e2e)', () => {
  let app: NestFastifyApplication;

  const workspaceService = {
    create: vi.fn(async (name: string) => ({ id: 'ws_1', name })),
    findById: vi.fn(async (id: string) => (id === 'ws_1' ? { id: 'ws_1', name: 'Acme' } : null)),
  };

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = 'test-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [WorkspaceController],
      providers: [
        { provide: WorkspaceService, useValue: workspaceService },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new AllExceptionsFilter(new StructuredLoggerService()));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    delete process.env.CLERK_SECRET_KEY;
    await app.close();
  });

  it('rejects an unauthenticated create request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces',
      payload: { name: 'Acme' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates a workspace for an authenticated request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { authorization: 'Bearer valid-token' },
      payload: { name: 'Acme' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 'ws_1', name: 'Acme' });
  });

  it('rejects an empty name with the canonical validation error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { authorization: 'Bearer valid-token' },
      payload: { name: '' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns a workspace by id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/ws_1',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 'ws_1', name: 'Acme' });
  });

  it('returns 404 for a missing workspace', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/missing',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
