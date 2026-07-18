# ADR 0003: Agentbrain owns durable ingestion

- Status: Accepted
- Date: 2026-07-18

## Context

The first research-index consolidation made Agentbrain the sole index writer while leaving saved-link admission in Linkctl and durable scrape work in Scrapectl. That boundary optimized for a compatibility cutover, but it cannot provide one inspectable lifecycle for every kind of ingestion. Synchronous text and file writes bypass durable intent, X child extraction is coupled to a root invocation, and future imports, recurring sources, and non-URL inputs need the same recovery and operator semantics.

A durable queue tied only to scraping would also make URL work first-class while leaving local files, imported artifacts, and later typed connectors with different reliability. Conversely, moving web extraction into Agentbrain would violate the established security and provider boundary.

## Decision

- **Agentbrain owns the durable ingestion ledger and remains the sole index writer.** Every public ingestion path persists an ingestion job before extraction, parsing, or indexing begins.
- **Jobs and attempts are distinct.** A job is immutable intent; each leased execution appends an attempt. Execution is at least once, with idempotent effects and fenced completion rather than an exactly-once claim.
- **Runs group batch work.** Imports and source synchronizations create runs that group jobs and own batch progress or checkpoints; a run is not a job attempt.
- **The durable data model separates resources, documents, artifacts, sources, collections, observations, and provenance.** Resource identity is independent of current indexed content, immutable artifact bytes, acquisition source, and collection membership.
- **Agentbrain workers delegate every URL extraction to Scrapectl.** Scrapectl remains the sole owner of network transport, browser/session behavior, URL security, redirects, provider-specific schemas, and extracted output. Agentbrain persists intent, invokes the bounded provider contract, validates its result, and owns retry scheduling and operator disposition.
- **Local and imported content use the same queue.** Text, files, directories, approved recovery artifacts, and later typed connectors enter through durable jobs even when no Scrapectl call is required.
- **Derived work is durable.** When an extracted resource produces outbound resources, Agentbrain commits the parent result, provenance edges, and child jobs transactionally. Child failure does not roll back the parent and remains independently inspectable.
- **Agentbot submits saved links to Agentbrain.** Saved-link intent becomes collection membership and provenance in Agentbrain rather than a separate Linkctl catalog write.
- **Linkctl is retired after cutover and reconciliation.** No runtime compatibility shim is required. The ordered legacy catalog, exact submitted URLs, artifacts, hashes, historical identifiers, and `source=linkctl` provenance remain preserved as recovery data.
- **Scrapectl's existing YAML queue is no longer authoritative for Agentbrain ingestion after migration.** Existing pending and failed work is drained, imported, or explicitly dispositioned before its Agentbrain handoff is retired. Standalone Scrapectl behavior does not authorize a second Agentbrain ingestion queue.
- **Operator disposition is part of ingestion.** Jobs and attempts remain queryable across pending, active, retry-delayed, blocked, failed, completed, excluded, and cancelled outcomes; retry and disposition actions append durable audit evidence.
- **The existing database location remains unchanged.** Relocating `~/.hermes/research-cache/research.db` is a separate decision.
- **Future agentic-search, software-docset, and chat connectors are out of scope.** Their future inputs must use the same typed job, resource, artifact, and provenance concepts rather than introduce parallel ingestion paths.

## Consequences

- A submitted ingestion remains visible even when extraction, parsing, indexing, or a dependency fails.
- Queue state and index state share one authority, enabling transactional parent fan-out, source checkpoints, resource writes, and job finalization where all affected state is local to SQLite.
- External extraction cannot run inside a database write transaction; workers must use short claims and fenced, idempotent completion around Scrapectl calls.
- Artifact files and SQLite cannot be committed atomically, so content-addressed storage, reconciliation, and backup coverage are required.
- Agentbrain gains worker lifecycle, retry, lease, inspection, and repair responsibilities while retaining its prohibition on direct web transport.
- Scrapectl's provider retry advice and extraction errors become inputs to Agentbrain's durable retry policy rather than an independent Agentbrain-targeted queue lifecycle.
- The Agentbot and Scrapectl cross-process contracts require versioned structured envelopes and coordinated rollout.
- Removing Linkctl simplifies the steady-state path but requires explicit corpus preservation, queue reconciliation, installation cleanup, and cutover evidence.

## Related

This ADR supersedes [ADR 0001](superseded/0001-agentbrain-owns-research-index.md). It retains Scrapectl's sole-extractor decision from [ADR 0002](0002-scrapectl-owns-url-extraction.md) while superseding that ADR's synchronous provider-retry and X-child lifecycle details. See [`CONTEXT.md`](../../CONTEXT.md) for the canonical vocabulary.
