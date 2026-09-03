import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { MerchantKnowledgeService } from './merchant-knowledge.service';
import { MerchantKnowledgeController } from './merchant-knowledge.controller';

/**
 * Owns: merchant knowledge, business policies, context composition,
 * retrieval, grounding, knowledge indexing, AI context preparation.
 * See: "13. BRAYN Merchant Knowledge & Policy Store"
 *
 * Phase 1 (doc19 Phase 10): merchant-authored knowledge/policy entries
 * with versioning and structured-lookup retrieval only — see
 * MerchantKnowledgeService's doc comment for what's deferred (upload/
 * ingestion pipeline, AI context wiring).
 *
 * Imports WorkspaceModule for WorkspaceMembershipGuard rather than
 * duplicating the tenant-isolation/authorization boundary.
 */
@Module({
  imports: [WorkspaceModule],
  controllers: [MerchantKnowledgeController],
  providers: [MerchantKnowledgeService],
  exports: [MerchantKnowledgeService],
})
export class MerchantKnowledgeModule {}
