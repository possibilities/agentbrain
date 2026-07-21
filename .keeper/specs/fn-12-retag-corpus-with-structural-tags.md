## Overview

Every one of the 581 documents in the local research index carries only the placeholder `legacy-recovery` tag (hardcoded by the legacy corpus recovery intents). This epic adds a deterministic structural-tag derivation — from `source_type`, URL domain, and collection membership — and a new audited `retag` CLI command that applies it across the corpus, keeping `documents.tags` and the denormalized `chunks_fts.tags` in sync, idempotently, and always preserving `legacy-recovery`. Structural tags are a lean, curated set of dot-free lowercase labels (e.g. `code`, `video`, `social`, `github`). LLM/topical tagging is explicitly out of scope for a later epic.

## Quick commands

- `bun run check` — typecheck + biome lint + tests (repo root)
- `bun run src/cli.ts retag --dry-run --json --db <fixture.db>` — preview derived tags without writing
- After this lands, tag the real corpus: `agentbrain retag --dry-run` then `agentbrain retag` against `~/.hermes/research-cache/research.db`, then verify with `agentbrain tags --json`

## Acceptance

- [ ] A reusable deterministic derivation function produces curated structural tags from source_type + domain + collection, preserving `legacy-recovery` and any user tags.
- [ ] `agentbrain retag` (and `--dry-run`) applies them across all documents, idempotently, with `documents.tags` and `chunks_fts.tags` kept in sync.
- [ ] New tags are retrievable via the existing tags/search read path.
- [ ] The command is registered and documented on every CLI surface; CONTEXT.md, ADR 0013, and README updated.
- [ ] `bun run check` passes.

## Early proof point

Task that proves the approach: `.1` — the derivation function plus the targeted FTS-synced idempotent write. If it fails (the regular-fts5 partial-update trap corrupts the index, or re-runs aren't byte-identical), revisit the FTS refresh strategy — delete+reinsert vs all-column UPDATE — before building the CLI wrapper on top of it.

## References

- CONTEXT.md — ingestion glossary (Backfill, Sensitivity, Index owner; "Structural tag" to be added)
- docs/adr/0010-legacy-recovery-import-contract.md — ADR template and the legacy-recovery origin
- src/admission.ts:619-622,646-648 — where `legacy-recovery` is currently the sole hardcoded tag

## Docs gaps

- **CONTEXT.md**: add a "Structural tag" glossary entry, disambiguated from Sensitivity ("not a search tag") and the user-supplied `--tag`; leave the Backfill term unchanged (the command is `retag`, not "backfill").
- **README.md**: add a `retag` command-reference entry beside the Deletion section (the second guarded index-mutation surface).
- **docs/adr/0013-*.md**: new ADR recording the structural-tag derivation + `retag` mutation decision.

## Best practices

- **Regular fts5 tables reject partial-column UPDATE:** supply every indexed column or delete+reinsert the row — a bare `SET tags=?` silently corrupts the index. [SQLite FTS5 docs]
- **Keep derived tags dot-free:** the unicode61 tokenizer splits on `.`, so a domain-style tag like `youtube.com` wouldn't match as one token — use flat labels. [SQLite FTS5 docs]
- **Idempotent backfill:** re-derive deterministically and drive by explicit doc ids, never wall-clock; run-twice must be a no-op. [backfill patterns]
