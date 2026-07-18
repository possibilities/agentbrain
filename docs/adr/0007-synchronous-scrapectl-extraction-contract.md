# ADR 0007: Synchronous Scrapectl extraction contract

- Status: Accepted
- Date: 2026-07-18

## Context

Agentbrain's generic ingestion ledger must be the durable authority for URL jobs, attempts, retries, operator dispositions, and derived child work. Scrapectl nevertheless remains the only component allowed to implement network fetching, browser/session behavior, URL security, redirects, and provider-specific extraction. Keeping both Agentbrain and Scrapectl queues in the same ingestion lifecycle would split authority and make failures, retries, and completion ambiguous.

The current integration instead submits Agentbrain-targeted YAML jobs to Scrapectl, then calls the temporary `research-ingest-link` adapter with provider-shaped completed payloads. Successful jobs are deleted, child work is synchronous, and the queue cannot represent non-URL ingestion. A replacement must preserve the extraction boundary without preserving that queue topology.

## Decision

- **Agentbrain workers invoke Scrapectl synchronously through a versioned command contract.** Invocation uses a PATH-resolved executable, explicit argv, bounded runtime and output, cancellation propagation, and no shell evaluation.
- **Scrapectl returns a provider-neutral extraction envelope.** A successful envelope contains its schema version, requested and final URL evidence, bounded extracted content, typed artifact descriptors, normalized metadata, typed outbound relations, extractor/version information, timestamps, and content digests.
- **Provider-specific response schemas remain inside Scrapectl.** Agentbrain validates the extraction envelope but does not recursively inspect, persist as domain state, or render provider payloads.
- **Failure envelopes use stable operational classes.** The contract distinguishes infrastructure-transient, item-transient, authentication/configuration, permanent-content, policy rejection, cancellation, and protocol defect outcomes while retaining bounded sanitized evidence.
- **Agentbrain owns durable retry scheduling.** Scrapectl supplies extraction behavior and classification evidence for one invocation; Agentbrain applies the job lifecycle and retry policy from ADR 0004.
- **Unknown or malformed envelope versions are protocol defects.** They do not fall back to Markdown scraping, provider-schema guessing, or unstructured success handling.
- **Agentbrain-targeted Scrapectl queueing is retired.** New submissions are frozen during cutover; existing pending and failed YAML jobs are drained, imported into Agentbrain jobs, or explicitly dispositioned before the old handoff is removed.
- **The temporary indexing handoff is deleted after migration.** `research-ingest-link`, Agentbrain/research-cache indexer labels, and Agentbrain-specific queue-processor branches do not remain as compatibility paths.
- **The known failed legacy scrape is preserved.** The failed `codex-voice` job and its original destination/frontmatter evidence become a durable Agentbrain job requiring retry or operator disposition.
- **Standalone Scrapectl queueing may remain outside Agentbrain ingestion.** It may produce scrape-only artifacts for non-Agentbrain callers, but it cannot mutate, complete, or create Agentbrain ingestion state.
- **Every URL acquisition still crosses Scrapectl.** This contract does not authorize direct HTTP, DNS, browser, redirect, preset, or provider handling in Agentbrain.

## Consequences

- Agentbrain has one authoritative job and attempt history for URL and non-URL ingestion.
- Scrapectl can evolve provider implementations behind one versioned provider-neutral envelope.
- URL extraction happens outside SQLite write transactions and may execute more than once; fenced idempotent completion controls index effects.
- Cross-repository protocol fixtures and coordinated rollout are required.
- Removing the old queue handoff simplifies steady state but requires migration tests for pending, failed, malformed, and already-completed legacy jobs.
- Standalone scrape-only work remains operationally separate and must not be presented as Agentbrain queue state.

## Related

This applies [ADR 0003](0003-agentbrain-owns-durable-ingestion.md), uses the lifecycle in [ADR 0004](0004-durable-ingestion-job-lifecycle.md), and retains the sole-extractor boundary of [ADR 0002](0002-scrapectl-owns-url-extraction.md). See [`CONTEXT.md`](../../CONTEXT.md) for extraction-envelope terminology.
