# CLAUDE.md

# BRAYN — Claude Code Rules

## 1. Authority

BRAYN documentation in Obsidian is the canonical source of truth for:

- Product scope
- Architecture
- Domain boundaries
- Locked decisions
- Functional requirements

Use Graphify, Claude-Mem, Caveman, and other tooling as context/retrieval aids only, not as authoritative sources.

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

- Production deployment
- Production configuration
- Production secrets
- Production database operations
- Infrastructure decisions
- Major architecture changes
- Product/architecture decisions that require human approval

Git/GitHub operations must follow the user's explicit workflow and approval requirements.

---

## 3. Part-by-Part Implementation

Implement BRAYN incrementally.

Never implement an entire domain/module when only one implementation part is requested.

Each implementation part must follow:

```text
Goal
↓
Relevant Context
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

Do not automatically:

- Continue to the next part
- Start another implementation
- Perform unrelated cleanup
- Run Graphify maintenance
- Commit or push changes
- Perform speculative work

Wait for the user's next instruction.

---

## 4. Before Coding

Before significant implementation:

1. Identify the current implementation part.
2. Read the relevant BRAYN documentation.
3. Inspect the existing code relevant to the part.
4. Check for reusable existing code.
5. Use available context/retrieval tools only when they materially help understand the relevant code or history.
6. Create a concise implementation plan.
7. Implement only the planned scope.

Do not perform unrelated refactoring.

Do not read the entire repository or all documentation unless the task genuinely requires it.

---

## 5. Context Efficiency

Context tools exist to reduce unnecessary reading, not to create additional work.

### General Principle

**Discover broadly, read narrowly.**

Use:

```text
Relevant context discovery
↓
Identify relevant files
↓
Read only required files
↓
Implement
```

Do not repeatedly reload the entire repository or every BRAYN document.

### Claude-Mem / Caveman

Use Claude-Mem and Caveman when prior implementation context, decisions, or previous work is genuinely required.

Do not repeatedly reload the same context when it is already available in the current session.

Do not use historical context to override canonical BRAYN documentation.

### Graphify

Graphify is a **repository context/knowledge-graph tool**, not part of the implementation or verification pipeline.

Graphify may be used when:

- Repository structure is difficult to understand.
- Relationships between files/modules need to be discovered.
- The relevant implementation area is unclear.
- The user explicitly asks to update/analyze Graphify.

Graphify must **NOT** be automatically run:

- At every session start
- After every implementation part
- After significant code changes
- Before every next part
- As part of tests
- As part of verification
- Merely because files changed
- Merely to keep the graph "fresh"

### Graphify Updates

**Do not run `graphify update .` automatically.**

The user controls Graphify maintenance.

Only run Graphify update/rebuild commands when:

1. The user explicitly requests it, or
2. The user explicitly asks for project-context/graph maintenance.

When explicitly requested:

- Run the requested command.
- Let Graphify perform its own processing.
- Do not manually analyze/rebuild the graph.
- Do not inspect thousands of nodes/edges unless the user specifically asks for graph analysis.
- Report the result briefly.
- Return to the user's requested task.

Graphify output is a context/indexing artifact and must not become an implementation task itself.

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
- Introduce infrastructure before it is required.

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

Do not create a new abstraction merely because it appears theoretically cleaner.

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

If the implementation appears to require an architectural change:

**STOP and ask before changing it.**

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
- Disable security controls merely to make development/testing easier

Security boundaries must not be weakened without explicit approval.

---

## 10. Testing & Verification

Testing is part of implementation.

Do not report an implementation as complete based only on compilation.

Where applicable:

```text
Implementation
↓
Relevant Tests
↓
Type / Static Checks
↓
Integration / E2E Verification
↓
Browser Verification
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
- Never remove tests simply to make the suite pass.

Use browser verification for applicable UI/user flows.

The result must be observable through one or more appropriate mechanisms:

- UI behaviour
- API behaviour
- Database behaviour
- Job/event behaviour
- Integration behaviour
- Automated test evidence

The result does not need to be UI-based.

### Verification Efficiency

Use the smallest verification set that provides sufficient confidence.

Do not:

- Repeatedly run expensive checks without a reason.
- Rebuild unchanged code unnecessarily.
- Restart healthy servers unnecessarily.
- Run a full suite when targeted tests are sufficient and the change is isolated.
- Run expensive build processes alongside conflicting development processes.

Run broader verification when the changed surface or risk justifies it.

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
- Work around a security/authorization failure without understanding its cause

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

When an external provider's behaviour matters, verify it from the provider's actual documentation or controlled testing rather than assuming.

---

## 13. Real Provider / Real Data Verification

Mock tests and real-provider verification are separate things.

For ecommerce integrations such as Shopify and WooCommerce:

### Automated verification

Use:

- Unit tests
- Mock provider responses
- Controlled fixtures
- Integration tests

These verify application behaviour and provider-contract handling.

### Real-provider acceptance

When the provider implementation reaches an appropriate functional milestone, perform a separate real-provider acceptance test using:

- Development/test store
- Dedicated test credentials
- Non-production data

Never use production credentials unnecessarily.

Never expose or commit provider secrets.

Real-provider acceptance should verify, where applicable:

- Authentication/connection
- Credential verification
- Real API requests
- Real customer/product/order data
- Pagination
- Initial import
- Webhook delivery
- Webhook verification
- Incremental synchronization
- Retry/error handling
- Reconciliation

