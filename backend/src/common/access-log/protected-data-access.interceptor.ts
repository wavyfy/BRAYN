import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { DatabaseService } from '../../database/database.service';
import { protectedDataAccessLog } from '../../database/schema/protected-data-access-log';
import { StructuredLoggerService } from '../logging/structured-logger.service';
import { RequestContext } from '../logging/request-context';
import { PROTECTED_DATA_ACCESS_KEY, type ProtectedDataAccessMeta } from './protected-data-access.decorator';

/**
 * Records a `protected_data_access_log` row after a route marked
 * `@LogsProtectedAccess(...)` completes *successfully* (Shopify
 * Protected Customer Data — "do you log access to personal data?").
 *
 * Runs as a global interceptor (registered once in AppModule) rather
 * than being added per-controller — it's a no-op (`next.handle()`
 * straight through) for the overwhelming majority of routes that carry
 * no `@LogsProtectedAccess` metadata, so global registration costs
 * nothing there and means a newly-added protected route can't forget to
 * opt in to logging the way it could forget a per-controller
 * `@UseInterceptors()`.
 *
 * Interceptors run after guards in Nest's pipeline, and `tap()` only
 * fires on the success path of the handler's observable — so a 401/403
 * (rejected by a guard before this interceptor's `next.handle()` is even
 * reached) or a handler that itself throws (e.g. a 404 for a
 * non-existent customer) never reaches the `tap()` callback. This is a
 * genuine "did the handler actually return data" signal, not just "was
 * the caller authorized to attempt it" — the two aren't the same thing,
 * and doc-requested behavior is specifically the former.
 *
 * The insert is best-effort: a failure here is logged and swallowed,
 * never surfaced as a failure of the real request the caller made.
 */
@Injectable()
export class ProtectedDataAccessInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly database: DatabaseService,
    private readonly logger: StructuredLoggerService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<ProtectedDataAccessMeta | undefined>(PROTECTED_DATA_ACCESS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!meta) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<FastifyRequest<{ Params: Record<string, string> }>>();
    const action = request.method === 'GET' ? 'view' : 'create';
    const resourceId = meta.resourceIdParam ? (request.params[meta.resourceIdParam] ?? null) : null;

    return next.handle().pipe(
      tap(() => {
        const store = RequestContext.get();
        if (!store?.workspaceId || !store?.actorUserId || !store?.actorRole) {
          // Should never happen — WorkspaceMembershipGuard (which every
          // @LogsProtectedAccess route is already gated by) sets all
          // three before this interceptor's next.handle() resolves.
          return;
        }

        this.database.client
          .insert(protectedDataAccessLog)
          .values({
            workspaceId: store.workspaceId,
            actorUserId: store.actorUserId,
            actorRole: store.actorRole as 'owner' | 'admin' | 'marketing' | 'support' | 'analyst',
            action,
            resourceType: meta.resourceType,
            resourceId,
          })
          .catch((error: unknown) => {
            this.logger.event('error', 'Failed to record protected-data access', 'ProtectedDataAccessInterceptor', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }),
    );
  }
}
