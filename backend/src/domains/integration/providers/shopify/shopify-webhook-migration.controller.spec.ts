import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../../../../common/auth/auth.guard';
import { ShopifyWebhookMigrationGuard } from './shopify-webhook-migration.guard';
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
        ShopifyWebhookMigrationGuard,
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

  const CRON_SECRET = 'c'.repeat(64);

  beforeEach(() => {
    process.env.SHOPIFY_WEBHOOK_MIGRATION_SECRET = SECRET;
    process.env.BRAYN_INTERNAL_CRON_SECRET = CRON_SECRET;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.SHOPIFY_WEBHOOK_MIGRATION_SECRET;
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
  const valid = { fromBackendUrl: 'https://old.example.com', allWorkspaces: true };

  it('requires the dedicated migration secret — not the cron secret, not a Clerk token — and nothing runs', async () => {
    expect((await post(valid, {})).statusCode).toBe(401);
    expect((await post(valid, { authorization: 'Bearer some-clerk-jwt' })).statusCode).toBe(401);
    expect((await post(valid, { authorization: `Bearer ${CRON_SECRET}` })).statusCode).toBe(401);
    expect(migrationService.migrate).not.toHaveBeenCalled();
  });

  it('is disabled (503) unless the migration secret is configured — even with the cron secret set', async () => {
    delete process.env.SHOPIFY_WEBHOOK_MIGRATION_SECRET;
    expect((await post(valid)).statusCode).toBe(503);
    expect((await post(valid, { authorization: `Bearer ${CRON_SECRET}` })).statusCode).toBe(503);
    expect(migrationService.migrate).not.toHaveBeenCalled();
  });

  it('is a dry run unless apply is explicitly true', async () => {
    expect((await post(valid)).statusCode).toBe(200);
    expect(migrationService.migrate).toHaveBeenLastCalledWith({
      fromBackendUrl: 'https://old.example.com',
      apply: false,
      allWorkspaces: true,
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

  it('rejects anything but an origin, a target field, non-boolean apply, and a missing or double scope — without running', async () => {
    for (const payload of [
      { ...valid, fromBackendUrl: 'ftp://old.example.com' },
      { ...valid, fromBackendUrl: 'https://old.example.com/api/v1' },
      { ...valid, fromBackendUrl: 'https://old.example.com?x=1' },
      { ...valid, fromBackendUrl: 'https://user:pass@old.example.com' },
      { ...valid, fromBackendUrl: 'https://old.example.com#frag' },
      { ...valid, toBackendUrl: 'https://elsewhere.example.com' },
      { ...valid, apply: 'yes' },
      { ...valid, allWorkspaces: false },
      { fromBackendUrl: 'https://old.example.com' },
      { ...valid, workspaceId: '11111111-1111-4111-8111-111111111111' },
      { fromBackendUrl: 'https://old.example.com', workspaceId: 'not-a-uuid' },
      {},
    ]) {
      expect((await post(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(migrationService.migrate).not.toHaveBeenCalled();
  });
});
