# ADR 0002: Agentscrape owns URL extraction

- Status: Accepted; ingestion lifecycle refined by ADR 0003
- Date: 2026-07-15

## Context

The human corrected the extraction boundary after ADR 0001. Agentbrain is the research-index and ingestion owner, but implementing URL fetching inside Agentbrain couples the index to web/network scraping responsibilities that belong in Agentscrape.

Local text, file, directory, PDF, DOCX, and EPUB parsing remains Agentbrain ingestion. URL fetching and extraction is different: it includes network transport, browser/session behavior, DNS and redirect handling, backend security and retries, and extraction hardening.

A temporarily missing CLI or unavailable Agentscrape backend must not abandon an in-flight Agentbrain URL ingestion. That requirement does not move backend knowledge or ownership into Agentbrain: Agentbrain durably records the Attempt outcome and applies its own bounded retry policy around the same provider command.

## Decision

- **Agentscrape is the sole URL extractor/backend.** It owns every URL fetch, browser/session behavior, DNS/redirect/backend security, backend retries, and extraction.
- **Agentbrain treats Agentscrape as one provider.** URL workers invoke PATH-resolved `agentscrape fetch-markdown URL --envelope --allow-private-network --max-content-bytes N --max-relations N` with explicit argv, no shell, a bounded per-attempt timeout/output, bounded non-empty Markdown, and sanitized errors. `--allow-private-network` is the browser-egress consent Agentscrape requires for browser-backed live routes; the operator's durable admission of the URL is that consent. Agentscrape selects extraction backends and renders final Markdown; Agentbrain validates only the provider-neutral envelope. There is no fallback.
- **Transient provider-command availability is retried durably.** Agentbrain re-resolves PATH for each Attempt and records classified failures in its ingestion ledger. Retry uses bounded exponential backoff under the lifecycle policy in ADR 0004.
- **Permanent failures stop.** Authentication required, invalid input, empty successful output, and content/output limits fail rather than loop. Agentbrain does not write the attempted URL document.
- **Cancellation stays cancellation.** Agentbrain does not convert process termination or Ctrl-C into a retry class.
- **URL identity stays local and stable.** Direct and child ingestion index the normalized requested/canonical URL, not provider-internal metadata; titles come from explicit input or final Markdown.
- **Every admitted URL uses one route.** The Agentbrain Worker invokes the same Agentscrape envelope contract for root and derived URL jobs. Typed relations may admit bounded child jobs, and child ingestion never recurses beyond the configured fan-out boundary.
- **Agentbrain keeps syntactic URL helpers only.** It may normalize/canonicalize HTTP(S) strings for payload validation, stable URL identities, and X tweet/article source identities.
- **Local document parsing remains Agentbrain-owned ingestion.** This includes pasted text, files, directories, local PDFs via `pdftotext`, DOCX, and EPUB.

## Consequences

- The research index still has one owner, as decided in ADR 0001.
- Backend hardening and residual browser/network risk are tracked in Agentscrape, not Agentbrain code, docs, or tests.
- Normal Agentbrain tests use injected scrape functions or fake PATH executables and never require a real backend or network.
- The optional real-provider smoke is outside `test`/`check` and uses a temporary database: `./scripts/smoke-agentscrape-url-ingest.sh [https://example.com/]`.
- Source and Resource identities remain stable across extractor implementation changes because Agentbrain derives them from normalized requested and canonical URL evidence.

## Related

This refines the extraction implementation detail in [superseded ADR 0001](superseded/0001-agentbrain-owns-research-index.md). [ADR 0003](0003-agentbrain-owns-durable-ingestion.md) retains Agentscrape as the sole URL extractor while superseding this ADR's synchronous provider-retry and X-child lifecycle details.
