# BRAYN

**BRAYN** is an AI-native customer intelligence and business action platform for modern commerce businesses.

It turns fragmented customer, commerce, behavioral, communication, and business knowledge into a unified intelligence layer that helps businesses **understand customers, identify opportunities, make better decisions, and safely take action**.

## Core

BRAYN is built around a shared customer intelligence foundation:

* **Unified Customer Intelligence Record** — canonical customer intelligence and context
* **Customer Intelligence View** — unified merchant-facing customer view
* **Customer Activity History** — chronological customer activity and interactions
* **Customer Risk & Engagement State** — customer engagement and risk intelligence
* **Revenue Opportunity Detector** — identifies actionable revenue opportunities
* **Merchant Knowledge & Policy Store** — business knowledge and policies used by AI
* **Merchant Business Analyst** — AI interface for business analysis and decisions
* **AI Action Control** — controls what AI can execute and what requires approval
* **Business Action Automation** — executes approved business actions and workflows

All major capabilities consume the same underlying customer intelligence rather than maintaining separate customer representations.

## Architecture Principles

* **Customer intelligence is centralized**
* **Backend and frontend are independently structured**
* **Event-driven processing where appropriate**
* **AI operates through controlled tools and services**
* **Tenant isolation is enforced throughout the platform**
* **Actions are permission-aware and auditable**
* **Business logic remains deterministic where possible; AI enhances reasoning and decision-making**
* **Production-oriented design without premature complexity**

## Monorepo Structure

```text
/
├── backend/        # APIs, business logic, AI, integrations, workers
├── frontend/       # Web application and merchant experience
├── docs/            # Canonical product and engineering documentation
├── .claude/         # Claude Code project configuration and workflows
├── CLAUDE.md         # Repository-level engineering instructions
└── README.md         # Project overview
```

## Development

BRAYN is developed as a monorepo with clearly separated frontend and backend responsibilities.

Each application owns its relevant implementation, tests, and development concerns. Shared architectural and product decisions are maintained in `docs/`.

### Working Principles

1. Understand the existing architecture before implementing.
2. Build one implementation part at a time.
3. Keep changes focused and reviewable.
4. Prefer simple, maintainable solutions over unnecessary abstraction.
5. Protect tenant boundaries and AI permissions at every layer.
6. Add risk-appropriate tests for production-critical behavior.
7. Keep documentation aligned with meaningful architectural decisions.

## Documentation

The `docs/` directory contains the canonical BRAYN product, architecture, and engineering documentation.

> **BRAYN is the product.**
> WAPon is a communication/WhatsApp platform layer used by BRAYN and is not the core intelligence product.
