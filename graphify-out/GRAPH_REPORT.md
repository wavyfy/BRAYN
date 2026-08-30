# Graph Report - .  (2026-08-29)

## Corpus Check
- 0 files · ~99,999 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 115 nodes · 132 edges · 11 communities (10 shown, 1 thin omitted)
- Extraction: 89% EXTRACTED · 11% INFERRED · 0% AMBIGUOUS · INFERRED: 15 edges (avg confidence: 0.84)
- Token cost: 60,661 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_BRAYN Claude Rules|BRAYN Claude Rules]]
- [[_COMMUNITY_Package Manifest|Package Manifest]]
- [[_COMMUNITY_TS Base Config|TS Base Config]]
- [[_COMMUNITY_BRAYN Product Domain|BRAYN Product Domain]]
- [[_COMMUNITY_Turbo Pipeline|Turbo Pipeline]]
- [[_COMMUNITY_Dev Dependencies|Dev Dependencies]]
- [[_COMMUNITY_Skills Lock|Skills Lock]]
- [[_COMMUNITY_Prettier Config|Prettier Config]]
- [[_COMMUNITY_Agent-Browser Skill|Agent-Browser Skill]]
- [[_COMMUNITY_Claude Settings Hooks|Claude Settings Hooks]]

## God Nodes (most connected - your core abstractions)
1. `BRAYN` - 17 edges
2. `compilerOptions` - 14 edges
3. `BRAYN README` - 14 edges
4. `scripts` - 8 edges
5. `Skill Instruction Separation` - 7 edges
6. `Unified Customer Intelligence Record` - 7 edges
7. `Authority (Rule 1)` - 6 edges
8. `tasks` - 6 edges
9. `agent-browser` - 5 edges
10. `Graphify` - 4 edges

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

## Communities (11 total, 1 thin omitted)

### Community 0 - "BRAYN Claude Rules"
Cohesion: 0.13
Nodes (25): Agent Browser, Architecture Discipline (Rule 8), Authority (Rule 1), Before Coding (Rule 4), BRAYN, Caveman, Claude-Mem, Claude Responsibility (Rule 2) (+17 more)

### Community 1 - "Package Manifest"
Cohesion: 0.12
Nodes (16): dependencies, zod, engines, node, name, packageManager, private, scripts (+8 more)

### Community 2 - "TS Base Config"
Cohesion: 0.12
Nodes (15): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, lib, module, moduleResolution (+7 more)

### Community 3 - "BRAYN Product Domain"
Cohesion: 0.20
Nodes (16): AI Action Control, Business Action Automation, Customer Activity History, Customer Intelligence View, Customer Risk & Engagement State, Merchant Business Analyst, Merchant Knowledge & Policy Store, BRAYN Monorepo Structure (+8 more)

### Community 4 - "Turbo Pipeline"
Cohesion: 0.17
Nodes (11): dependsOn, outputs, cache, persistent, $schema, tasks, build, dev (+3 more)

### Community 5 - "Dev Dependencies"
Cohesion: 0.22
Nodes (9): devDependencies, eslint, eslint-config-prettier, prettier, turbo, @types/node, typescript, typescript-eslint (+1 more)

### Community 6 - "Skills Lock"
Cohesion: 0.25
Nodes (7): computedHash, skillPath, source, sourceType, skills, agent-browser, version

### Community 7 - "Prettier Config"
Cohesion: 0.40
Nodes (4): printWidth, semi, singleQuote, trailingComma

### Community 8 - "Agent-Browser Skill"
Cohesion: 1.00
Nodes (3): agent-browser Observability Dashboard, agent-browser SKILL (.agents), agent-browser SKILL (.claude)

## Knowledge Gaps
- **59 isolated node(s):** `Obsidian`, `Ponytail`, `Agent Browser`, `pr-review-toolkit`, `BRAYN (README)` (+54 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `devDependencies` connect `Dev Dependencies` to `Package Manifest`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **What connects `Obsidian`, `Claude Responsibility (Rule 2)`, `Ponytail` to the rest of the system?**
  _63 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `BRAYN Claude Rules` be split into smaller, more focused modules?**
  _Cohesion score 0.13333333333333333 - nodes in this community are weakly interconnected._
- **Should `Package Manifest` be split into smaller, more focused modules?**
  _Cohesion score 0.11764705882352941 - nodes in this community are weakly interconnected._
- **Should `TS Base Config` be split into smaller, more focused modules?**
  _Cohesion score 0.125 - nodes in this community are weakly interconnected._