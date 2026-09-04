import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of, throwError, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ProtectedDataAccessInterceptor } from './protected-data-access.interceptor';
import { protectedDataAccessLog } from '../../database/schema/protected-data-access-log';
import { RequestContext } from '../logging/request-context';
import type { DatabaseService } from '../../database/database.service';
import type { StructuredLoggerService } from '../logging/structured-logger.service';

function makeContext(params: Record<string, string>, method: string) {
  const request = { method, params };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function makeCallHandler(observable: Observable<unknown> = of({ some: 'result' })): CallHandler {
  return { handle: () => observable };
}

function makeLogger(): StructuredLoggerService {
  return { event: vi.fn() } as unknown as StructuredLoggerService;
}

describe('ProtectedDataAccessInterceptor', () => {
  it('passes the response through unchanged and never touches the database when no metadata is present', async () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const insert = vi.fn();
    const database = { client: { insert } } as unknown as DatabaseService;
    const interceptor = new ProtectedDataAccessInterceptor(reflector, database, makeLogger());
    const context = makeContext({}, 'GET');

    const result = await firstValueFrom(interceptor.intercept(context, makeCallHandler()));

    expect(result).toEqual({ some: 'result' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('records a view access for a GET route with a resource id param', async () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ resourceType: 'customer', resourceIdParam: 'canonicalCustomerId' });
    const values = vi.fn(async () => undefined);
    const insert = vi.fn(() => ({ values }));
    const database = { client: { insert } } as unknown as DatabaseService;
    const interceptor = new ProtectedDataAccessInterceptor(reflector, database, makeLogger());
    const context = makeContext({ canonicalCustomerId: 'canon_1' }, 'GET');

    await RequestContext.run({ correlationId: 'c1', workspaceId: 'ws_1', actorUserId: 'user_1', actorRole: 'owner' }, async () => {
      await firstValueFrom(interceptor.intercept(context, makeCallHandler()));
    });
    // the insert is fired inside a synchronous tap() callback but is itself async — flush microtasks
    await new Promise((resolve) => setImmediate(resolve));

    expect(insert).toHaveBeenCalledWith(protectedDataAccessLog);
    expect(values).toHaveBeenCalledWith({
      workspaceId: 'ws_1',
      actorUserId: 'user_1',
      actorRole: 'owner',
      action: 'view',
      resourceType: 'customer',
      resourceId: 'canon_1',
    });
  });

  it('records a create access for a POST route', async () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ resourceType: 'conversation', resourceIdParam: 'conversationId' });
    const values = vi.fn(async () => undefined);
    const insert = vi.fn(() => ({ values }));
    const database = { client: { insert } } as unknown as DatabaseService;
    const interceptor = new ProtectedDataAccessInterceptor(reflector, database, makeLogger());
    const context = makeContext({ conversationId: 'conv_1' }, 'POST');

    await RequestContext.run({ correlationId: 'c1', workspaceId: 'ws_1', actorUserId: 'user_1', actorRole: 'admin' }, async () => {
      await firstValueFrom(interceptor.intercept(context, makeCallHandler()));
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ action: 'create', resourceId: 'conv_1' }));
  });

  it('records resourceId: null for a list-level route with no resourceIdParam', async () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ resourceType: 'identity_duplicate' });
    const values = vi.fn(async () => undefined);
    const insert = vi.fn(() => ({ values }));
    const database = { client: { insert } } as unknown as DatabaseService;
    const interceptor = new ProtectedDataAccessInterceptor(reflector, database, makeLogger());
    const context = makeContext({}, 'GET');

    await RequestContext.run({ correlationId: 'c1', workspaceId: 'ws_1', actorUserId: 'user_1', actorRole: 'owner' }, async () => {
      await firstValueFrom(interceptor.intercept(context, makeCallHandler()));
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ resourceId: null }));
  });

  it('records resourceId: null when the named param is absent from the route (e.g. a create route with no id yet)', async () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ resourceType: 'customer', resourceIdParam: 'canonicalCustomerId' });
    const values = vi.fn(async () => undefined);
    const insert = vi.fn(() => ({ values }));
    const database = { client: { insert } } as unknown as DatabaseService;
    const interceptor = new ProtectedDataAccessInterceptor(reflector, database, makeLogger());
    const context = makeContext({}, 'GET');

    await RequestContext.run({ correlationId: 'c1', workspaceId: 'ws_1', actorUserId: 'user_1', actorRole: 'owner' }, async () => {
      await firstValueFrom(interceptor.intercept(context, makeCallHandler()));
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ resourceId: null }));
  });

  it('the inserted row contains only the whitelisted fields — no PII, no extra data', async () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ resourceType: 'customer', resourceIdParam: 'canonicalCustomerId' });
    const values = vi.fn(async (row: Record<string, unknown>) => void row);
    const insert = vi.fn(() => ({ values }));
    const database = { client: { insert } } as unknown as DatabaseService;
    const interceptor = new ProtectedDataAccessInterceptor(reflector, database, makeLogger());
    const context = makeContext({ canonicalCustomerId: 'canon_1' }, 'GET');

    await RequestContext.run({ correlationId: 'c1', workspaceId: 'ws_1', actorUserId: 'user_1', actorRole: 'owner' }, async () => {
      // A response carrying real PII must never leak into the recorded row — the interceptor only ever reads route params/RequestContext, never the response body.
      await firstValueFrom(interceptor.intercept(context, makeCallHandler(of({ email: 'jane@example.com', phone: '555-1234' }))));
    });
    await new Promise((resolve) => setImmediate(resolve));

    const recorded = values.mock.calls[0][0];
    expect(Object.keys(recorded).sort()).toEqual(['action', 'actorRole', 'actorUserId', 'resourceId', 'resourceType', 'workspaceId']);
    expect(JSON.stringify(recorded)).not.toContain('jane@example.com');
    expect(JSON.stringify(recorded)).not.toContain('555-1234');
  });

  it('does not record anything when the handler throws — only successful access is logged', async () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ resourceType: 'customer', resourceIdParam: 'canonicalCustomerId' });
    const insert = vi.fn();
    const database = { client: { insert } } as unknown as DatabaseService;
    const interceptor = new ProtectedDataAccessInterceptor(reflector, database, makeLogger());
    const context = makeContext({ canonicalCustomerId: 'canon_1' }, 'GET');
    const failingHandler = makeCallHandler(throwError(() => new Error('not found')));

    await RequestContext.run({ correlationId: 'c1', workspaceId: 'ws_1', actorUserId: 'user_1', actorRole: 'owner' }, async () => {
      await expect(firstValueFrom(interceptor.intercept(context, failingHandler))).rejects.toThrow('not found');
    });

    expect(insert).not.toHaveBeenCalled();
  });

  it('does not record anything when RequestContext is missing actor/workspace info (defensive — should never happen post-guard)', async () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ resourceType: 'customer', resourceIdParam: 'canonicalCustomerId' });
    const insert = vi.fn();
    const database = { client: { insert } } as unknown as DatabaseService;
    const interceptor = new ProtectedDataAccessInterceptor(reflector, database, makeLogger());
    const context = makeContext({ canonicalCustomerId: 'canon_1' }, 'GET');

    await RequestContext.run({ correlationId: 'c1' }, async () => {
      await firstValueFrom(interceptor.intercept(context, makeCallHandler()));
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(insert).not.toHaveBeenCalled();
  });

  it('swallows an insert failure without breaking the real response', async () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ resourceType: 'customer', resourceIdParam: 'canonicalCustomerId' });
    const values = vi.fn(async () => {
      throw new Error('db unavailable');
    });
    const insert = vi.fn(() => ({ values }));
    const database = { client: { insert } } as unknown as DatabaseService;
    const logger = makeLogger();
    const interceptor = new ProtectedDataAccessInterceptor(reflector, database, logger);
    const context = makeContext({ canonicalCustomerId: 'canon_1' }, 'GET');

    let result: unknown;
    await RequestContext.run({ correlationId: 'c1', workspaceId: 'ws_1', actorUserId: 'user_1', actorRole: 'owner' }, async () => {
      result = await firstValueFrom(interceptor.intercept(context, makeCallHandler()));
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(result).toEqual({ some: 'result' });
    expect(logger.event).toHaveBeenCalledWith('error', expect.any(String), 'ProtectedDataAccessInterceptor', expect.objectContaining({ error: 'db unavailable' }));
  });
});
