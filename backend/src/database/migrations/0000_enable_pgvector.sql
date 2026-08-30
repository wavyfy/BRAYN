-- Enables pgvector for AI/semantic retrieval (doc 29 §10, §16 — PostgreSQL
-- + pgvector, no separate vector database in Phase 1). Domain-neutral:
-- foundational setup, not owned by any single domain.
CREATE EXTENSION IF NOT EXISTS vector;
