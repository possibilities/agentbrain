# ADR 0007: Synchronous Agentscrape extraction contract

- Status: Accepted
- Date: 2026-07-18

## Context

Agentbrain's generic ingestion ledger must be the durable authority for URL jobs, attempts, retries, operator dispositions, and derived child work. Agentscrape nevertheless remains the only component allowed to implement network fetching, browser/session behavior, URL security, redirects, and provider-specific extraction. Keeping both Agentbrain and Agentscrape queues in the same ingestion lifecycle would split authority and make failures, retries, and completion ambiguous.

The integration therefore needs a narrow synchronous wire contract: Agentbrain owns durable work before and after the call, while Agentscrape performs one bounded extraction without gaining authority over Agentbrain's queue or index.

## Decision

- **Agentbrain workers invoke Agentscrape synchronously through a versioned command contract.** Invocation uses a PATH-resolved executable, explicit argv, bounded runtime and output, cancellation propagation, and no shell evaluation.
- **Agentscrape returns the provider-neutral extraction envelope at schema version 1.** The envelope requires extractor identity `agentscrape` and retains the established keys, enums, requested and final URL evidence, bounded extracted content, typed artifact descriptors, normalized metadata, typed outbound relations, extractor/version information, and content digests.
- **Provider-specific response schemas remain inside Agentscrape.** Agentbrain validates the extraction envelope but does not recursively inspect, persist as domain state, or render provider payloads.
- **Failure envelopes use stable operational classes.** The contract distinguishes infrastructure-transient, item-transient, authentication/configuration, permanent-content, policy rejection, cancellation, and protocol defect outcomes while retaining bounded sanitized evidence.
- **Agentbrain owns durable retry scheduling.** Agentscrape supplies extraction behavior and classification evidence for one invocation; Agentbrain applies the job lifecycle and retry policy from ADR 0004.
- **Unknown or malformed envelope versions are protocol defects.** They do not fall back to Markdown scraping, provider-schema guessing, or unstructured success handling.
- **Promoted extraction records retain their established persistence version.** New records use `record_version: 1`, carry extractor identity `agentscrape`, and are accepted only after the Agentscrape schema-v1 live contract passes all URL, digest, path, size, and output-security validation.
- **Historical promoted records remain readable without mutation.** Existing `record_version: 1` records retain any bounded opaque extractor identity as provenance and pass the same artifact, URL, digest, path, size, and output-security checks. Reading them does not rewrite SQLite, Artifact bytes, or the record file.
- **Agentscrape cannot mutate Agentbrain ingestion.** Any standalone Agentscrape work remains operationally separate and cannot create, complete, or alter Agentbrain jobs or index state.
- **Every URL acquisition still crosses Agentscrape.** This contract does not authorize direct HTTP, DNS, browser, redirect, preset, or provider handling in Agentbrain.

## Consequences

- Agentbrain has one authoritative job and attempt history for URL and non-URL ingestion.
- Agentscrape can evolve provider implementations behind one versioned provider-neutral envelope.
- URL extraction happens outside SQLite write transactions and may execute more than once; fenced idempotent completion controls index effects.
- Cross-repository protocol fixtures and coordinated rollout are required.
- Persisted-record compatibility tests protect retry after promotion without turning historical extractor identities into live command aliases.
- Standalone extraction work remains operationally separate and must not be presented as Agentbrain queue state.

## Related

This applies [ADR 0003](0003-agentbrain-owns-durable-ingestion.md), uses the lifecycle in [ADR 0004](0004-durable-ingestion-job-lifecycle.md), and retains the sole-extractor boundary of [ADR 0002](0002-agentscrape-owns-url-extraction.md). See [`CONTEXT.md`](../../CONTEXT.md) for extraction-envelope terminology.
