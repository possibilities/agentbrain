# Agentbrain ingestion glossary

- **Ingress** — The actor or interface that submits ingestion intent, such as Agentbot, a CLI user, an importer, or a source run. Avoid using *source* for the submitter.
- **Admission** — The synchronous boundary that validates intent and either rejects it or durably creates or identifies an ingestion job. Accepted admission does not imply extraction or indexing success.
- **Ingestion** — The durable lifecycle from submitted intent through materialization and indexing or an inspectable terminal disposition. Extraction is one possible stage of ingestion, not a synonym for it.
- **Ingestion job** — One immutable, durable intent to ingest or reconcile an item. A retry does not replace the job; it adds an attempt.
- **Attempt** — One leased execution of an ingestion job, including its timing, outcome, and failure classification. Avoid using *run* for a job attempt.
- **Run** — A source synchronization or import batch that groups jobs and owns batch-level progress or checkpoints.
- **Resource** — One logical item with a stable identity independent of its current content, discovery path, or indexed representation.
- **Resource key** — A typed, stable identity derived from a trustworthy provider identifier or conservative local normalization. Avoid using artifact digests, titles, or historical list positions as resource keys.
- **Alias** — An observed alternate locator for a resource, carrying its role and evidence without independently proving that two resources should merge.
- **Document** — The current searchable representation of a resource in Agentbrain's index.
- **Artifact** — An immutable captured or derived representation observed at a particular time, such as imported Markdown or extracted content. A content digest identifies artifact bytes, not the resource itself.
- **Artifact store** — The content-addressed filesystem that holds immutable artifact bytes while SQLite records their typed metadata and references.
- **Source** — A recurring producer or discovery definition, such as a blog feed, X account, or filesystem root. Avoid using *source* for ingress or a legacy provenance label.
- **Collection** — A many-to-many curation and policy grouping independent of how its resources were discovered.
- **Sensitivity** — Inherited handling policy for a resource and every derived artifact, document, chunk, preview, export, or later embedding. It is not a search tag.
- **Observation** — Evidence that a source or ingress encountered a resource during a run or job.
- **Suppressed observation** — A discovered item intentionally not admitted as a child job, with a durable policy or limit reason rather than silent omission.
- **Checkpoint** — A source-specific high-water mark committed only after the corresponding discovered intents are durable; it is distinct from an in-progress pagination cursor.
- **Provenance** — Typed evidence connecting ingress, sources, runs, jobs, resources, artifacts, and relations; preserved raw historical metadata may accompany that evidence.
- **Relation** — A typed resource-to-resource edge, such as a content link, citation, reply, or version relationship.
- **Saved link** — A resource submitted through human ingress for membership in the saved-links collection; it is not a separate resource type.
- **Recovery evidence** — A provenance record reconstructed from historical catalogs, artifacts, or metadata. Evidence may identify a candidate resource without approving content ingestion.
- **Ingestion ledger** — Agentbrain's durable record of jobs, attempts, runs, state transitions, and operator dispositions. Its runnable jobs form the ingestion queue.
- **Worker** — The Agentbrain process that leases jobs, delegates materialization, and commits fenced outcomes. A worker is an executor, not a source or ingress.
- **URL extractor/backend** — The component that turns a URL into bounded extracted output and owns fetching, browser/session behavior, network security, redirects, and provider-specific parsing. Scrapectl is the only URL extractor/backend.
- **Extraction envelope** — A versioned, provider-neutral result or classified failure returned by an extractor to an ingestion worker. Avoid persisting provider-specific response schemas as Agentbrain domain data.
- **Index owner** — The only component authorized to create or migrate the schema and mutate resources, documents, chunks, FTS rows, ingestion state, and provenance. Agentbrain is the index owner.

The current ownership decision is recorded in [ADR 0003](docs/adr/0003-agentbrain-owns-durable-ingestion.md). [ADR 0002](docs/adr/0002-scrapectl-owns-url-extraction.md) records the retained URL-extraction boundary; the original consolidation decision is preserved under [superseded ADR 0001](docs/adr/superseded/0001-agentbrain-owns-research-index.md).
