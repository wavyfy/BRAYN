# Graph Report - .  (2026-08-31)

## Corpus Check
- 89 files · ~14,342 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 972 nodes · 1275 edges · 73 communities (63 shown, 10 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 16 edges (avg confidence: 0.84)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 72|Community 72]]

## God Nodes (most connected - your core abstractions)
1. `WorkspaceMembershipService` - 27 edges
2. `StructuredLoggerService` - 24 edges
3. `DatabaseService` - 19 edges
4. `BRAYN` - 17 edges
5. `compilerOptions` - 14 edges
6. `BRAYN README` - 14 edges
7. `WorkspaceService` - 14 edges
8. `WorkspaceMembershipController` - 14 edges
9. `WorkspaceController` - 13 edges
10. `compilerOptions` - 12 edges

## Surprising Connections (you probably didn't know these)
- `AI Action Control` --semantically_similar_to--> `agent-browser SKILL (.agents)`  [INFERRED] [semantically similar]
  README.md → .agents/skills/agent-browser/SKILL.md
- `BRAYN` --references--> `BRAYN (README)`  [INFERRED]
  CLAUDE.md → README.md
- `pnpm Workspace Config` --shares_data_with--> `BRAYN Monorepo Structure`  [INFERRED]
  pnpm-workspace.yaml → README.md
- `agent-browser SKILL (.agents)` --conceptually_related_to--> `agent-browser SKILL (.claude)`  [INFERRED]
  .agents/skills/agent-browser/SKILL.md → .claude/skills/agent-browser/SKILL.md
- `agent-browser SKILL (.claude)` --references--> `agent-browser Observability Dashboard`  [EXTRACTED]
  .claude/skills/agent-browser/SKILL.md → .agents/skills/agent-browser/SKILL.md

## Hyperedges (group relationships)
- **Shared Customer Intelligence Foundation** — brayn_unified_customer_intelligence_record, brayn_customer_intelligence_view, brayn_customer_activity_history, brayn_customer_risk_engagement_state, brayn_revenue_opportunity_detector, brayn_merchant_knowledge_policy_store, brayn_merchant_business_analyst, brayn_ai_action_control, brayn_business_action_automation [EXTRACTED 1.00]
- **AI Action Governance Flow** — brayn_ai_action_control, brayn_business_action_automation, brayn_principle_permission_aware_actions [EXTRACTED 1.00]

## Communities (73 total, 10 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.06
Nodes (26): UpdateWorkspaceInput, updateWorkspaceSchema, id(), timestamps(), workspaceId(), workspaces, RequireWorkspaceRole(), membershipService (+18 more)

### Community 1 - "Community 1"
Cohesion: 0.04
Nodes (48): completed_at, created_at, key, status, name, notNull, primaryKey, type (+40 more)

### Community 2 - "Community 2"
Cohesion: 0.05
Nodes (46): name, notNull, primaryKey, type, clerk_user_id, created_at, id, name (+38 more)

### Community 3 - "Community 3"
Cohesion: 0.07
Nodes (18): createWidgetSchema, WidgetController, ZodValidationPipe, CreateWorkspaceInput, createWorkspaceSchema, AllExceptionsFilter, ErrorResponseBody, body (+10 more)

### Community 4 - "Community 4"
Cohesion: 0.05
Nodes (39): dialect, enums, id, _meta, columns, schemas, tables, policies (+31 more)

### Community 5 - "Community 5"
Cohesion: 0.05
Nodes (40): name, notNull, primaryKey, type, clerk_user_id, created_at, id, name (+32 more)

### Community 6 - "Community 6"
Cohesion: 0.05
Nodes (36): dependencies, @clerk/backend, drizzle-orm, fastify, @nestjs/common, @nestjs/config, @nestjs/core, @nestjs/event-emitter (+28 more)

### Community 7 - "Community 7"
Cohesion: 0.09
Nodes (9): DatabaseService, IdempotencyModule, IdempotencyService, chain, client, service, idempotencyKeys, AppController (+1 more)

### Community 8 - "Community 8"
Cohesion: 0.07
Nodes (26): dependencies, clsx, next, react, react-dom, tailwind-merge, zod, devDependencies (+18 more)

### Community 9 - "Community 9"
Cohesion: 0.07
Nodes (27): completed_at, key, status, name, notNull, primaryKey, type, name (+19 more)

