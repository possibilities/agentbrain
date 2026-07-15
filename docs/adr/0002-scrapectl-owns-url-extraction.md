# ADR 0002: Scrapectl owns URL extraction

- Status: Accepted
- Date: 2026-07-15

## Context

The human corrected the extraction boundary after ADR 0001. Agentbrain is the research-index and ingestion owner, but implementing URL fetching inside Agentbrain couples the index to web/network scraping responsibilities that belong in Scrapectl.

Local text, file, directory, PDF, DOCX, and EPUB parsing remains Agentbrain ingestion. URL fetching and extraction is different: it includes network transport, browser/session behavior, DNS and redirect handling, backend security and retries, and extraction hardening.

A temporarily missing CLI or unavailable Scrapectl backend must not abandon an in-flight Agentbrain URL ingestion. That requirement does not move backend knowledge or ownership into Agentbrain: Agentbrain only classifies the command result and invokes the same provider command again.

## Decision

- **Scrapectl is the sole URL extractor/backend.** It owns every URL fetch, browser/session behavior, DNS/redirect/backend security, backend retries, and extraction.
- **Agentbrain treats Scrapectl as one provider.** Generic URL ingestion and every one-hop child discovered from a completed X root invoke PATH-resolved `scrapectl fetch-markdown --markdown URL` with explicit argv, no shell, a bounded per-attempt timeout/output, bounded non-empty Markdown, and sanitized errors. Scrapectl selects extraction presets and renders final Markdown; Agentbrain does not parse or render provider schemas. There is no fallback.
- **Transient provider-command availability is retried.** Agentbrain re-resolves PATH and retries indefinitely in production only when the executable is absent/ENOENT, Scrapectl reports its upstream/browser backend down or unavailable, a connection is refused/reset/unreachable, or Agentbrain's bounded provider attempt times out. Retry uses bounded exponential backoff. Delay overrides are bounded to 100..3,600,000 milliseconds; tests inject sleep and an attempt cap.
- **Permanent failures stop.** Authentication required, invalid input, empty successful output, and content/output limits fail rather than loop. Agentbrain does not write the attempted URL document.
- **Cancellation stays cancellation.** Agentbrain does not convert process termination or Ctrl-C into a retry class.
- **URL identity stays local and stable.** Direct and child ingestion index the normalized requested/canonical URL, not provider-internal metadata; titles come from explicit input or final Markdown.
- **Completed-link roots are pre-scraped.** Agentbrain indexes supplied root Markdown without a provider call for the root. Already-supplied structured root data may still drive root metadata and one-hop link discovery.
- **One-hop children use one route.** Generic completed roots commit without child fan-out. Every discovered child from a completed X root uses the same Scrapectl adapter, whether external or X. Fan-out remains capped at 25, and child ingestion never recurses.
- **Agentbrain keeps syntactic URL helpers only.** It may normalize/canonicalize HTTP(S) strings for payload validation, stable URL identities, and X tweet/article source identities.
- **Local document parsing remains Agentbrain-owned ingestion.** This includes pasted text, files, directories, local PDFs via `pdftotext`, DOCX, and EPUB.

## Consequences

- The research index still has one owner, as decided in ADR 0001.
- Backend hardening and residual browser/network risk are tracked in Scrapectl, not Agentbrain code, docs, or tests.
- Normal Agentbrain tests use injected scrape functions or fake PATH executables and never require a real backend or network.
- The optional real-provider smoke is outside `test`/`check` and uses a temporary database: `./scripts/smoke-scrapectl-url-ingest.sh [https://example.com/]`.
- Source identities remain stable: completed X roots use `tweet`/`tweet_article`, completed generic roots use `scraped_url`, and generic URL ingestion emits `url_pdf` for requested `.pdf` URLs or `url` otherwise. Legacy `url_text` rows remain readable.

## Related

This refines the extraction implementation detail in [ADR 0001](0001-agentbrain-owns-research-index.md) without changing its still-valid index-ownership decision.
