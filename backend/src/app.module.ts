import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { loadConfiguration } from './config/configuration';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { AuthGuard } from './common/auth/auth.guard';
import { LoggingModule } from './common/logging/logging.module';
import { EventsModule } from './common/events/events.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { DatabaseModule } from './database/database.module';
import { WorkspaceModule } from './domains/workspace/workspace.module';
import { IntegrationModule } from './domains/integration/integration.module';
import { IdentityResolutionModule } from './domains/identity-resolution/identity-resolution.module';
import { CustomerIntelligenceModule } from './domains/customer-intelligence/customer-intelligence.module';
import { IntelligenceEnginesModule } from './domains/intelligence-engines/intelligence-engines.module';
import { MerchantKnowledgeModule } from './domains/merchant-knowledge/merchant-knowledge.module';
import { AiModule } from './domains/ai/ai.module';
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
    IdentityResolutionModule,
    CustomerIntelligenceModule,
    IntelligenceEnginesModule,
    MerchantKnowledgeModule,
    AiModule,
    ConversationModule,
    AutomationModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
