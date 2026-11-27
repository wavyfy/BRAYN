import { randomUUID } from 'node:crypto';
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfiguration } from '../../config/configuration';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter';
import { RequestContext } from '../../common/logging/request-context';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { users } from '../../database/schema/users';
import { workspaceMemberships } from '../../database/schema/workspace-memberships';
import { workspaces } from '../../database/schema/workspaces';
import { UserService } from './user.service';
import { WorkspaceMembershipGuard } from './workspace-membership.guard';
import { WorkspaceMembershipService } from './workspace-membership.service';

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../common/observability/sentry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../common/observability/sentry')>()),
  captureException,
}));

/** Real membership guard + real database + global exception filter: the path every workspace route takes. */
@Controller('api/v1/workspaces/:workspaceId')
@UseGuards(WorkspaceMembershipGuard)
class ProbeController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  ok() {
    return { ok: true };
  }

  @Get('customers/:canonicalCustomerId')
  async customer(
    @Param('workspaceId') workspaceId: string,
    @Param('canonicalCustomerId') id: string,
  ) {
    const rows = await this.database.client
      .select({ id: canonicalCustomers.id })
      .from(canonicalCustomers)
      .where(and(eq(canonicalCustomers.workspaceId, workspaceId), eq(canonicalCustomers.id, id)));
    return { found: rows.length };
  }
}

describe(
  'F2 — malformed workspace / resource ids are a clean 404, authorization unchanged (real DB)',
  { timeout: 30_000 },
  () => {
    let app: NestFastifyApplication;
    let db: DatabaseService;
    const member = `user_f2_member_${randomUUID().slice(0, 8)}`;
    const outsider = `user_f2_outsider_${randomUUID().slice(0, 8)}`;
    let workspaceId: string;

    beforeAll(async () => {
      const ref = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, load: [loadConfiguration] }),
          DatabaseModule,
        ],
        controllers: [ProbeController],
        providers: [
          UserService,
          WorkspaceMembershipService,
          WorkspaceMembershipGuard,
          StructuredLoggerService,
        ],
      }).compile();
      db = ref.get(DatabaseService);
      if (!db.isConfigured())
        throw new Error(
          'DATABASE_URL is not configured — this integration test requires the real dev database.',
        );

      const [ws] = await db.client
        .insert(workspaces)
        .values({ name: `F2 probe ${randomUUID()}` })
        .returning();
      workspaceId = ws.id;
      const [user] = await db.client.insert(users).values({ clerkUserId: member }).returning();
      await db.client
        .insert(workspaceMemberships)
        .values({ workspaceId, userId: user.id, role: 'owner' });

      app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      // Stand-in for the auth guard: the verified Clerk user id lands in RequestContext (here from a test header).
      app
        .getHttpAdapter()
        .getInstance()
        .addHook('onRequest', async (req) => {
          const userId = req.headers['x-test-user'];
          RequestContext.start({
            correlationId: randomUUID(),
            ...(typeof userId === 'string' && { userId }),
          });
        });
      app.useGlobalFilters(new AllExceptionsFilter(new StructuredLoggerService()));
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    });

    afterAll(async () => {
      if (workspaceId)
        await db.client
          .delete(workspaceMemberships)
          .where(eq(workspaceMemberships.workspaceId, workspaceId));
      if (workspaceId) await db.client.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await db.client.delete(users).where(eq(users.clerkUserId, member));
      await db.client.delete(users).where(eq(users.clerkUserId, outsider));
      await app?.close();
    });

    const get = (url: string, user?: string) =>
      app.inject({ method: 'GET', url, headers: user ? { 'x-test-user': user } : {} });

    it('a member reaches their own workspace', async () => {
      const res = await get(`/api/v1/workspaces/${workspaceId}`, member);
      expect(res.statusCode).toBe(200);
    });

    it('a malformed workspace id → 404 NOT_FOUND, not 500, and is not reported as a server error', async () => {
      captureException.mockClear();
      for (const bad of ['not-a-uuid', '123', `${workspaceId}x`]) {
        const res = await get(`/api/v1/workspaces/${bad}`, member);
        expect(res.statusCode, bad).toBe(404);
        expect(res.json().error).toMatchObject({
          code: 'NOT_FOUND',
          message: 'The requested resource was not found.',
        });
        expect(res.body).not.toContain(bad === '123' ? 'invalid input' : bad);
      }
      expect(captureException).not.toHaveBeenCalled();
    });

    it('a malformed child id inside a workspace the caller belongs to → 404; a well-formed unknown id still resolves normally', async () => {
      expect(
        (await get(`/api/v1/workspaces/${workspaceId}/customers/not-a-uuid`, member)).statusCode,
      ).toBe(404);
      const ok = await get(`/api/v1/workspaces/${workspaceId}/customers/${randomUUID()}`, member);
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ found: 0 });
    });

    it('authorization is unchanged: well-formed foreign/unknown workspace → 403, non-member → 403, no session → 401', async () => {
      expect((await get(`/api/v1/workspaces/${randomUUID()}`, member)).json().error.code).toBe(
        'UNAUTHORIZED',
      );
      const foreign = await get(`/api/v1/workspaces/${workspaceId}`, outsider);
      expect(foreign.statusCode).toBe(403);
      expect(foreign.json().error.code).toBe('UNAUTHORIZED');
      const noSession = await get(`/api/v1/workspaces/not-a-uuid`);
      expect(noSession.statusCode).toBe(401);
    });
  },
);
