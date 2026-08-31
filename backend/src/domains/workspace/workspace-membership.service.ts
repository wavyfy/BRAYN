import { Injectable } from '@nestjs/common';
import { and, count, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { workspaceMemberships } from '../../database/schema/workspace-memberships';
import { workspaces } from '../../database/schema/workspaces';
import { ConflictError, NotFoundError } from '../../common/errors/app-error';
import type { WorkspaceRole } from './dto/add-member.schema';

@Injectable()
export class WorkspaceMembershipService {
  constructor(private readonly database: DatabaseService) {}

  async addMember(workspaceId: string, userId: string, role: WorkspaceRole) {
    const [membership] = await this.database.client
      .insert(workspaceMemberships)
      .values({ workspaceId, userId, role })
      .onConflictDoNothing()
      .returning();

    if (!membership) {
      throw new ConflictError('This user is already a member of the workspace.');
    }

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

    return updated;
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
