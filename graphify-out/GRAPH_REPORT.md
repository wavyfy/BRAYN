# Graph Report - .  (2026-08-31)

## Corpus Check
- Corpus is ~12,515 words - fits in a single context window. You may not need a graph.

## Summary
- 618 nodes · 790 edges · 43 communities (34 shown, 9 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 16 edges (avg confidence: 0.84)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Workspace API Validation Layer|Workspace API Validation Layer]]
- [[_COMMUNITY_Async Events & Logging|Async Events & Logging]]
- [[_COMMUNITY_Auth Guard & Domain Modules|Auth Guard & Domain Modules]]
- [[_COMMUNITY_Backend Dependencies|Backend Dependencies]]
- [[_COMMUNITY_Migration Snapshot 0002|Migration Snapshot 0002]]
- [[_COMMUNITY_Idempotency & DB Tests|Idempotency & DB Tests]]
- [[_COMMUNITY_Workspace Domain Entity|Workspace Domain Entity]]
- [[_COMMUNITY_Frontend Dependencies|Frontend Dependencies]]
- [[_COMMUNITY_Migration Snapshot 0001|Migration Snapshot 0001]]
- [[_COMMUNITY_Dev Tooling Dependencies|Dev Tooling Dependencies]]
- [[_COMMUNITY_BRAYN Claude Code Rules|BRAYN Claude Code Rules]]
- [[_COMMUNITY_Idempotency Key Columns|Idempotency Key Columns]]
- [[_COMMUNITY_Idempotency Key Columns (dup)|Idempotency Key Columns (dup)]]
- [[_COMMUNITY_Skills & Domain Concepts Doc|Skills & Domain Concepts Doc]]
- [[_COMMUNITY_Workspace Table Columns|Workspace Table Columns]]
- [[_COMMUNITY_Base TS Compiler Config|Base TS Compiler Config]]
- [[_COMMUNITY_Migration Snapshot 0000 (pgvector)|Migration Snapshot 0000 (pgvector)]]
- [[_COMMUNITY_Backend TS Config|Backend TS Config]]
- [[_COMMUNITY_Backend Build TS Config|Backend Build TS Config]]
- [[_COMMUNITY_Frontend shadcn Components Config|Frontend shadcn Components Config]]
- [[_COMMUNITY_Turbo Pipeline Config|Turbo Pipeline Config]]
- [[_COMMUNITY_Skills Lock Manifest|Skills Lock Manifest]]
- [[_COMMUNITY_Retry-with-Backoff Utility|Retry-with-Backoff Utility]]
- [[_COMMUNITY_Nest CLI Config|Nest CLI Config]]
- [[_COMMUNITY_Prettier Config|Prettier Config]]
- [[_COMMUNITY_Drizzle Migration Journal|Drizzle Migration Journal]]
- [[_COMMUNITY_TS Build Excludes|TS Build Excludes]]
- [[_COMMUNITY_Claude Settings Hooks|Claude Settings Hooks]]
- [[_COMMUNITY_Frontend Root Layout|Frontend Root Layout]]
- [[_COMMUNITY_Frontend Env Schema|Frontend Env Schema]]
- [[_COMMUNITY_Async Operation Ref Type|Async Operation Ref Type]]
- [[_COMMUNITY_Cursor Pagination Type|Cursor Pagination Type]]
- [[_COMMUNITY_Next.js Config|Next.js Config]]
- [[_COMMUNITY_Tailwind Config|Tailwind Config]]
- [[_COMMUNITY_pnpm Workspace Config|pnpm Workspace Config]]

## God Nodes (most connected - your core abstractions)
1. `StructuredLoggerService` - 24 edges
2. `DatabaseService` - 19 edges
3. `BRAYN` - 17 edges
4. `compilerOptions` - 14 edges
5. `BRAYN README` - 14 edges
6. `compilerOptions` - 12 edges
7. `compilerOptions` - 11 edges
8. `public.idempotency_keys` - 11 edges
9. `public.idempotency_keys` - 11 edges
10. `public.workspaces` - 11 edges

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

## Communities (43 total, 9 thin omitted)

### Community 0 - "Workspace API Validation Layer"
Cohesion: 0.06
Nodes (20): createWidgetSchema, WidgetController, ZodValidationPipe, ProtectedController, Public(), AllExceptionsFilter, ErrorResponseBody, body (+12 more)

### Community 1 - "Async Events & Logging"
Cohesion: 0.07
Nodes (25): createEvent(), CreateEventInput, DomainEvent, EventBus, app, bus, event, listener (+17 more)

### Community 2 - "Auth Guard & Domain Modules"
Cohesion: 0.08
Nodes (21): AiModule, AuthGuard, AutomationModule, loadConfiguration(), config, originalEnv, Env, envSchema (+13 more)

### Community 3 - "Backend Dependencies"
Cohesion: 0.05
Nodes (36): dependencies, @clerk/backend, drizzle-orm, fastify, @nestjs/common, @nestjs/config, @nestjs/core, @nestjs/event-emitter (+28 more)

### Community 4 - "Migration Snapshot 0002"
Cohesion: 0.06
Nodes (35): dialect, enums, id, _meta, columns, schemas, tables, policies (+27 more)

### Community 5 - "Idempotency & DB Tests"
Cohesion: 0.09
Nodes (9): DatabaseService, IdempotencyModule, IdempotencyService, chain, client, service, idempotencyKeys, AppController (+1 more)

