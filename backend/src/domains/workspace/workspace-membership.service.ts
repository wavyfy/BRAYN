import { Injectable } from '@nestjs/common';
import { and, count, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { workspaceMemberships } from '../../database/schema/workspace-memberships';
import { workspaces } from '../../database/schema/workspaces';
import { workspaceMembershipAuditLog } from '../../database/schema/workspace-membership-audit-log';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/app-error';
import { RequestContext } from '../../common/logging/request-context';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import type { WorkspaceRole } from './dto/add-member.schema';

type WorkspaceAdminAuditAction = 'member_added' | 'member_removed' | 'role_changed' | 'ownership_transferred';

@Injectable()
export class WorkspaceMembershipService {
  constructor(
    private readonly database: DatabaseService,
    private readonly logger: StructuredLoggerService,
  ) {}

  async addMember(workspaceId: string, userId: string, role: WorkspaceRole) {
    const [membership] = await this.database.client
      .insert(workspaceMemberships)
      .values({ workspaceId, userId, role })
      .onConflictDoNothing()
      .returning();

    if (!membership) {
      throw new ConflictError('This user is already a member of the workspace.');
    }

    await this.recordAudit(workspaceId, 'member_added', userId, { role });
    return membership;
  }

  async listByWorkspace(workspaceId: string) {
    return this.database.client
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspaceId));
  }

  /** The workspaces a user belongs to, with their role in each — doc 19 "Access a workspace". */
  async listByUser(userId: string) {
    return this.database.client
      .select({ id: workspaces.id, name: workspaces.name, role: workspaceMemberships.role })
      .from(workspaceMemberships)
      .innerJoin(workspaces, eq(workspaceMemberships.workspaceId, workspaces.id))
      .where(eq(workspaceMemberships.userId, userId));
  }

  async findMembership(workspaceId: string, userId: string) {
    const [membership] = await this.database.client
      .select()
      .from(workspaceMemberships)
      .where(and(eq(workspaceMemberships.workspaceId, workspaceId), eq(workspaceMemberships.userId, userId)))
      .limit(1);

    return membership ?? null;
  }

  /** Doc 28 "User/role management": owner Full, admin Manage. */
  async removeMember(workspaceId: string, userId: string) {
    const membership = await this.findMembership(workspaceId, userId);
    if (!membership) {
      throw new NotFoundError('This user is not a member of the workspace.');
    }
    if (membership.role === 'owner') {
      await this.assertNotLastOwner(workspaceId);
    }

    await this.database.client
      .delete(workspaceMemberships)
      .where(and(eq(workspaceMemberships.workspaceId, workspaceId), eq(workspaceMemberships.userId, userId)));

    await this.recordAudit(workspaceId, 'member_removed', userId, { role: membership.role });
  }

  /** Doc 28 "User/role management": owner Full, admin Manage. */
  async updateRole(workspaceId: string, userId: string, role: WorkspaceRole) {
    const membership = await this.findMembership(workspaceId, userId);
    if (!membership) {
      throw new NotFoundError('This user is not a member of the workspace.');
    }
    if (membership.role === 'owner' && role !== 'owner') {
      await this.assertNotLastOwner(workspaceId);
    }

    const [updated] = await this.database.client
      .update(workspaceMemberships)
      .set({ role })
      .where(and(eq(workspaceMemberships.workspaceId, workspaceId), eq(workspaceMemberships.userId, userId)))
      .returning();

    // Only an actual change is an auditable "role changed" event — a caller re-submitting the
    // same role (e.g. the owner-keeps-owner case below) didn't change anything to record.
    if (membership.role !== role) {
      await this.recordAudit(workspaceId, 'role_changed', userId, { fromRole: membership.role, toRole: role });
    }

    return updated;
  }

  /**
   * Doc 28 "Permission Changes": the final owner can't be removed/demoted
   * unless ownership is transferred first — this is that transfer. Runs in
   * a transaction so the workspace is never briefly ownerless.
   */
  async transferOwnership(workspaceId: string, fromUserId: string, toUserId: string) {
    if (fromUserId === toUserId) {
      throw new ValidationError('You already own this workspace.');
    }

    const updated = await this.database.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(workspaceMemberships)
        .where(and(eq(workspaceMemberships.workspaceId, workspaceId), eq(workspaceMemberships.userId, toUserId)))
        .limit(1);
      if (!target) {
        throw new NotFoundError('This user is not a member of the workspace.');
      }

      await tx
        .update(workspaceMemberships)
        .set({ role: 'admin' })
        .where(and(eq(workspaceMemberships.workspaceId, workspaceId), eq(workspaceMemberships.userId, fromUserId)));

      const [promoted] = await tx
        .update(workspaceMemberships)
        .set({ role: 'owner' })
        .where(and(eq(workspaceMemberships.workspaceId, workspaceId), eq(workspaceMemberships.userId, toUserId)))
        .returning();

      return promoted;
    });

    // Recorded after the transaction commits, in its own best-effort write — an audit failure
    // must never roll back an ownership transfer that has already genuinely happened.
    await this.recordAudit(workspaceId, 'ownership_transferred', toUserId, { fromUserId });
    return updated;
  }

  /**
   * Doc18 Audit — "Permission changes", "Administrative changes". Best-
   * effort, same convention as `MerchantBusinessAnalystService.recordProtectedAccess`:
   * caught and logged, never thrown — an audit-trail failure must not
   * undo or block an administrative change that already succeeded, and
   * must never become a reason a caller could retry into doing something
   * they otherwise couldn't (this method runs strictly after success, it
   * never gates it).
   */
  private async recordAudit(
    workspaceId: string,
    action: WorkspaceAdminAuditAction,
    targetUserId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const store = RequestContext.get();
    if (!store?.actorUserId || !store?.actorRole) {
      return;
    }

    try {
      await this.database.client.insert(workspaceMembershipAuditLog).values({
        workspaceId,
        actorUserId: store.actorUserId,
        actorRole: store.actorRole as 'owner' | 'admin' | 'marketing' | 'support' | 'analyst',
        action,
        targetUserId,
        metadata,
      });
    } catch (error) {
      this.logger.event('error', 'Failed to record workspace administrative audit event', 'WorkspaceMembershipService', {
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
    }
  }

  /** A workspace must always keep at least one owner able to manage it. */
  private async assertNotLastOwner(workspaceId: string) {
    const [row] = await this.database.client
      .select({ owners: count() })
      .from(workspaceMemberships)
      .where(and(eq(workspaceMemberships.workspaceId, workspaceId), eq(workspaceMemberships.role, 'owner')));

    if ((row?.owners ?? 0) <= 1) {
      throw new ConflictError('A workspace must have at least one owner.');
    }
  }
}
