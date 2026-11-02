import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { RequireWorkspaceRole } from '../workspace/require-workspace-role.decorator';
import { ZodValidationPipe } from '../../common/api/zod-validation.pipe';
import { DEFAULT_NOTIFICATIONS_LIMIT, InternalNotificationService, MAX_NOTIFICATIONS_LIMIT } from './internal-notification.service';

const listNotificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_NOTIFICATIONS_LIMIT).default(DEFAULT_NOTIFICATIONS_LIMIT),
});

/** Doc28 "Notifications" row — View for every workspace role (decision, Nov 2, 2026). Read-only: notifications are created only by automation. */
@Controller('workspaces/:workspaceId/notifications')
@UseGuards(WorkspaceMembershipGuard)
export class InternalNotificationController {
  constructor(private readonly internalNotificationService: InternalNotificationService) {}

  @Get()
  @RequireWorkspaceRole('owner', 'admin', 'marketing', 'support', 'analyst')
  async list(@Param('workspaceId') workspaceId: string, @Query(new ZodValidationPipe(listNotificationsQuerySchema)) query: z.infer<typeof listNotificationsQuerySchema>) {
    return this.internalNotificationService.list(workspaceId, query.limit);
  }
}
