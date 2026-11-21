import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../../../../common/auth/auth.guard';
import { InternalCronGuard } from '../../../../common/auth/internal-cron.guard';
import { AllExceptionsFilter } from '../../../../common/errors/all-exceptions.filter';
import { StructuredLoggerService } from '../../../../common/logging/structured-logger.service';
import { ShopifyWebhookMigrationController } from './shopify-webhook-migration.controller';
import { ShopifyWebhookMigrationService } from './shopify-webhook-migration.service';

const SECRET = 'b'.repeat(64);

describe('ShopifyWebhookMigrationController (e2e)', () => {
  let app: NestFastifyApplication;
  const logger = { event: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() };
  const migrationService = {
    migrate: vi.fn(async () => ({ ok: true, applied: false, workspaces: [] })),
  };

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = 'test-secret';
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [ShopifyWebhookMigrationController],
      providers: [
        { provide: ShopifyWebhookMigrationService, useValue: migrationService },
        { provide: StructuredLoggerService, useValue: logger },
        { provide: APP_GUARD, useClass: AuthGuard },
        InternalCronGuard,
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

  beforeEach(() => {
    process.env.BRAYN_INTERNAL_CRON_SECRET = SECRET;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.BRAYN_INTERNAL_CRON_SECRET;
  });

  const post = (
    payload: unknown,
    headers: Record<string, string> = { authorization: `Bearer ${SECRET}` },
  ) =>
    app.inject({
      method: 'POST',
      url: '/internal/integrations/shopify/webhook-subscriptions/migrate',
      headers,
      payload: payload as object,
    });

  it('requires the internal secret — no secret 401, Clerk session tokens are not accepted, nothing runs', async () => {
    expect((await post({ fromBackendUrl: 'https://old.example.com' }, {})).statusCode).toBe(401);
    expect(
      (
        await post(
          { fromBackendUrl: 'https://old.example.com' },
          { authorization: 'Bearer some-clerk-jwt' },
        )
      ).statusCode,
    ).toBe(401);
    expect(migrationService.migrate).not.toHaveBeenCalled();
  });

  it('fails closed (503) when the internal secret is not configured', async () => {
    delete process.env.BRAYN_INTERNAL_CRON_SECRET;
    expect((await post({ fromBackendUrl: 'https://old.example.com' })).statusCode).toBe(503);
    expect(migrationService.migrate).not.toHaveBeenCalled();
  });

  it('is a dry run unless apply is explicitly true', async () => {
    expect((await post({ fromBackendUrl: 'https://old.example.com' })).statusCode).toBe(200);
    expect(migrationService.migrate).toHaveBeenLastCalledWith({
      fromBackendUrl: 'https://old.example.com',
      apply: false,
    });

    await post({
      fromBackendUrl: 'https://old.example.com',
      apply: true,
      workspaceId: '11111111-1111-4111-8111-111111111111',
    });
    expect(migrationService.migrate).toHaveBeenLastCalledWith({
      fromBackendUrl: 'https://old.example.com',
      apply: true,
      workspaceId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('rejects invalid input — non-http(s) URL, a target URL field, non-boolean apply — without running', async () => {
    for (const payload of [
      { fromBackendUrl: 'ftp://old.example.com' },
      { fromBackendUrl: 'https://old.example.com', toBackendUrl: 'https://elsewhere.example.com' },
      { fromBackendUrl: 'https://old.example.com', apply: 'yes' },
      {},
    ]) {
      expect((await post(payload)).statusCode).toBe(400);
    }
    expect(migrationService.migrate).not.toHaveBeenCalled();
  });
});
