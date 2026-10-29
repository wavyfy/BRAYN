# Graph Report - BRAYN  (2026-10-29)

## Corpus Check
- 480 files · ~395,137 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2531 nodes · 8254 edges · 117 communities (90 shown, 27 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 313 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13
- Community 14
- Community 15
- Community 16
- Community 17
- Community 18
- Community 19
- Community 20
- Community 21
- Community 22
- Community 23
- Community 24
- Community 25
- Community 26
- Community 27
- Community 28
- Community 29
- Community 30
- Community 31
- Community 32
- Community 33
- Community 34
- Community 35
- Community 36
- Community 37
- Community 38
- Community 39
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 45
- Community 46
- Community 47
- Community 48
- Community 49
- Community 50
- Community 51
- Community 52
- Community 53
- Community 54
- Community 55
- Community 56
- Community 57
- Community 58
- Community 59
- Community 60
- Community 61
- Community 62
- Community 63
- Community 64
- Community 65
- Community 66
- Community 67
- Community 68
- Community 69
- Community 70
- Community 71
- Community 72
- Community 73
- Community 74
- Community 75
- Community 76
- Community 77
- Community 78
- Community 79
- Community 80
- Community 81
- Community 82
- Community 83
- Community 84
- Community 85
- Community 86
- Community 88
- Community 89
- Community 90
- Community 91
- Community 92
- Community 93
- Community 94
- Community 95
- Community 96
- Community 97
- Community 98
- Community 99
- Community 100
- Community 101
- Community 102
- Community 103
- Community 104
- Community 105
- Community 106
- Community 107
- Community 108
- Community 109
- Community 110
- Community 111
- Community 112
- Community 113

## God Nodes (most connected - your core abstractions)
1. `DatabaseService` - 124 edges
2. `@nestjs/common` - 111 edges
3. `StructuredLoggerService` - 90 edges
4. `IntegrationProvider` - 87 edges
5. `drizzle-orm` - 85 edges
6. `IntegrationService` - 70 edges
7. `NotFoundError` - 60 edges
8. `ProviderError` - 57 edges
9. `apiFetch()` - 54 edges
10. `workspaceId()` - 49 edges

## Surprising Connections (you probably didn't know these)
- `AI Action Control` --semantically_similar_to--> `agent-browser CLI (CDP browser automation)`  [INFERRED] [semantically similar]
  README.md → .agents/skills/agent-browser/SKILL.md
- `decide()` --indirect_call--> `workspaceId()`  [INFERRED]
  frontend/app/workspace/[workspaceId]/ai-actions/ai-action-decision-buttons.tsx → backend/src/database/schema/columns.ts
- `send()` --indirect_call--> `workspaceId()`  [INFERRED]
  frontend/public/tracking.js → backend/src/database/schema/columns.ts
- `storedOrder()` --indirect_call--> `workspaceId()`  [INFERRED]
  backend/src/domains/commerce/commerce-events.db.spec.ts → backend/src/database/schema/columns.ts
- `integrationRow()` --indirect_call--> `workspaceId()`  [INFERRED]
  backend/src/domains/integration/providers/shopify/shopify-app-lifecycle.db.spec.ts → backend/src/database/schema/columns.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **AI Action Governance Flow** — brayn_ai_action_control, brayn_business_action_automation, brayn_principle_permission_aware_actions [EXTRACTED 1.00]
- **Shared Customer Intelligence Foundation** — brayn_unified_customer_intelligence_record, brayn_customer_intelligence_view, brayn_customer_activity_history, brayn_customer_risk_engagement_state, brayn_revenue_opportunity_detector, brayn_merchant_knowledge_policy_store, brayn_merchant_business_analyst, brayn_ai_action_control, brayn_business_action_automation [EXTRACTED 1.00]

## Communities (117 total, 27 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.10
Nodes (49): addMember(), connectIntegrationCredentials(), connectProviderWithCredentials(), createAutomation(), createKnowledgeEntry(), createWorkspace(), removeMember(), renameWorkspace() (+41 more)

### Community 1 - "Community 1"
Cohesion: 0.06
Nodes (30): RetryOptions, sleep(), withRetry(), CreateEventInput, DomainEvent, NormalizedCollect, NormalizedCollection, CustomerService (+22 more)

### Community 2 - "Community 2"
Cohesion: 0.13
Nodes (20): createWidgetSchema, AuthGuard, buildApp(), AllExceptionsFilter, STATUS_TO_CODE, registerHttpLogging(), Level, LogLine (+12 more)

### Community 3 - "Community 3"
Cohesion: 0.09
Nodes (59): AiActionRequest, AiActionsPage(), describeOutcome(), riskTone, statusTone, Automation, AutomationDetailPage(), AutomationRun (+51 more)

### Community 4 - "Community 4"
Cohesion: 0.09
Nodes (28): ZodValidationPipe, AiActionRequestController, AskQuestionInput, askQuestionSchema, SendMessageInput, sendMessageSchema, conversationChannels, StartConversationInput (+20 more)

### Community 5 - "Community 5"
Cohesion: 0.05
Nodes (22): ReserveOptions, dialect, DatabaseModule, DatabaseService, idempotencyKeys, integrationImportRuns, integrationReconciliationRuns, customer (+14 more)

### Community 6 - "Community 6"
Cohesion: 0.06
Nodes (19): PROTECTED_DATA_ACCESS_KEY, ProtectedDataAccessMeta, ProtectedResourceType, ProtectedDataAccessInterceptor, RequestContext, RequestContextStore, storage, protectedDataAccessLog (+11 more)

### Community 7 - "Community 7"
Cohesion: 0.05
Nodes (50): NormalizedFulfillment, NormalizedRefund, DesiredWebhookSubscription, EnsureWebhookSubscriptionsResult, graphqlCollectionToRestShape(), graphqlCustomerToRestShape(), graphqlFulfillmentToRestShape(), graphqlLineItemToRestShape() (+42 more)

### Community 8 - "Community 8"
Cohesion: 0.06
Nodes (7): LogsProtectedAccess(), ConversationController, ConversationService, makeSelectChain(), makeSelectQueue(), CustomerIntelligenceController, IdentityResolutionController

### Community 9 - "Community 9"
Cohesion: 0.06
Nodes (29): EventBus, commerceFulfillments, commerceOrderLineItems, commerceRefundLineItems, COMMERCE_EVENT_TYPES, deliver(), deliverRefund(), healthHistoryCount() (+21 more)

### Community 10 - "Community 10"
Cohesion: 0.08
Nodes (35): detectRevenueOpportunities(), generateRecommendations(), recalculateCustomerHealth(), { apiFetch, refresh, approveAiActionRequest, denyAiActionRequest }, pendingRequest, DetectOpportunitiesButton(), { refresh, detectRevenueOpportunities }, GenerateRecommendationsButton() (+27 more)

### Community 11 - "Community 11"
Cohesion: 0.13
Nodes (27): AppModule, canonicalCustomerDuplicates, IdentityConfidence, identityConfidenceLevels, IdentityReviewSignal, identityReviewSignals, canonicalCustomers, commerceCustomers (+19 more)

### Community 12 - "Community 12"
Cohesion: 0.12
Nodes (5): ConflictError, NotFoundError, IntegrationProvider, IntegrationService, WebhookIngestService

### Community 13 - "Community 13"
Cohesion: 0.09
Nodes (37): HomePage(), WorkspaceSummary, ActivityEntry, activityKey(), ActivityLabel(), ActivityTimeline(), Events(), monthLabel() (+29 more)

### Community 14 - "Community 14"
Cohesion: 0.06
Nodes (43): dependencies, @clerk/nextjs@^7.8.3, clsx@2.1.1, next@14.2.21, react@18.3.1, react-dom@18.3.1, tailwind-merge@2.6.0, zod@4.4.3 (+35 more)

### Community 15 - "Community 15"
Cohesion: 0.07
Nodes (5): ImportProcessorService, ImportRunService, IntegrationHealthService, ProviderAdapter, SyncProcessorService

### Community 16 - "Community 16"
Cohesion: 0.08
Nodes (35): dismissRecommendation(), DismissRecommendationButton(), { refresh, dismissRecommendation }, OpportunityRow(), opportunityTypeLabel(), priorityRailClass, priorityRank, Recommendation (+27 more)

### Community 17 - "Community 17"
Cohesion: 0.23
Nodes (16): id(), timestamps(), workspaceId(), commerceCollectionProducts, commerceCollections, commerceOrders, commerceProductVariants, commerceProducts (+8 more)

### Community 18 - "Community 18"
Cohesion: 0.09
Nodes (11): merchantKnowledgeEntryHistory, CreateEntryInput, createEntrySchema, merchantKnowledgeEntryTypes, UpdateEntryInput, updateEntrySchema, MerchantKnowledgeController, MerchantKnowledgeService (+3 more)

### Community 19 - "Community 19"
Cohesion: 0.09
Nodes (13): DependencyStatus, IS_PUBLIC_KEY, Public(), RATE_LIMIT_TIER_KEY, RateLimitTier, SKIP_RATE_LIMIT_KEY, SkipRateLimit(), LimitTier (+5 more)

### Community 20 - "Community 20"
Cohesion: 0.08
Nodes (21): orderPlacedAt, commerceRefunds, CommerceContext, CustomerIntelligenceService, CustomerListItem, CustomerListPage, CustomerProfile, CustomerRecord (+13 more)

### Community 21 - "Community 21"
Cohesion: 0.09
Nodes (4): WorkspaceRole, UserController, WorkspaceMembershipController, WorkspaceMembershipService

### Community 22 - "Community 22"
Cohesion: 0.14
Nodes (12): AiActionControlModule, AiAgentsModule, AutomationModule, CommerceModule, ConversationModule, CustomerIntelligenceModule, IdentityResolutionModule, IntegrationModule (+4 more)

### Community 23 - "Community 23"
Cohesion: 0.10
Nodes (22): CustomerPage, FetchOptions, OrderPage, ParsedWebhookEvent, assertCursorMatchesStore(), authHeader(), isPrivateOrLoopbackHost(), modifiedAfterParam() (+14 more)

### Community 24 - "Community 24"
Cohesion: 0.07
Nodes (34): dependencies, zod@4.4.3, devDependencies, eslint@10.9.1, eslint-config-prettier@10.1.8, prettier@3.9.6, turbo@2.10.12, @types/node@26.4.0 (+26 more)

### Community 25 - "Community 25"
Cohesion: 0.08
Nodes (20): ErrorResponseBody, AppError, ApprovalRequiredError, RateLimitError, UnauthenticatedError, UnauthorizedError, ErrorCode, APPROVAL_REQUIRED (+12 more)

### Community 26 - "Community 26"
Cohesion: 0.09
Nodes (15): IdempotencyService, websiteEventTypes, clientId, IngestWebsiteEventInput, ingestWebsiteEventSchema, MAX_CLOCK_SKEW_MS, MAX_EVENT_AGE_MS, MAX_PAYLOAD_BYTES (+7 more)

### Community 27 - "Community 27"
Cohesion: 0.15
Nodes (3): ConnectIntegrationInput, IntegrationController, WebhookController

### Community 28 - "Community 28"
Cohesion: 0.13
Nodes (22): connectIntegration(), disconnectIntegration(), generateWebsiteTrackingIdentitySecret(), generateWebsiteTrackingWriteKey(), setWebsiteTrackingAllowedOrigins(), startIntegrationImport(), formatDate(), ImportRun (+14 more)

### Community 29 - "Community 29"
Cohesion: 0.11
Nodes (15): buildDerivedIntelligenceBlock(), buildMerchantKnowledgeBlock(), buildMerchantPolicyBlock(), buildRecommendationsBlock(), buildVerifiedCustomerFactsBlock(), KnowledgeEntryRow, MerchantBusinessAnalystService, RecommendationRow (+7 more)

### Community 30 - "Community 30"
Cohesion: 0.15
Nodes (12): ProviderError, assertCursorMatchesShop(), assertShopifyOrderNodeShape(), decodeShopifyCollectsCursor(), encodeShopifyCollectsCursor(), graphqlCollectToRestShape(), normalizeCollect(), parseNextCursor() (+4 more)

### Community 31 - "Community 31"
Cohesion: 0.16
Nodes (15): request, AiModule, AI_PROVIDER, AiGenerateRequest, AiGenerateResult, AiMessage, AiProvider, AiUsage (+7 more)

### Community 32 - "Community 32"
Cohesion: 0.12
Nodes (12): ValidationError, GET_CUSTOMER_ACTIVITY_HISTORY_TOOL, ReadToolsService, activityCall, activityFixture, makeCustomerIntelligence(), makeDatabase(), makeLogger() (+4 more)

### Community 33 - "Community 33"
Cohesion: 0.12
Nodes (3): RecommendationController, RecommendationService, RecommendationState

### Community 34 - "Community 34"
Cohesion: 0.11
Nodes (14): SHOPIFY_API_VERSION, shopifyTopicEnum(), collectionProductsResponse(), graphqlCollectionsResponse(), graphqlCustomersResponse(), graphqlOrderLineItemsContinuationResponse(), graphqlOrdersResponse(), graphqlProductsResponse() (+6 more)

### Community 35 - "Community 35"
Cohesion: 0.18
Nodes (16): INGEST_IDEMPOTENCY_LEASE_MS, websiteEvents, websiteSessions, websiteVisitors, identitySignaturePayload(), WebsiteEventRequestContext, WebsiteTrackingSettings, customers (+8 more)

### Community 36 - "Community 36"
Cohesion: 0.20
Nodes (17): AgentResult, AgentToolExecutor, buildCustomerFactsBlock(), buildEscalationTool(), buildMerchantKnowledgeBlock(), buildMerchantPolicyBlock(), buildRecommendationsBlock(), buildRevenueOpportunitiesBlock() (+9 more)

### Community 37 - "Community 37"
Cohesion: 0.14
Nodes (4): AutomationController, AutomationService, CreateAutomationInput, UpdateAutomationInput

### Community 38 - "Community 38"
Cohesion: 0.13
Nodes (5): RateLimitGuard, RedisService, { incr, expire, exec, pipeline, constructorCalls }, pipeline(), Env

### Community 40 - "Community 40"
Cohesion: 0.13
Nodes (19): devDependencies, drizzle-kit@0.28.1, @nestjs/cli@10.4.9, @nestjs/schematics@10.2.3, @nestjs/testing@10.4.15, @types/node@26.4.0, @types/pg@8.11.10, typescript@5.9.3 (+11 more)

### Community 41 - "Community 41"
Cohesion: 0.18
Nodes (8): REQUIRED_IN_PRODUCTION, warnOnMissingProductionSecrets(), fastifyAdapterOptions(), ipFor(), initSentry(), loadConfiguration(), envSchema, bootstrap()

### Community 42 - "Community 42"
Cohesion: 0.16
Nodes (13): createEvent(), aiActionRequests, automationDefinitions, automationRuns, customerHealthStateHistory, AutomationConditions, BehaviouralContext, computeFrequencySignal() (+5 more)

### Community 43 - "Community 43"
Cohesion: 0.16
Nodes (16): ACTION_REGISTRY, buildActionRegistry(), completeInputSchema, dismissInputSchema, findActionByName(), GENERATE_RECOMMENDATIONS_ACTION, generateRecommendationsInputSchema, RECOMMENDATION_COMPLETE_ACTION (+8 more)

### Community 44 - "Community 44"
Cohesion: 0.11
Nodes (8): SHOPIFY_APP_UNINSTALLED_TOPIC, SHOPIFY_DOMAIN_PATTERN, verifyShopifyHmac(), ShopifyUninstallController, ShopifyUninstallResult, ShopifyUninstallService, BODY, makeService()

### Community 45 - "Community 45"
Cohesion: 0.14
Nodes (3): DashboardController, DashboardModule, DashboardService

### Community 46 - "Community 46"
Cohesion: 0.11
Nodes (19): dependencies, @clerk/backend@1.24.1, drizzle-orm@0.36.4, fastify@4.28.1, @nestjs/common@10.4.15, @nestjs/config@3.3.0, @nestjs/core@10.4.15, @nestjs/event-emitter@2.1.1 (+11 more)

### Community 47 - "Community 47"
Cohesion: 0.20
Nodes (3): scrubSensitive(), reviveDates(), WebhookEventProcessorService

### Community 48 - "Community 48"
Cohesion: 0.12
Nodes (8): CollectionService, makeSelectChain(), makeSelectQueue(), ClaimedWebhookEvent, customer, makeChain(), makeProcessor(), WEBHOOK_MAX_ATTEMPTS

### Community 49 - "Community 49"
Cohesion: 0.22
Nodes (3): isDiscrepancy(), ReconciliationProcessorService, ReconciliationRunService

### Community 50 - "Community 50"
Cohesion: 0.19
Nodes (7): averageOrderValue(), computePriority(), detectReorder(), detectVipRecognition(), detectWinBack(), parsePrice(), RevenueOpportunityService

### Community 51 - "Community 51"
Cohesion: 0.20
Nodes (10): Loading(), Loading(), Loading(), Loading(), Loading(), Loading(), Loading(), Loading() (+2 more)

### Community 52 - "Community 52"
Cohesion: 0.17
Nodes (4): agent-browser Observability Dashboard, agent-browser CLI (CDP browser automation), agent-browser SKILL.md, BRAYN README

### Community 53 - "Community 53"
Cohesion: 0.18
Nodes (15): customerFixture, healthFixture, KnowledgeFixture, makeCustomerHealth(), makeCustomerIntelligence(), makeDatabase(), makeDeps(), makeGateway() (+7 more)

### Community 54 - "Community 54"
Cohesion: 0.19
Nodes (3): extractGraphqlErrors(), readShopifyErrorField(), ShopifyOAuthService

### Community 55 - "Community 55"
Cohesion: 0.16
Nodes (3): readCookie(), ShopifyOAuthCallbackController, ShopifyOAuthStartController

### Community 57 - "Community 57"
Cohesion: 0.12
Nodes (5): BRAYN Claude Code Rules, Caveman, Claude-Mem, Graphify, Obsidian

### Community 58 - "Community 58"
Cohesion: 0.23
Nodes (5): isNewerVersion(), NOT_STALE(), orderEventPayload(), OrderService, refundProcessedEvents()

### Community 59 - "Community 59"
Cohesion: 0.15
Nodes (9): integrationWebhookEvents, customerDelivery(), integrationRow(), sign(), uninstallDelivery(), ingestWithoutWake(), row(), waitForStatus() (+1 more)

### Community 60 - "Community 60"
Cohesion: 0.26
Nodes (4): ActionDefinition, ActionExecutionContext, ActionRiskLevel, AiActionControlService

### Community 61 - "Community 61"
Cohesion: 0.12
Nodes (16): compilerOptions, allowJs, declaration, incremental, jsx, lib, module, moduleResolution (+8 more)

### Community 62 - "Community 62"
Cohesion: 0.22
Nodes (13): decryptCredential(), encryptCredential(), InvalidEncryptionKeyError, parseEncryptionKey(), KEY, SHOPIFY_AUTHORIZATION_CODE_GRANT_TYPE, SHOPIFY_CLIENT_CREDENTIALS_GRANT_TYPE, SHOPIFY_REGISTERED_BUSINESS_TOPICS (+5 more)

### Community 63 - "Community 63"
Cohesion: 0.17
Nodes (8): contextFor(), lowRiskInputSchema, makeDatabase(), makeIdempotency(), makeLogger(), makeMerchantKnowledge(), makeService(), ownerContext()

### Community 64 - "Community 64"
Cohesion: 0.12
Nodes (15): compilerOptions, declaration, emitDecoratorMetadata, experimentalDecorators, lib, module, moduleResolution, noUncheckedIndexedAccess (+7 more)

### Community 65 - "Community 65"
Cohesion: 0.24
Nodes (8): AiActionsError(), AutomationsError(), CustomerDetailError(), CustomersError(), WorkspaceError(), IntegrationsError(), KnowledgeError(), RouteError()

### Community 66 - "Community 66"
Cohesion: 0.12
Nodes (15): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, lib, module, moduleResolution (+7 more)

### Community 68 - "Community 68"
Cohesion: 0.21
Nodes (3): normalizePhoneE164(), IdentityResolutionService, normalizeEmail()

### Community 69 - "Community 69"
Cohesion: 0.20
Nodes (10): SalesAgentService, SEARCH_PRODUCTS_TOOL, customerFixture, makeCustomerIntelligence(), makeGateway(), makeMerchantKnowledge(), makeProduct(), makeRecommendation() (+2 more)

### Community 70 - "Community 70"
Cohesion: 0.18
Nodes (11): askMerchantBusinessAnalyst(), AnswerMarkdown(), Block, parseBlocks(), renderInline(), AskBraynCard(), AskBraynContext, countLabel() (+3 more)

### Community 71 - "Community 71"
Cohesion: 0.18
Nodes (7): customerDataRequests, SHOPIFY_COMPLIANCE_TOPICS, ShopifyComplianceCustomer, ShopifyComplianceTopic, ShopifyCustomersRedactPayload, ShopifyDataRequestPayload, ShopifyShopRedactPayload

### Community 72 - "Community 72"
Cohesion: 0.14
Nodes (13): aliases, components, utils, rsc, $schema, style, tailwind, baseColor (+5 more)

### Community 73 - "Community 73"
Cohesion: 0.15
Nodes (12): dependsOn, env, outputs, cache, persistent, $schema, tasks, build (+4 more)

### Community 74 - "Community 74"
Cohesion: 0.30
Nodes (10): makeChain(), makeConfig(), makeEventBus(), makeImportRunService(), makeReconciliationRunService(), makeRegistry(), makeSelectQueue(), makeService() (+2 more)

### Community 75 - "Community 75"
Cohesion: 0.23
Nodes (7): decodeShopifyCallbackQuery(), shopifyCanonicalMessage(), signedQuery(), start(), startThenCallback(), toRawQueryString(), VALID_KEY

### Community 77 - "Community 77"
Cohesion: 0.18
Nodes (7): pg@8.13.1, client, databaseUrl, envText, line, { Client }, pg

### Community 78 - "Community 78"
Cohesion: 0.18
Nodes (11): scripts, build, db:generate, db:migrate, db:studio, dev, lint, seed:demo (+3 more)

### Community 79 - "Community 79"
Cohesion: 0.22
Nodes (4): WidgetCreatedListener, WidgetCreatedPayload, EventsModule, @nestjs/event-emitter

### Community 80 - "Community 80"
Cohesion: 0.25
Nodes (7): ESCALATE_TO_HUMAN_TOOL, customerFixture, makeCustomerIntelligence(), makeGateway(), makeMerchantKnowledge(), makeService(), SupportAgentService

### Community 88 - "Community 88"
Cohesion: 0.29
Nodes (6): automationConditionsSchema, automationTriggerTypes, createAutomationSchema, opportunityPriorities, opportunityTypes, updateAutomationSchema

### Community 89 - "Community 89"
Cohesion: 0.25
Nodes (7): allowBuilds, @clerk/shared, esbuild, @nestjs/core, minimumReleaseAgeExclude, onlyBuiltDependencies, packages

### Community 90 - "Community 90"
Cohesion: 0.29
Nodes (6): collection, compilerOptions, deleteOutDir, tsConfigPath, $schema, sourceRoot

### Community 92 - "Community 92"
Cohesion: 0.33
Nodes (4): constructor(), mockConstructor, mockCreate, request

### Community 93 - "Community 93"
Cohesion: 0.38
Nodes (4): makePaginatedSelectChain(), makeSelectChain(), makeSelectQueue(), product

### Community 94 - "Community 94"
Cohesion: 0.38
Nodes (6): normalizeCollection(), normalizeCustomer(), normalizeFulfillment(), normalizeOrder(), normalizeProduct(), normalizeRefund()

### Community 95 - "Community 95"
Cohesion: 0.62
Nodes (5): approveAiActionRequest(), denyAiActionRequest(), AiActionDecisionButtons(), decide(), { refresh, approveAiActionRequest, denyAiActionRequest }

### Community 96 - "Community 96"
Cohesion: 0.29
Nodes (3): GlobalError(), inter, metadata

### Community 99 - "Community 99"
Cohesion: 0.60
Nodes (5): integration, makeAdapter(), makeChain(), makeDeps(), makeSelectQueue()

### Community 100 - "Community 100"
Cohesion: 0.40
Nodes (3): makeSelectChain(), makeSelectQueue(), OPPORTUNITY

### Community 103 - "Community 103"
Cohesion: 0.40
Nodes (4): printWidth, semi, singleQuote, trailingComma

### Community 105 - "Community 105"
Cohesion: 0.50
Nodes (3): exclude, extends, ./tsconfig.json

### Community 107 - "Community 107"
Cohesion: 0.83
Nodes (3): getOrCreate(), randomId(), send()

## Knowledge Gaps
- **17 isolated node(s):** `VALIDATION_ERROR`, `UNAUTHENTICATED`, `UNAUTHORIZED`, `NOT_FOUND`, `CONFLICT` (+12 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 797 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **27 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@nestjs/common` connect `Community 4` to `Community 1`, `Community 2`, `Community 5`, `Community 6`, `Community 7`, `Community 9`, `Community 11`, `Community 17`, `Community 18`, `Community 19`, `Community 20`, `Community 22`, `Community 23`, `Community 25`, `Community 29`, `Community 31`, `Community 33`, `Community 35`, `Community 36`, `Community 40`, `Community 42`, `Community 43`, `Community 44`, `Community 45`, `Community 46`, `Community 59`, `Community 62`, `Community 71`, `Community 79`, `Community 104`?**
  _High betweenness centrality (0.065) - this node is a cross-community bridge._
- **What connects `VALIDATION_ERROR`, `UNAUTHENTICATED`, `UNAUTHORIZED` to the rest of the system?**
  _17 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.09911141490088858 - nodes in this community are weakly interconnected._
- **Why does `NotFoundError` connect `Community 12` to `Community 2`, `Community 4`, `Community 5`, `Community 8`, `Community 11`, `Community 15`, `Community 17`, `Community 18`, `Community 20`, `Community 21`, `Community 25`, `Community 29`, `Community 33`, `Community 37`, `Community 42`, `Community 49`, `Community 53`, `Community 56`, `Community 59`, `Community 60`, `Community 63`, `Community 69`, `Community 80`, `Community 85`?**
  _High betweenness centrality (0.035) - this node is a cross-community bridge._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.06198198198198198 - nodes in this community are weakly interconnected._
- **Why does `StructuredLoggerService` connect `Community 2` to `Community 1`, `Community 6`, `Community 9`, `Community 12`, `Community 19`, `Community 20`, `Community 25`, `Community 26`, `Community 29`, `Community 31`, `Community 32`, `Community 35`, `Community 38`, `Community 41`, `Community 42`, `Community 44`, `Community 48`, `Community 53`, `Community 54`, `Community 59`, `Community 62`, `Community 63`, `Community 67`, `Community 71`, `Community 75`, `Community 84`, `Community 91`, `Community 92`, `Community 99`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.13013698630136986 - nodes in this community are weakly interconnected._