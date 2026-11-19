import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/api/zod-validation.pipe';
import { UnauthenticatedError, ValidationError } from '../../common/errors/app-error';
import { RequestContext } from '../../common/logging/request-context';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { RequireWorkspaceRole } from '../workspace/require-workspace-role.decorator';
import { CustomerErasureService } from './customer-erasure.service';

/** The caller must type this exact phrase — erasure is permanent and irreversible. */
export const ERASURE_CONFIRMATION = 'ERASE CUSTOMER';

const eraseCustomerSchema = z.object({ confirmation: z.literal(ERASURE_CONFIRMATION) }).strict();
type EraseCustomerInput = z.infer<typeof eraseCustomerSchema>;

/**
 * Person-level customer erasure (Stage 10). Owner-only; the workspace comes from the membership guard's route
 * param, never the body. Returns counts only — no personal data.
 */
@Controller('workspaces/:workspaceId/customers/:canonicalCustomerId/erasure')
@UseGuards(WorkspaceMembershipGuard)
@RequireWorkspaceRole('owner')
export class CustomerErasureController {
  constructor(private readonly customerErasureService: CustomerErasureService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async erase(
    @Param('workspaceId') workspaceId: string,
    @Param('canonicalCustomerId') canonicalCustomerId: string,
    @Body(new ZodValidationPipe(eraseCustomerSchema)) body: EraseCustomerInput,
  ) {
    // The schema already requires it; checked again here so a permanent erasure never depends on the pipe alone.
    if (body.confirmation !== ERASURE_CONFIRMATION) {
      throw new ValidationError('Type the confirmation phrase to erase this customer.');
    }
    const actorUserId = RequestContext.get()?.userId;
    if (!actorUserId) {
      throw new UnauthenticatedError();
    }
    return this.customerErasureService.eraseCanonicalCustomer(
      workspaceId,
      canonicalCustomerId,
      actorUserId,
    );
  }
}
