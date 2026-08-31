import { Controller, Get } from '@nestjs/common';
import { RequestContext } from '../../common/logging/request-context';
import { UnauthenticatedError } from '../../common/errors/app-error';
import { UserService } from './user.service';

/** Protected by the global AuthGuard by default (Step 6) — no @Public(). */
@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get('me')
  async me() {
    const clerkUserId = RequestContext.get()?.userId;
    if (!clerkUserId) {
      throw new UnauthenticatedError('A bearer token is required.');
    }

    return this.userService.findOrCreateByClerkId(clerkUserId);
  }
}
