import { Controller, Get } from '@nestjs/common';
import { RequestContext } from '../../common/logging/request-context';
import { UnauthenticatedError } from '../../common/errors/app-error';
import { UserService } from './user.service';
import { WorkspaceMembershipService } from './workspace-membership.service';

/** Protected by the global AuthGuard by default (Step 6) — no @Public(). */
@Controller('users')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly membershipService: WorkspaceMembershipService,
  ) {}

  @Get('me')
  async me() {
    const clerkUserId = this.requireCallerClerkId();

    return this.userService.findOrCreateByClerkId(clerkUserId);
  }

  /** Doc 19 Phase 2 Visible Result — "Access a workspace": discover which workspace(s) to open post-signup. */
  @Get('me/workspaces')
  async myWorkspaces() {
    const clerkUserId = this.requireCallerClerkId();
    const user = await this.userService.findOrCreateByClerkId(clerkUserId);

    return this.membershipService.listByUser(user.id);
  }

  private requireCallerClerkId(): string {
    const clerkUserId = RequestContext.get()?.userId;
    if (!clerkUserId) {
      throw new UnauthenticatedError('A bearer token is required.');
    }

    return clerkUserId;
  }
}
