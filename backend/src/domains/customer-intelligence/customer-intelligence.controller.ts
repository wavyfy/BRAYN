import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/api/zod-validation.pipe';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { RequireWorkspaceRole } from '../workspace/require-workspace-role.decorator';
import { LogsProtectedAccess } from '../../common/access-log/protected-data-access.decorator';
import { CustomerIntelligenceService } from './customer-intelligence.service';
import { CustomerMemoryService } from './customer-memory.service';
import {
  createMemoryEntrySchema,
  updateMemoryEntrySchema,
  type CreateMemoryEntryInput,
  type UpdateMemoryEntryInput,
} from './dto/memory-entry.schema';
import { CustomerPreferenceService } from './customer-preference.service';
import {
  createPreferenceSchema,
  updatePreferenceSchema,
  type CreatePreferenceInput,
  type UpdatePreferenceInput,
} from './dto/preference.schema';

/**
 * Reuses the workspace domain's authorization boundary rather than
 * duplicating it (doc 03 rule 9 — business logic has one home).
 *
 * Owner/admin only — every method here returns customer-identifying
 * personal data (email/phone/name, or order/activity tied to a specific
 * customer). Class-level `@RequireWorkspaceRole` applies to all three
 * handlers (`WorkspaceMembershipGuard` checks the handler first, then
 * falls back to the class), so it's declared once rather than repeated.
 */
@Controller('workspaces/:workspaceId/customers')
@UseGuards(WorkspaceMembershipGuard)
@RequireWorkspaceRole('owner', 'admin')
export class CustomerIntelligenceController {
  constructor(
    private readonly customerIntelligenceService: CustomerIntelligenceService,
    private readonly customerMemoryService: CustomerMemoryService,
    private readonly customerPreferenceService: CustomerPreferenceService,
  ) {}

  @Get()
  @LogsProtectedAccess('customer')
  async list(
    @Param('workspaceId') workspaceId: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.customerIntelligenceService.listCustomers(workspaceId, {
      search,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':canonicalCustomerId')
  @LogsProtectedAccess('customer', 'canonicalCustomerId')
  async get(@Param('workspaceId') workspaceId: string, @Param('canonicalCustomerId') canonicalCustomerId: string) {
    return this.customerIntelligenceService.getCustomer(workspaceId, canonicalCustomerId);
  }

  @Get(':canonicalCustomerId/activity')
  @LogsProtectedAccess('customer_activity', 'canonicalCustomerId')
  async getActivity(@Param('workspaceId') workspaceId: string, @Param('canonicalCustomerId') canonicalCustomerId: string) {
    return this.customerIntelligenceService.getActivity(workspaceId, canonicalCustomerId);
  }

  @Get(':canonicalCustomerId/memory')
  @LogsProtectedAccess('customer', 'canonicalCustomerId')
  async listMemory(@Param('workspaceId') workspaceId: string, @Param('canonicalCustomerId') canonicalCustomerId: string) {
    return this.customerMemoryService.list(workspaceId, canonicalCustomerId);
  }

  @Post(':canonicalCustomerId/memory')
  @LogsProtectedAccess('customer', 'canonicalCustomerId')
  async createMemory(
    @Param('workspaceId') workspaceId: string,
    @Param('canonicalCustomerId') canonicalCustomerId: string,
    @Body(new ZodValidationPipe(createMemoryEntrySchema)) body: CreateMemoryEntryInput,
  ) {
    return this.customerMemoryService.create(workspaceId, canonicalCustomerId, body);
  }

  @Patch(':canonicalCustomerId/memory/:memoryEntryId')
  @LogsProtectedAccess('customer', 'canonicalCustomerId')
  async updateMemory(
    @Param('workspaceId') workspaceId: string,
    @Param('canonicalCustomerId') canonicalCustomerId: string,
    @Param('memoryEntryId') memoryEntryId: string,
    @Body(new ZodValidationPipe(updateMemoryEntrySchema)) body: UpdateMemoryEntryInput,
  ) {
    return this.customerMemoryService.update(workspaceId, canonicalCustomerId, memoryEntryId, body);
  }

  @Post(':canonicalCustomerId/memory/:memoryEntryId/archive')
  @HttpCode(HttpStatus.OK)
  @LogsProtectedAccess('customer', 'canonicalCustomerId')
  async archiveMemory(
    @Param('workspaceId') workspaceId: string,
    @Param('canonicalCustomerId') canonicalCustomerId: string,
    @Param('memoryEntryId') memoryEntryId: string,
  ) {
    return this.customerMemoryService.archive(workspaceId, canonicalCustomerId, memoryEntryId);
  }

  @Get(':canonicalCustomerId/preferences')
  @LogsProtectedAccess('customer', 'canonicalCustomerId')
  async listPreferences(@Param('workspaceId') workspaceId: string, @Param('canonicalCustomerId') canonicalCustomerId: string) {
    return this.customerPreferenceService.list(workspaceId, canonicalCustomerId);
  }

  @Post(':canonicalCustomerId/preferences')
  @LogsProtectedAccess('customer', 'canonicalCustomerId')
  async createPreference(
    @Param('workspaceId') workspaceId: string,
    @Param('canonicalCustomerId') canonicalCustomerId: string,
    @Body(new ZodValidationPipe(createPreferenceSchema)) body: CreatePreferenceInput,
  ) {
    return this.customerPreferenceService.create(workspaceId, canonicalCustomerId, body);
  }

  @Patch(':canonicalCustomerId/preferences/:preferenceId')
  @LogsProtectedAccess('customer', 'canonicalCustomerId')
  async updatePreference(
    @Param('workspaceId') workspaceId: string,
    @Param('canonicalCustomerId') canonicalCustomerId: string,
    @Param('preferenceId') preferenceId: string,
    @Body(new ZodValidationPipe(updatePreferenceSchema)) body: UpdatePreferenceInput,
  ) {
    return this.customerPreferenceService.update(workspaceId, canonicalCustomerId, preferenceId, body);
  }

  @Post(':canonicalCustomerId/preferences/:preferenceId/archive')
  @HttpCode(HttpStatus.OK)
  @LogsProtectedAccess('customer', 'canonicalCustomerId')
  async archivePreference(
    @Param('workspaceId') workspaceId: string,
    @Param('canonicalCustomerId') canonicalCustomerId: string,
    @Param('preferenceId') preferenceId: string,
  ) {
    return this.customerPreferenceService.archive(workspaceId, canonicalCustomerId, preferenceId);
  }
}