Do not claim "fully end-to-end verified" based only on mocks.

Clearly distinguish:

```text
Mock / automated verification
        ↓
Local application verification
        ↓
Real provider verification
        ↓
Real-provider acceptance
```

The user decides when real-provider acceptance testing should be performed.

---

## 14. Result-Driven Development

Every implementation part must end with a clear observable result.

Prefer implementation slices where progress can be verified immediately.

Example:

```text
Feature
↓
Working code
↓
Observable/testable result
↓
Verification
```

Do not spend an entire implementation part building invisible infrastructure without a clear verification method.

If invisible infrastructure is necessary, define how it will be verified before implementing it.

---

## 15. UI Principles

BRAYN UI should be:

- Minimal
- Clean
- Readable
- Professional
- Consistent
- Functional

**Minimal does not mean unstyled or bare.**

Do not reduce UI to raw HTML or excessively plain layouts merely to satisfy "minimal".

Use clear:

- Visual hierarchy
- Spacing
- Typography
- Form structure
- Buttons
- Cards/sections where appropriate
- Loading states
- Error states
- Empty states
- Destructive-action confirmation

Reuse the existing UI primitives and visual language.

Do not introduce a design-system dependency unless explicitly approved.

Preserve existing functionality, API contracts, and data behaviour when improving presentation.

---

## 16. Database

Database changes must follow the project's migration workflow.

Never:

- Modify production data
- Delete data merely to make tests pass
- Bypass migration tooling
- Commit credentials
- Introduce destructive migrations without approval

Use the configured development database for development verification.

If test/development data is created or modified, report it when relevant.

Schema changes must include appropriate migration and verification.

---

## 17. Server & Process Discipline

Avoid unnecessary process churn.

Do not:

- Start duplicate dev servers
- Run conflicting build/dev processes sharing the same cache
- Restart healthy servers unnecessarily
- Leave unnecessary temporary processes running
- Repeatedly spawn processes when an existing healthy process can be reused

If a port/process/cache conflict occurs:

1. Identify the cause.
2. Resolve the existing conflict.
3. Continue with the clean process.

Do not create additional processes as a workaround.

---

## 18. Dependencies & Infrastructure

Do not introduce a new dependency when existing project/runtime functionality can reasonably solve the problem.

Do not introduce:

- Queues
- Workers
- Schedulers
- External services
- Infrastructure
- Background-job systems

speculatively.

Follow existing project decisions and explicitly deferred decisions.

Prefer the smallest implementation that satisfies the current part.

---

## 19. Git / GitHub

Follow the user's explicit Git workflow.

Unless explicitly requested:

- Do not commit.
- Do not push.
- Do not create pull requests.
- Do not rewrite history.
- Do not amend existing commits.
- Do not reset/delete user work.

Before a requested commit:

- Confirm the intended scope.
- Ensure unrelated changes are not included.
- Ensure secrets/generated local state are excluded.

Keep commits scoped to the completed implementation part whenever practical.

---

## 20. Documentation & Project Context

Do not rewrite or regenerate project documentation after every code change.

Update documentation when:

- The implementation changes an existing documented decision.
- A new architectural decision has been explicitly approved.
- The current task explicitly requires documentation.
- Existing implementation documentation would otherwise become materially incorrect.

Do not silently change canonical architecture documentation to match implementation.

If documentation appears outdated or contradictory:

- Report it.
- Explain the conflict.
- Ask for approval before changing canonical decisions.

---

## 21. Human Approval

Stop and request approval when:

- Architecture must change.
- Product scope must change.
- A locked BRAYN decision must change.
- A new external technology/provider is required.
- A destructive data operation is required.
- A security boundary must change.
- Requirements materially conflict.
- A provider integration requires an architectural decision not covered by the existing design.
- The correct implementation cannot be determined from available context.

Do not make these decisions silently.

---

## 22. Completion Report

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
<type/static/integration/E2E/browser checks actually performed>

ISSUES:
<known limitations or blockers>

STATUS:
VERIFIED / BLOCKED
```

Only report `VERIFIED` when the required checks actually pass.

Do not include unnecessary internal process details.

Do not report Graphify maintenance as part of implementation verification unless Graphify itself was explicitly the task.

---

## 23. Final Execution Rule

The default BRAYN workflow is:

```text
Understand
↓
Retrieve only relevant context
↓
Plan
↓
Implement one part
↓
Test
↓
Verify
↓
Report
↓
STOP
```

Do not turn supporting tools into mandatory steps.

Supporting tools exist to make implementation faster and more reliable, not to become additional work.

**The implementation is the task.**
**Graphify, Claude-Mem, Caveman, browser tooling, and other skills are supporting tools.**

Use them when useful.
Do not use them merely because they are available.

````

### The important correction

The biggest change is this:

**Old behavior:**

```text
Start session
→ Graphify
→ code
→ Graphify update
→ code
→ Graphify update
→ next part
→ Graphify
````

**New behavior:**

```text
Start session
→ relevant context
→ code
→ tests
→ verification
→ STOP
```

Graphify becomes:

```text
Need repository relationship/context?
        ↓
Use Graphify if useful
        ↓
Read relevant files
        ↓
Continue
```

And **`graphify update .` is explicitly user-controlled**.
