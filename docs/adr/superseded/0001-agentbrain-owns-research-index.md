# ADR 0001: Agentbrain owns the research index

- Status: Superseded by ADR 0003; URL-extraction detail refined by ADR 0002
- Date: 2026-07-14

## Context

The saved-research path previously split schema and write behavior across Hermes plugins while Agentbrain only read the resulting SQLite database. Consolidation needs one owner without replacing the existing human-ingress, queue, admission, or browser systems.

## Decision

The accepted boundary is:

- **Agentbot is human ingress.** It is where a person initiates a saved-link flow.
- **Linkctl owns admission and duplicate policy.** It decides which links enter the pipeline and how duplicate submissions are handled.
- **Agentscrape owns its queue and extraction.** It performs browser-backed scraping and emits completed-link payloads.
- **Agentbrain is the sole index owner.** It owns schema-v2 creation and migration, generic and completed-link writes, FTS/relation maintenance, deletion, and every public index read.
- **Agentbrain has no queue and no browser implementation.** This index-ownership decision remains accepted. Its original implementation detail about Agentbrain-owned URL child transport has been refined and superseded by ADR 0002: Agentscrape owns all URL extraction, and Agentbrain only retries transient provider-command availability before indexing completed output.
- **The first cutover keeps the legacy database path** at `~/.hermes/research-cache/research.db`. This avoids an unrelated state move during ownership transfer.
- **The compatibility alias/adapter is temporary.** `research-ingest-link` preserves Agentscrape's bare-JSON fields and exit codes while the normal `agentbrain ingest-link` command uses Agentbrain's envelope. The installer may deliberately replace only the known legacy Hermes symlink or links it already owns.
- **There is no archive backfill in this change.** Existing schema-compatible records remain in place; dormant watchers and historical archives are not replayed.

## Consequences and tradeoffs

- Schema evolution and write invariants now have one implementation and one test suite.
- Read commands remain structurally read-only even though the same CLI exposes explicit mutation commands through a separate store.
- Keeping the old path reduces cutover risk but leaves a historical `.hermes` name until a separately authorized state migration.
- One-hop child extraction preserves useful link provenance and can produce root-first partial success. ADR 0002 moves all URL network/browser/backend hardening responsibility to Agentscrape; Agentbrain retains only syntactic URL identity helpers and transient provider-command retry.
- Durable failed relations make retries observable and idempotent; shared child identities reuse documents.
- The temporary adapter creates a small duplicate entrypoint surface, accepted to avoid breaking Agentscrape during cutover.
- No archive backfill means the change does not improve or reinterpret historical coverage.

## Related

See [`CONTEXT.md`](../../../CONTEXT.md) for the shared glossary, [`README.md`](../../../README.md) for commands, [ADR 0002](../0002-agentscrape-owns-url-extraction.md) for the corrected URL-extraction boundary, and [ADR 0003](../0003-agentbrain-owns-durable-ingestion.md) for the superseding durable-ingestion decision.
