import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { loadConfiguration } from './config/configuration';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { AuthGuard } from './common/auth/auth.guard';
import { RateLimitGuard } from './common/rate-limit/rate-limit.guard';
import { RedisService } from './common/rate-limit/redis.service';
import { ProtectedDataAccessInterceptor } from './common/access-log/protected-data-access.interceptor';
import { LoggingModule } from './common/logging/logging.module';
import { EventsModule } from './common/events/events.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { DatabaseModule } from './database/database.module';
import { WorkspaceModule } from './domains/workspace/workspace.module';
import { IntegrationModule } from './domains/integration/integration.module';
import { CommerceModule } from './domains/commerce/commerce.module';
import { IdentityResolutionModule } from './domains/identity-resolution/identity-resolution.module';
import { CustomerIntelligenceModule } from './domains/customer-intelligence/customer-intelligence.module';
import { IntelligenceEnginesModule } from './domains/intelligence-engines/intelligence-engines.module';
import { DashboardModule } from './domains/dashboard/dashboard.module';
import { MerchantKnowledgeModule } from './domains/merchant-knowledge/merchant-knowledge.module';
import { AiModule } from './domains/ai/ai.module';
import { AiAgentsModule } from './domains/ai-agents/ai-agents.module';
import { AiActionControlModule } from './domains/ai-action-control/ai-action-control.module';
import { ConversationModule } from './domains/conversation/conversation.module';
import { AutomationModule } from './domains/automation/automation.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [loadConfiguration],
    }),
    LoggingModule,
    DatabaseModule,
    EventsModule,
    IdempotencyModule,
    WorkspaceModule,
    IntegrationModule,
    CommerceModule,
    IdentityResolutionModule,
    CustomerIntelligenceModule,
    IntelligenceEnginesModule,
    DashboardModule,
    MerchantKnowledgeModule,
    AiModule,
    AiAgentsModule,
    AiActionControlModule,
    ConversationModule,
    AutomationModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: AuthGuard },
    // Runs after AuthGuard (registration order) — RequestContext.userId is
    // already set for an authenticated request. See RateLimitGuard's own
    // doc comment (doc19 Phase 17 hardening).
    { provide: APP_GUARD, useClass: RateLimitGuard },
    RedisService,
    { provide: APP_INTERCEPTOR, useClass: ProtectedDataAccessInterceptor },
  ],
})
export class AppModule {}
