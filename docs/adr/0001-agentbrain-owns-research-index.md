# ADR 0001: Agentbrain owns the research index

- Status: Accepted
- Date: 2026-07-14

## Context

The saved-research path previously split schema and write behavior across Hermes plugins while Agentbrain only read the resulting SQLite database. Consolidation needs one owner without replacing the existing human-ingress, queue, admission, or browser systems.

## Decision

The accepted boundary is:

- **Botctl is human ingress.** It is where a person initiates a saved-link flow.
- **Linkctl owns admission and duplicate policy.** It decides which links enter the pipeline and how duplicate submissions are handled.
- **Scrapectl owns its queue and extraction.** It performs browser-backed scraping and emits completed-link payloads.
- **Agentbrain is the sole index owner.** It owns schema-v2 creation and migration, generic and completed-link writes, FTS/relation maintenance, deletion, and every public index read.
- **Agentbrain has no queue and no browser implementation.** External one-hop children use Agentbrain's DNS-vetted, socket-pinned HTTP(S) transport. For compatibility with existing X behavior, only canonical X status/article children may execute PATH-resolved Scrapectl, after public-address preflight and with same-canonical-item postvalidation.
- **The first cutover keeps the legacy database path** at `~/.hermes/research-cache/research.db`. This avoids an unrelated state move during ownership transfer.
- **The compatibility alias/adapter is temporary.** `research-ingest-link` preserves Scrapectl's bare-JSON fields and exit codes while the normal `agentbrain ingest-link` command uses Agentbrain's envelope. The installer may deliberately replace only the known legacy Hermes symlink or links it already owns.
- **There is no archive backfill in this change.** Existing schema-compatible records remain in place; dormant watchers and historical archives are not replayed.

## Consequences and tradeoffs

- Schema evolution and write invariants now have one implementation and one test suite.
- Read commands remain structurally read-only even though the same CLI exposes explicit mutation commands through a separate store.
- Keeping the old path reduces cutover risk but leaves a historical `.hermes` name until a separately authorized state migration.
- One-hop X child extraction preserves useful link provenance but keeps a narrow runtime dependency on Scrapectl and can produce root-first partial success. This browser exception has residual network risk: Agentbrain cannot pin or inspect Scrapectl's browser socket, so preflight and canonical postvalidation mitigate but do not eliminate browser/DNS rebinding risk.
- Durable failed relations make retries observable and idempotent; shared child identities reuse documents.
- The temporary adapter creates a small duplicate entrypoint surface, accepted to avoid breaking Scrapectl during cutover.
- No archive backfill means the change does not improve or reinterpret historical coverage.

## Related

See [`CONTEXT.md`](../../CONTEXT.md) for the shared glossary and [`README.md`](../../README.md) for commands.