### Community 6 - "Workspace Domain Entity"
Cohesion: 0.10
Nodes (14): CreateWorkspaceInput, createWorkspaceSchema, id(), timestamps(), workspaces, workspaceService, WorkspaceController, WorkspaceModule (+6 more)

### Community 7 - "Frontend Dependencies"
Cohesion: 0.07
Nodes (26): dependencies, clsx, next, react, react-dom, tailwind-merge, zod, devDependencies (+18 more)

### Community 8 - "Migration Snapshot 0001"
Cohesion: 0.08
Nodes (25): dialect, enums, id, _meta, columns, schemas, tables, policies (+17 more)

### Community 9 - "Dev Tooling Dependencies"
Cohesion: 0.08
Nodes (25): dependencies, zod, devDependencies, eslint, eslint-config-prettier, prettier, turbo, @types/node (+17 more)

### Community 10 - "BRAYN Claude Code Rules"
Cohesion: 0.13
Nodes (25): Agent Browser, Architecture Discipline (Rule 8), Authority (Rule 1), Before Coding (Rule 4), BRAYN, Caveman, Claude-Mem, Claude Responsibility (Rule 2) (+17 more)

### Community 11 - "Idempotency Key Columns"
Cohesion: 0.09
Nodes (23): completed_at, created_at, key, status, name, notNull, primaryKey, type (+15 more)

### Community 12 - "Idempotency Key Columns (dup)"
Cohesion: 0.09
Nodes (23): completed_at, created_at, key, status, name, notNull, primaryKey, type (+15 more)

### Community 13 - "Skills & Domain Concepts Doc"
Cohesion: 0.16
Nodes (19): agent-browser Observability Dashboard, agent-browser SKILL (.agents), agent-browser SKILL (.claude), AI Action Control, Business Action Automation, Customer Activity History, Customer Intelligence View, Customer Risk & Engagement State (+11 more)

### Community 14 - "Workspace Table Columns"
Cohesion: 0.11
Nodes (18): id, name, updated_at, default, name, notNull, primaryKey, type (+10 more)

### Community 15 - "Base TS Compiler Config"
Cohesion: 0.12
Nodes (16): compilerOptions, allowJs, declaration, incremental, jsx, lib, module, moduleResolution (+8 more)

### Community 16 - "Migration Snapshot 0000 (pgvector)"
Cohesion: 0.12
Nodes (15): dialect, enums, id, _meta, columns, schemas, tables, policies (+7 more)

### Community 17 - "Backend TS Config"
Cohesion: 0.12
Nodes (15): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, lib, module, moduleResolution (+7 more)

### Community 18 - "Backend Build TS Config"
Cohesion: 0.13
Nodes (14): compilerOptions, declaration, emitDecoratorMetadata, experimentalDecorators, lib, module, moduleResolution, noUncheckedIndexedAccess (+6 more)

### Community 19 - "Frontend shadcn Components Config"
Cohesion: 0.14
Nodes (13): aliases, components, utils, rsc, $schema, style, tailwind, baseColor (+5 more)

### Community 20 - "Turbo Pipeline Config"
Cohesion: 0.17
Nodes (11): dependsOn, outputs, cache, persistent, $schema, tasks, build, dev (+3 more)

### Community 21 - "Skills Lock Manifest"
Cohesion: 0.25
Nodes (7): computedHash, skillPath, source, sourceType, skills, agent-browser, version

### Community 22 - "Retry-with-Backoff Utility"
Cohesion: 0.43
Nodes (5): RetryOptions, sleep(), fn, promise, withRetry()

### Community 23 - "Nest CLI Config"
Cohesion: 0.29
Nodes (6): collection, compilerOptions, deleteOutDir, tsConfigPath, $schema, sourceRoot

### Community 24 - "Prettier Config"
Cohesion: 0.40
Nodes (4): printWidth, semi, singleQuote, trailingComma

### Community 25 - "Drizzle Migration Journal"
Cohesion: 0.50
Nodes (3): dialect, entries, version

## Knowledge Gaps
- **323 isolated node(s):** `Obsidian`, `Ponytail`, `Agent Browser`, `pr-review-toolkit`, `BRAYN (README)` (+318 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `StructuredLoggerService` connect `Async Events & Logging` to `Workspace API Validation Layer`, `Auth Guard & Domain Modules`, `Workspace Domain Entity`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **Why does `DatabaseService` connect `Idempotency & DB Tests` to `Workspace API Validation Layer`, `Auth Guard & Domain Modules`, `Workspace Domain Entity`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **Why does `columns` connect `Workspace Table Columns` to `Idempotency Key Columns (dup)`, `Migration Snapshot 0002`?**
  _High betweenness centrality (0.007) - this node is a cross-community bridge._
- **What connects `Obsidian`, `Claude Responsibility (Rule 2)`, `Ponytail` to the rest of the system?**
  _327 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Workspace API Validation Layer` be split into smaller, more focused modules?**
  _Cohesion score 0.05731523378582202 - nodes in this community are weakly interconnected._
- **Should `Async Events & Logging` be split into smaller, more focused modules?**
  _Cohesion score 0.07142857142857142 - nodes in this community are weakly interconnected._
- **Should `Auth Guard & Domain Modules` be split into smaller, more focused modules?**
  _Cohesion score 0.08130081300813008 - nodes in this community are weakly interconnected._