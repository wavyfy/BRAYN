import { describe, expect, it, vi } from 'vitest';
import { AppController } from './app.controller';
import type { DatabaseService } from './database/database.service';

function makeDatabaseStub(overrides: Partial<DatabaseService>): DatabaseService {
  return {
    isConfigured: vi.fn(() => false),
    ping: vi.fn(),
    ...overrides,
  } as unknown as DatabaseService;
}

describe('AppController#health', () => {
  it('reports not_configured and overall ok when the database has no URL', async () => {
    const controller = new AppController(makeDatabaseStub({ isConfigured: vi.fn(() => false) }));

    const result = await controller.health();

    expect(result.status).toBe('ok');
    expect(result.checks.database).toBe('not_configured');
  });

  it('reports ok when the database is configured and reachable', async () => {
    const controller = new AppController(
      makeDatabaseStub({
        isConfigured: vi.fn(() => true),
        ping: vi.fn(async () => {}),
      }),
    );

    const result = await controller.health();

    expect(result.status).toBe('ok');
    expect(result.checks.database).toBe('ok');
  });

  it('reports degraded when the database is configured but unreachable', async () => {
    const controller = new AppController(
      makeDatabaseStub({
        isConfigured: vi.fn(() => true),
        ping: vi.fn(async () => {
          throw new Error('connection refused');
        }),
      }),
    );

    const result = await controller.health();

    expect(result.status).toBe('degraded');
    expect(result.checks.database).toBe('error');
  });
});
