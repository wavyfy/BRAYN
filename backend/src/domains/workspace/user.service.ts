import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { users } from '../../database/schema/users';

@Injectable()
export class UserService {
  constructor(private readonly database: DatabaseService) {}

  /** Provisions the domain user record for a Clerk session on first sight. */
  async findOrCreateByClerkId(clerkUserId: string) {
    const [existing] = await this.database.client
      .select()
      .from(users)
      .where(eq(users.clerkUserId, clerkUserId))
      .limit(1);

    if (existing) {
      return existing;
    }

    const [created] = await this.database.client
      .insert(users)
      .values({ clerkUserId })
      .onConflictDoNothing()
      .returning();

    if (created) {
      return created;
    }

    // Lost a race against a concurrent first-login for the same Clerk user.
    const [winner] = await this.database.client
      .select()
      .from(users)
      .where(eq(users.clerkUserId, clerkUserId))
      .limit(1);

    return winner;
  }
}