### Community 10 - "Community 10"
Cohesion: 0.08
Nodes (25): dependencies, zod, devDependencies, eslint, eslint-config-prettier, prettier, turbo, @types/node (+17 more)

### Community 11 - "Community 11"
Cohesion: 0.13
Nodes (25): Agent Browser, Architecture Discipline (Rule 8), Authority (Rule 1), Before Coding (Rule 4), BRAYN, Caveman, Claude-Mem, Claude Responsibility (Rule 2) (+17 more)

### Community 12 - "Community 12"
Cohesion: 0.13
Nodes (11): AiModule, AutomationModule, ConversationModule, CustomerIntelligenceModule, DatabaseModule, IdentityResolutionModule, IntegrationModule, IntelligenceEnginesModule (+3 more)

### Community 13 - "Community 13"
Cohesion: 0.17
Nodes (12): createEvent(), CreateEventInput, DomainEvent, EventBus, app, bus, event, listener (+4 more)

### Community 14 - "Community 14"
Cohesion: 0.16
Nodes (19): agent-browser Observability Dashboard, agent-browser SKILL (.agents), agent-browser SKILL (.claude), AI Action Control, Business Action Automation, Customer Activity History, Customer Intelligence View, Customer Risk & Engagement State (+11 more)

### Community 15 - "Community 15"
Cohesion: 0.16
Nodes (5): AuthGuard, ProtectedController, Public(), ProviderError, DependencyStatus

### Community 16 - "Community 16"
Cohesion: 0.12
Nodes (16): compilerOptions, allowJs, declaration, incremental, jsx, lib, module, moduleResolution (+8 more)

### Community 17 - "Community 17"
Cohesion: 0.12
Nodes (17): completed_at, key, status, name, notNull, primaryKey, type, name (+9 more)

### Community 18 - "Community 18"
Cohesion: 0.12
Nodes (17): workspace_memberships_user_id_users_id_fk, workspace_memberships_workspace_id_workspaces_id_fk, foreignKeys, columnsFrom, columnsTo, name, onDelete, onUpdate (+9 more)

### Community 19 - "Community 19"
Cohesion: 0.12
Nodes (15): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, lib, module, moduleResolution (+7 more)

### Community 20 - "Community 20"
Cohesion: 0.12
Nodes (15): dialect, enums, id, _meta, columns, schemas, tables, policies (+7 more)

### Community 21 - "Community 21"
Cohesion: 0.13
Nodes (14): compilerOptions, declaration, emitDecoratorMetadata, experimentalDecorators, lib, module, moduleResolution, noUncheckedIndexedAccess (+6 more)

### Community 22 - "Community 22"
Cohesion: 0.24
Nodes (11): chain, client, created, deleteChain, makeChain(), members, membership, rows (+3 more)

### Community 23 - "Community 23"
Cohesion: 0.13
Nodes (14): dialect, enums, id, _meta, columns, schemas, tables, policies (+6 more)

### Community 24 - "Community 24"
Cohesion: 0.21
Nodes (6): config, originalEnv, Env, envSchema, REQUIRED_IN_PRODUCTION, logger

### Community 25 - "Community 25"
Cohesion: 0.22
Nodes (4): UpdateMemberRoleInput, updateMemberRoleSchema, userService, WorkspaceMembershipController

### Community 26 - "Community 26"
Cohesion: 0.26
Nodes (3): users, UserController, UserService

### Community 27 - "Community 27"
Cohesion: 0.14
Nodes (13): aliases, components, utils, rsc, $schema, style, tailwind, baseColor (+5 more)

### Community 28 - "Community 28"
Cohesion: 0.21
Nodes (8): RequestContext, RequestContextStore, storage, Level, LogLine, logger, parsed, spy

### Community 29 - "Community 29"
Cohesion: 0.24
Nodes (3): membershipService, userService, WorkspaceMembershipService

### Community 30 - "Community 30"
Cohesion: 0.24
Nodes (6): AddMemberInput, addMemberSchema, WorkspaceRole, workspaceRoles, workspaceMemberships, membershipService

### Community 31 - "Community 31"
Cohesion: 0.17
Nodes (11): dependsOn, outputs, cache, persistent, $schema, tasks, build, dev (+3 more)

### Community 32 - "Community 32"
Cohesion: 0.29
Nodes (7): loadConfiguration(), warnOnMissingProductionSecrets(), registerHttpLogging(), adapter, PingController, initSentry(), bootstrap()

