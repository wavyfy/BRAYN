import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { CommerceModule } from '../commerce/commerce.module';
import { IdentityResolutionModule } from '../identity-resolution/identity-resolution.module';
import { IntegrationController } from './integration.controller';
import { WebhookController } from './webhook.controller';
import { IntegrationService } from './integration.service';
import { ProviderRegistry } from './provider-registry.service';
import { ImportRunService } from './import-run.service';
import { ImportProcessorService } from './import-processor.service';
import { WebhookIngestService } from './webhook-ingest.service';
import { WebhookEventProcessorService } from './webhook-event-processor.service';
import { IntegrationHealthService } from './integration-health.service';
import { ReconciliationRunService } from './reconciliation-run.service';
import { ReconciliationProcessorService } from './reconciliation-processor.service';
import { SyncProcessorService } from './sync-processor.service';
import { ShopifyAdapter } from './providers/shopify/shopify.adapter';
import { ShopifyOAuthService } from './providers/shopify/shopify-oauth.service';
import { ShopifyOAuthHandoffService } from './providers/shopify/shopify-oauth-handoff.service';
import { ShopifyOAuthHandoffGuard } from './providers/shopify/shopify-oauth-handoff.guard';
import { ShopifyOAuthStartController, ShopifyOAuthCallbackController } from './providers/shopify/shopify-oauth.controller';
import { ShopifyComplianceService } from './providers/shopify/shopify-compliance.service';
import { ShopifyComplianceController } from './providers/shopify/shopify-compliance.controller';
import { ShopifyUninstallService } from './providers/shopify/shopify-uninstall.service';
import { ShopifyUninstallController } from './providers/shopify/shopify-uninstall.controller';
import { WooCommerceAdapter } from './providers/woocommerce/woocommerce.adapter';
import { WooCommerceWebhookSetupService } from './providers/woocommerce/woocommerce-webhook-setup.service';
import { WooCommerceWebhookSetupController } from './providers/woocommerce/woocommerce-webhook-setup.controller';
import { FlexyPeAdapter } from './providers/flexype/flexype.adapter';
import { CheckoutSessionService } from './checkout-session.service';
import { FlexyPeWebhookSetupService } from './providers/flexype/flexype-webhook-setup.service';
import { FlexyPeWebhookSetupController } from './providers/flexype/flexype-webhook-setup.controller';
import { CustomerErasureController } from './customer-erasure.controller';
import { CustomerErasureService } from './customer-erasure.service';
import { ShopifyWebhookMigrationService } from './providers/shopify/shopify-webhook-migration.service';
import { ShopifyWebhookMigrationController } from './providers/shopify/shopify-webhook-migration.controller';
import { ShopifyWebhookMigrationGuard } from './providers/shopify/shopify-webhook-migration.guard';

/**
 * Owns: external connections, provider auth, imports, sync, webhook intake,
 * normalization, reconciliation, integration health.
 * See: "06. BRAYN Integration & Ingestion"
 *
 * Phase 3 built the reusable framework: integration model, connection
 * lifecycle, credential handling, provider abstraction (ProviderRegistry),
 * import-run/webhook/reconciliation bookkeeping, integration health.
 *
 * Phase 4 registers concrete provider adapters one at a time (doc 19).
 * Shopify is first: ShopifyAdapter self-registers into ProviderRegistry
 * on module init (custom-app Admin API token — see the adapter's own
 * doc comment for why, and how it can be swapped for OAuth later without
 * touching this domain's model).
 *
 * Imports WorkspaceModule for WorkspaceMembershipGuard rather than
 * duplicating the tenant-isolation/authorization boundary.
 */
@Module({
  imports: [WorkspaceModule, CommerceModule, IdentityResolutionModule],
  controllers: [
    IntegrationController,
    WebhookController,
    ShopifyOAuthStartController,
    ShopifyOAuthCallbackController,
    ShopifyComplianceController,
    ShopifyUninstallController,
    WooCommerceWebhookSetupController,
    FlexyPeWebhookSetupController,
    CustomerErasureController,
    ShopifyWebhookMigrationController,
  ],
  providers: [
    IntegrationService,
    CustomerErasureService,
    ProviderRegistry,
    ImportRunService,
    ImportProcessorService,
    WebhookIngestService,
    WebhookEventProcessorService,
    IntegrationHealthService,
    ReconciliationRunService,
    ReconciliationProcessorService,
    SyncProcessorService,
    ShopifyAdapter,
    ShopifyOAuthService,
    ShopifyOAuthHandoffService,
    ShopifyOAuthHandoffGuard,
    ShopifyComplianceService,
    ShopifyUninstallService,
    WooCommerceAdapter,
    WooCommerceWebhookSetupService,
    FlexyPeAdapter,
    FlexyPeWebhookSetupService,
    CheckoutSessionService,
    ShopifyWebhookMigrationService,
    ShopifyWebhookMigrationGuard,
  ],
  exports: [
    IntegrationService,
    ProviderRegistry,
    ImportRunService,
    WebhookIngestService,
    IntegrationHealthService,
    ReconciliationRunService,
  ],
})
export class IntegrationModule {}
