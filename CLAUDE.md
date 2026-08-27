# CLAUDE.md

# BRAYN — Claude Code Rules

## 1. Authority

BRAYN documentation in Obsidian is the canonical source of truth for:

- Product scope
- Architecture
- Domain boundaries
- Locked decisions
- Functional requirements

Use Graphify and Claude-Mem as context/retrieval aids, not as authoritative sources.

If sources conflict or a required decision is unclear:

- Do not guess.
- Do not silently change architecture.
- Explain the conflict.
- Ask for a decision.

---

## 2. Claude Responsibility

Claude is responsible for code-level implementation and local verification.

Claude may:

- Modify application code
- Create/update tests
- Run local tests and checks
- Debug implementation issues
- Perform local browser/UI verification
- Perform code review
- Update implementation documentation when required

Claude must not independently handle:

- Git/GitHub operations
- Production deployment
- Production configuration
- Production secrets
- Production database operations
- Infrastructure decisions
- Major architecture changes

---

## 3. Part-by-Part Implementation

Implement BRAYN incrementally.

Never implement an entire domain/module when only one implementation part is requested.

Each implementation part must have:

```text
Goal
↓
Plan
↓
Implementation
↓
Tests
↓
Verification
↓
Result
```

After the current part is verified:

**STOP.**

Do not automatically continue to the next part.

---

## 4. Before Coding

Before significant implementation:

1. Identify the current implementation part.
2. Read the relevant BRAYN documentation.
3. Inspect the existing code.
4. Use Graphify to understand the relevant project/file structure.
5. Identify reusable existing code.
6. Create a concise implementation plan.
7. Implement only the planned scope.

Do not perform unrelated refactoring.

---

## 5. Context Efficiency

### Session Start

At the beginning of every session:

- Activate/use Caveman.
- Load relevant Claude-Mem context.
- Use Graphify to understand the current repository structure.
- Identify only the documentation and source files relevant to the current task.

### Targeted Retrieval

Use:

```text
Graphify
↓
Identify relevant files
↓
Read only those files
↓
Implement
```

Do not repeatedly read the entire repository or every BRAYN document.

**Discover broadly, read narrowly.**

Read additional files only when their actual contents are required.

### Context Refresh

After a significant code change:

- Refresh/update Graphify.
- Use the updated Graphify context to identify affected files and relationships.

At reasonable session intervals:

- Re-check that Caveman is active.
- Use Claude-Mem when prior context is required.
- Avoid unnecessary context reloads.

Before starting the next major implementation part:

- Refresh relevant project context when the previous part materially changed the codebase.

---

## 6. Scope Control

Do not:

- Implement future milestones.
- Add unrequested features.
- Add unnecessary dependencies.
- Introduce speculative abstractions.
- Rewrite working code without reason.
- Perform unrelated cleanup.
- Change locked architecture decisions.

If additional work is discovered:

- Keep it outside the current scope.
- Report it.
- Continue only if it is required for the current implementation.

---

## 7. Existing Code & Reuse

Before creating new functionality, check whether existing code can be reused or extended.

Prefer:

- Existing abstractions
- Existing utilities
- Existing types
- Existing services
- Existing components
- Simple implementations

Avoid:

- Duplicate logic
- Duplicate types
- Duplicate utilities
- Unnecessary wrappers
- Premature abstractions
- Over-engineering

---

## 8. Architecture Discipline

Follow the approved BRAYN architecture.

Respect:

- Domain boundaries
- Service/module ownership
- Integration boundaries
- Workspace isolation
- Data ownership
- API boundaries
- Event/job boundaries
- AI tool boundaries

Provider-specific behaviour must remain behind integration boundaries.

Do not bypass established domain boundaries for convenience.

---

## 9. Security

Security is mandatory during implementation.

Always preserve:

- Authentication
- Authorization
- Workspace isolation
- Input validation
- Secure secret handling
- Sensitive-data protection
- AI Action Control
- Audit requirements

Never:

- Expose secrets
- Put secrets in source code
- Log sensitive credentials
- Bypass authorization
- Trust client-provided workspace IDs as the only isolation mechanism
- Give AI unrestricted database/application access

---

## 10. Testing & Verification

Testing is part of implementation.

Do not report an implementation as complete based only on compilation.

Where applicable:

```text
Implementation
↓
Tests
↓
Type / Static Checks
↓
Integration / E2E Verification
↓
Code Review
↓
Fix Failures
↓
Regression Check
↓
Verified
```

Claude must:

- Create/update relevant tests.
- Run relevant tests.
- Inspect failures.
- Fix failures within the current scope.
- Re-run verification.
- Never hide or weaken failing tests.

Use browser verification for applicable UI/user flows.

The result must be observable through:

- UI behaviour
- API behaviour
- Database behaviour
- Job/event behaviour
- Integration behaviour
- Automated test evidence

The result does not need to be UI-based.

---

## 11. Failure & Ambiguity

When implementation fails:

1. Identify the root cause.
2. Fix it if it belongs to the current scope.
3. Re-run verification.

When a failure requires an architectural or product decision:

**STOP and ask.**

Never:

- Hide failures
- Remove tests to make them pass
- Weaken requirements to make verification pass
- Claim success without evidence

---

## 12. No Guessing

Do not invent:

- Product requirements
- Architecture decisions
- Business rules
- Customer data
- Merchant policies
- API behaviour
- Integration behaviour
- AI capabilities

If information is unavailable or ambiguous:

**State the uncertainty and ask.**

---

## 13. Result-Driven Development

Every implementation part must end with a clear observable result.

Claude should prefer implementation slices where progress can be verified immediately.

Example:

```text
Feature
↓
Working code
↓
Visible/testable result
↓
Verification
```

Do not spend an entire implementation part building invisible infrastructure without a clear verification method.

---

## 14. Completion Report

After each implementation part, report briefly:

```text
PART:
<current implementation part>

RESULT:
<what now works>

CHANGED:
<important files/components>

TESTS:
<tests executed + result>

VERIFICATION:
<type/static/integration/E2E/browser checks>

ISSUES:
<known limitations or blockers>

STATUS:
VERIFIED / BLOCKED
```

Only report `VERIFIED` when the required checks actually pass.

---

## 15. Human Approval

Stop and request approval when:

- Architecture must change.
- Product scope must change.
- A locked BRAYN decision must change.
- A new external technology/provider is required.
- A destructive data operation is required.
- A security boundary must change.
- Requirements materially conflict.
- The correct implementation cannot be determined from the available context.

Do not make these decisions silently.

```
### One important thing

I intentionally **didn't put the individual skill instructions into this file**.

For example:

- Graphify → its own skill/tool instructions
- Caveman → its own instructions
- Ponytail → its own instructions
- Agent Browser → its own instructions
- Security guidance → its own instructions
- `pr-review-toolkit` → its own instructions

`CLAUDE.md` only defines **how Claude should behave while using them**.

This keeps the main rule file small and prevents duplicated/conflicting instructions.

**I would treat this as Draft v1**, not yet permanently locked. Next we should review whether any rule is missing or too restrictive, then we can move to the **implementation workflow**.
```