### Community 33 - "Community 33"
Cohesion: 0.18
Nodes (9): client, created, existing, initialSelect, insertChain, raceSelect, selectChain, service (+1 more)

### Community 34 - "Community 34"
Cohesion: 0.18
Nodes (11): checkConstraints, compositePrimaryKeys, foreignKeys, indexes, isRLSEnabled, name, policies, schema (+3 more)

### Community 35 - "Community 35"
Cohesion: 0.18
Nodes (10): dialect, enums, id, policies, prevId, roles, schemas, sequences (+2 more)

### Community 36 - "Community 36"
Cohesion: 0.20
Nodes (10): checkConstraints, compositePrimaryKeys, foreignKeys, indexes, isRLSEnabled, name, policies, schema (+2 more)

### Community 37 - "Community 37"
Cohesion: 0.20
Nodes (10): checkConstraints, compositePrimaryKeys, foreignKeys, indexes, isRLSEnabled, name, policies, schema (+2 more)

### Community 39 - "Community 39"
Cohesion: 0.22
Nodes (9): checkConstraints, compositePrimaryKeys, foreignKeys, indexes, isRLSEnabled, name, policies, schema (+1 more)

### Community 40 - "Community 40"
Cohesion: 0.22
Nodes (9): checkConstraints, compositePrimaryKeys, isRLSEnabled, name, policies, schema, uniqueConstraints, tables (+1 more)

### Community 41 - "Community 41"
Cohesion: 0.25
Nodes (7): computedHash, skillPath, source, sourceType, skills, agent-browser, version

### Community 42 - "Community 42"
Cohesion: 0.25
Nodes (8): workspace_memberships_workspace_user_unique, indexes, columns, concurrently, isUnique, method, name, with

### Community 43 - "Community 43"
Cohesion: 0.43
Nodes (5): RetryOptions, sleep(), fn, promise, withRetry()

### Community 44 - "Community 44"
Cohesion: 0.29
Nodes (6): collection, compilerOptions, deleteOutDir, tsConfigPath, $schema, sourceRoot

### Community 45 - "Community 45"
Cohesion: 0.33
Nodes (6): completed_at, name, notNull, primaryKey, type, columns

### Community 46 - "Community 46"
Cohesion: 0.33
Nodes (6): created_at, default, name, notNull, primaryKey, type

### Community 47 - "Community 47"
Cohesion: 0.33
Nodes (6): id, default, name, notNull, primaryKey, type

### Community 48 - "Community 48"
Cohesion: 0.33
Nodes (6): status, default, name, notNull, primaryKey, type

### Community 49 - "Community 49"
Cohesion: 0.33
Nodes (6): updated_at, default, name, notNull, primaryKey, type

### Community 50 - "Community 50"
Cohesion: 0.33
Nodes (6): name, name, notNull, primaryKey, type, columns

### Community 51 - "Community 51"
Cohesion: 0.60
Nodes (3): dialect, entries, version

### Community 52 - "Community 52"
Cohesion: 0.40
Nodes (5): key, name, notNull, primaryKey, type

### Community 53 - "Community 53"
Cohesion: 0.40
Nodes (5): uniqueConstraints, users_clerk_user_id_unique, columns, name, nullsNotDistinct

### Community 54 - "Community 54"
Cohesion: 0.40
Nodes (4): printWidth, semi, singleQuote, trailingComma

### Community 55 - "Community 55"
Cohesion: 0.50
Nodes (4): _meta, columns, schemas, tables

## Knowledge Gaps
- **530 isolated node(s):** `Obsidian`, `Ponytail`, `Agent Browser`, `pr-review-toolkit`, `BRAYN (README)` (+525 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **10 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `WorkspaceController` connect `Community 0` to `Community 26`, `Community 3`, `Community 30`, `Community 15`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **Why does `WorkspaceMembershipService` connect `Community 29` to `Community 0`, `Community 22`, `Community 25`, `Community 26`, `Community 30`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **Why does `WorkspaceModule` connect `Community 0` to `Community 26`, `Community 12`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **What connects `Obsidian`, `Claude Responsibility (Rule 2)`, `Ponytail` to the rest of the system?**
  _534 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.06298701298701298 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.04081632653061224 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.04734299516908213 - nodes in this community are weakly interconnected._