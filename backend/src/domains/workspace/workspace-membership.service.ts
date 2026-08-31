import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { workspaceMemberships } from '../../database/schema/workspace-memberships';
import { workspaces } from '../../database/schema/workspaces';
import { ConflictError } from '../../common/errors/app-error';
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
}
