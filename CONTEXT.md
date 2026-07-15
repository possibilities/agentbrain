# Research-index consolidation glossary

- **Ingress** — The human-facing entry into the saved-link flow. Botctl is the ingress in this architecture.
- **Producer** — A component that emits work or a completed artifact for the next component. Scrapectl is the producer of completed-link payloads consumed by Agentbrain.
- **Queue owner** — The component responsible for queued job lifecycle, retries, and queue state. Scrapectl owns the scrape queue; Agentbrain has no queue.
- **Extractor** — The component that turns an admitted URL into clean content and structured metadata, including browser-backed work. Scrapectl is the extractor.
- **Index owner** — The only component authorized to create/migrate the research schema and read or mutate indexed documents, chunks, FTS rows, and relations. Agentbrain is the index owner.
- **Completed-link payload** — One JSON object containing required `url` and non-empty `markdown`, plus optional `structured`, `source`, title/category/tags, summary/notes, and preset metadata. It represents an already-extracted root.
- **Root/child relation** — The durable `document_links` provenance from a committed X tweet/article root to one outbound destination. Agentbrain attempts at most one child hop, using pinned safe fetch for external HTTP(S) and the narrowly validated Scrapectl browser exception only for canonical X items, then stores either a target document or a retryable failure.
- **Compatibility adapter** — The temporary `research-ingest-link` executable that accepts the completed-link payload but returns Scrapectl's legacy bare JSON fields and exit codes instead of Agentbrain's normal envelope.

The accepted ownership decision and tradeoffs are recorded in [ADR 0001](docs/adr/0001-agentbrain-owns-research-index.md).
