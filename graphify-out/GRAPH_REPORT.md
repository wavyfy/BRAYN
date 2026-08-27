# Graph Report - .  (2026-08-27)

## Corpus Check
- Corpus is ~1,160 words - fits in a single context window. You may not need a graph.

## Summary
- 25 nodes · 40 edges · 5 communities (4 shown, 1 thin omitted)
- Extraction: 75% EXTRACTED · 25% INFERRED · 0% AMBIGUOUS · INFERRED: 10 edges (avg confidence: 0.84)
- Token cost: 56,739 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Scope & Responsibility|Scope & Responsibility]]
- [[_COMMUNITY_Boundary-Enforcing Skills|Boundary-Enforcing Skills]]
- [[_COMMUNITY_Context & Retrieval Tools|Context & Retrieval Tools]]
- [[_COMMUNITY_Delivery & Reporting Loop|Delivery & Reporting Loop]]
- [[_COMMUNITY_Ambiguity Handling|Ambiguity Handling]]

## God Nodes (most connected - your core abstractions)
1. `BRAYN` - 17 edges
2. `Skill Instruction Separation` - 7 edges
3. `Authority (Rule 1)` - 6 edges
4. `Graphify` - 4 edges
5. `Context Efficiency (Rule 5)` - 4 edges
6. `Part-by-Part Implementation (Rule 3)` - 3 edges
7. `Before Coding (Rule 4)` - 3 edges
8. `Scope Control (Rule 6)` - 3 edges
9. `Existing Code & Reuse (Rule 7)` - 3 edges
10. `Security (Rule 9)` - 3 edges

## Surprising Connections (you probably didn't know these)
- `BRAYN (README)` --references--> `BRAYN`  [INFERRED]
  README.md → CLAUDE.md

## Hyperedges (group relationships)
- **Skill Instructions Kept Separate From CLAUDE.md** — claudemd_graphify, claudemd_caveman, claudemd_ponytail, claudemd_agent_browser, claudemd_pr_review_toolkit, claudemd_security [EXTRACTED 1.00]

## Communities (5 total, 1 thin omitted)

### Community 0 - "Scope & Responsibility"
Cohesion: 0.43
Nodes (7): Before Coding (Rule 4), BRAYN, Claude Responsibility (Rule 2), Existing Code & Reuse (Rule 7), Human Approval (Rule 15), Scope Control (Rule 6), BRAYN (README)

### Community 1 - "Boundary-Enforcing Skills"
Cohesion: 0.33
Nodes (6): Agent Browser, Architecture Discipline (Rule 8), Ponytail, pr-review-toolkit, Security (Rule 9), Skill Instruction Separation

### Community 2 - "Context & Retrieval Tools"
Cohesion: 0.40
Nodes (6): Authority (Rule 1), Caveman, Claude-Mem, Context Efficiency (Rule 5), Graphify, Obsidian

### Community 3 - "Delivery & Reporting Loop"
Cohesion: 0.50
Nodes (4): Completion Report (Rule 14), Part-by-Part Implementation (Rule 3), Result-Driven Development (Rule 13), Testing & Verification (Rule 10)

## Knowledge Gaps
- **5 isolated node(s):** `Obsidian`, `Ponytail`, `Agent Browser`, `pr-review-toolkit`, `BRAYN (README)`
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `BRAYN` connect `Scope & Responsibility` to `Boundary-Enforcing Skills`, `Context & Retrieval Tools`, `Delivery & Reporting Loop`, `Ambiguity Handling`?**
  _High betweenness centrality (0.734) - this node is a cross-community bridge._
- **Why does `Skill Instruction Separation` connect `Boundary-Enforcing Skills` to `Scope & Responsibility`, `Context & Retrieval Tools`?**
  _High betweenness centrality (0.286) - this node is a cross-community bridge._
- **Why does `Authority (Rule 1)` connect `Context & Retrieval Tools` to `Scope & Responsibility`, `Ambiguity Handling`?**
  _High betweenness centrality (0.142) - this node is a cross-community bridge._
- **What connects `Obsidian`, `Claude Responsibility (Rule 2)`, `Ponytail` to the rest of the system?**
  _6 weakly-connected nodes found - possible documentation gaps or missing edges._