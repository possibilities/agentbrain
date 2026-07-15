# Research-index consolidation glossary

- **Ingress** — The human-facing entry into the saved-link flow. Botctl is the ingress in this architecture.
- **Producer** — A component that emits work or a completed artifact for the next component. Scrapectl is the producer of completed-link payloads consumed by Agentbrain.
- **Queue owner** — The component responsible for queued job lifecycle, retries, and queue state. Scrapectl owns the scrape queue; Agentbrain has no queue.
- **URL extractor/backend** — The component that turns a URL into clean markdown and structured metadata, including all fetching, browser/session behavior, DNS/redirect/backend security, backend retries, and extraction hardening. Scrapectl is the only URL extractor/backend.
- **Provider-command retry** — Agentbrain's narrow responsibility to re-invoke Scrapectl with bounded exponential backoff when the CLI or its upstream/browser backend is transiently unavailable. It does not inspect, implement, or retry Scrapectl's backend internals; permanent provider/input/content failures stop immediately.
- **Local ingestion** — Agentbrain-owned parsing of pasted text, files, directories, local PDFs, DOCX, and EPUB. This is not web scraping.
- **Index owner** — The only component authorized to create/migrate the research schema and read or mutate indexed documents, chunks, FTS rows, and relations. Agentbrain is the index owner.
- **Completed-link payload** — One JSON object containing required `url` and non-empty `markdown`, plus optional `structured`, `source`, title/category/tags, summary/notes, and preset metadata. It represents an already-extracted root.
- **Root/child relation** — The durable `document_links` provenance from a committed completed X root to one outbound destination. Generic completed roots do not fan out. For X roots Agentbrain attempts at most one child hop; every child URL uses the same Scrapectl provider adapter, then Agentbrain stores either a target document or a retryable failure.
- **Compatibility adapter** — The temporary `research-ingest-link` executable that accepts the completed-link payload but returns Scrapectl's legacy bare JSON fields and exit codes instead of Agentbrain's normal envelope.

The accepted ownership decision and tradeoffs are recorded in [ADR 0001](docs/adr/0001-agentbrain-owns-research-index.md), with the corrected URL-extraction boundary in [ADR 0002](docs/adr/0002-scrapectl-owns-url-extraction.md).
