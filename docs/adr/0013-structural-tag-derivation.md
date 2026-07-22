# ADR 0013: Structural tag derivation and the `retag` mutation

- Status: Accepted
- Date: 2026-07-22

## Context

Every one of the 581 documents recovered by the legacy corpus import (ADR 0010) carries only the single hardcoded `legacy-recovery` tag. That tag records provenance, not content: it says nothing about whether a document is code, video, a social post, or where it came from, so tag-filtered search and browsing over the recovered corpus are effectively unusable.

The obvious next step — LLM-driven topical tagging — needs a model call per document, a cost and latency budget, and a judgment call about vocabulary that is out of scope here. A narrower, deterministic pass is available first: `source_type`, the document's URL domain, and its collection membership already carry enough signal to assign a small, curated set of structural labels (`code`, `video`, `social`, `github`, …) with no inference and no external call.

This needs a mutation surface, since 581 existing documents already have final `documents.tags` and `chunks_fts.tags` state that must change in place. `chunks_fts` is a regular (non-contentless) fts5 table, so a bare `UPDATE ... SET tags=?` on an indexed column silently corrupts the index — every indexed column must be supplied, which in practice means delete-and-reinsert per chunk.

## Decision

- **Structural tags are deterministic and narrow.** They are derived only from `source_type`, canonicalized URL domain (host, minus `www.`/`m.` prefixes), and collection slugs — never from document content or an LLM. The vocabulary is a small curated set of lowercase, dot-free labels (`src/tagging.ts`); dot-free is required because the `unicode61` tokenizer backing `chunks_fts` splits on `.`, so a dotted tag like `youtube.com` would never match as one token.
- **Derivation always preserves existing tags.** `deriveStructuralTags` unions its structural output with a document's current tags, so `legacy-recovery` and any operator-supplied `--tag` survive every retag, including future ones as the curated vocabulary grows.
- **The write is targeted and FTS-synced, not a re-chunk.** `ResearchStore.retagDocument` recomputes only `documents.tags` and `chunks_fts.tags` inside one transaction per changed document, using fts5 delete+reinsert for every chunk (mirroring `deleteDocument`'s targeted idiom) rather than a partial-column UPDATE. A document whose derived tags already match its stored tags is a no-op — no write, no FTS churn — which is what makes repeated `retag` runs byte-identical.
- **`retag` is a new audited mutation CLI command, not automatic.** It iterates every document by id (never by `source_uri`, since duplicate `source_uri` values are possible), applies `retagDocument`, and reports a JSON envelope with documents scanned/changed/unchanged and a per-document before/after tag diff. `--dry-run` computes and reports the identical diff and counts through read-only queries, performing no write.
- **Audit is envelope-only.** The mutation is accountable through its stable JSON envelope (`read_only:false`, per-document diffs) the same way `delete` is. No new audit table and no schema-version bump: this is a DATA-only change over the existing `documents`/`chunks_fts` columns.

## Consequences

- The recovered corpus becomes filterable and searchable by structural tag (`code`, `video`, `social`, `github`, …) without waiting on topical/LLM tagging.
- The curated tag vocabulary is centralized in one module (`src/tagging.ts`) and is intentionally lean; extending it (new domains, new source types) is additive and re-running `retag` picks up new tags idempotently.
- LLM/topical tagging remains explicitly out of scope for a later epic; `retag` only ever produces structural labels.
- Every `retag` invocation is independently auditable from its JSON envelope alone; no separate audit table exists to fall out of sync with the mutation.

## Related

This builds on the recovered corpus described in [ADR 0010](0010-legacy-recovery-import-contract.md) and reuses `deleteDocument`'s targeted-FTS-write idiom from the durable ingestion domain model in [ADR 0003](0003-agentbrain-owns-durable-ingestion.md). See [`CONTEXT.md`](../../CONTEXT.md) for the Structural tag glossary entry, disambiguated from Sensitivity and the user-supplied `--tag`.
