import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { workspaces } from '../../database/schema/workspaces';

@Injectable()
export class WorkspaceService {
  constructor(private readonly database: DatabaseService) {}

  async create(name: string) {
    const [workspace] = await this.database.client.insert(workspaces).values({ name }).returning();

    return workspace;
  }

  async findById(id: string) {
    const [workspace] = await this.database.client
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .limit(1);

    return workspace ?? null;
  }
}
