# ADR 0012: Local security and sensitive ingestion

- Status: Accepted
- Date: 2026-07-18

## Context

Agentbrain is a local single-user system, but its durable jobs, exact provenance URLs, private recovery evidence, local files, future chat inputs, and extracted artifacts can contain sensitive data. Building a second authentication system for a user-local CLI would add complexity without protecting against the logged-in account, while treating all operational output as harmless would leak content and credentials into logs, notifications, terminals, or backups.

Sensitivity also propagates: a private source can produce artifacts, searchable documents, snippets, exports, and later embeddings. A tag applied only to the top-level resource would not provide a reliable handling boundary.

## Decision

- **The logged-in Unix account is the initial authorization boundary.** Agentbrain does not add a separate local authentication or role system.
- **Private state uses restrictive permissions.** Agentbrain state directories default to `0700`; databases, job payloads, artifacts, manifests, and private logs default to `0600`.
- **Credentials never become durable ingestion payload.** Jobs and source definitions store credential references only. Agentscrape or another provider resolves secrets through Keychain or its owned configuration at execution time.
- **Exact provenance is stored but not casually displayed.** Required exact URLs and historical evidence remain durable, while default logs, notifications, statistics, and job listings redact sensitive query values, headers, cookies, tokens, signed URLs, and content bodies.
- **Artifact inspection is explicit.** `jobs show` and related operator commands default to bounded safe metadata and sanitized diagnostics; reading raw or normalized artifact content requires an explicit content-revealing option.
- **Operator transitions are audited.** Retry, cancellation, exclusion, reopening, source pause, and sensitive inspection append actor, timestamp, reason, and affected identity evidence.
- **Transport privacy is not resource sensitivity.** Receiving a human-submitted public URL through a private DM or other private ingress does not by itself make the URL or resulting public resource sensitive. Message bodies, credentials, session material, and unnecessary chat identifiers remain private provenance; a sensitive locator, imported private content, explicit policy, or sensitive upstream derivation still raises the resource policy.
- **Sensitivity is inherited.** A resource and all derived artifacts, documents, chunks, previews, exports, caches, and later embeddings receive the strictest applicable policy from jobs, sources, collections, and upstream derivations.
- **Sensitivity is not a tag.** Enforcement occurs before search ranking, snippets, context rendering, export, diagnostics, or model/provider calls; user tags cannot lower it.
- **Notifications contain no content.** They may identify safe counts, state classes, and opaque job/source IDs but not private bodies or unsafe URLs.
- **Backups of private state are encrypted and permission-controlled.** Restore verification must not broaden filesystem permissions or expose private artifacts through public reports.
- **Normal tests use synthetic private data.** They assert redaction, permissions, inheritance, and explicit reveal behavior without reading live Keychain, recovery, browser, or corpus content.
- **Remote or multi-user access is deferred.** Any future daemon, web UI, remote operator, or shared index requires a separate authorization and threat-model decision before exposure.

## Consequences

- Local CLI use remains low-friction while durable operational surfaces avoid accidental disclosure.
- Exact historical provenance and sensitive values may exist at rest, making filesystem protection and encrypted backup mandatory.
- Every new retrieval, export, connector, notification, and semantic-index feature must propagate and enforce sensitivity rather than bolt it on later.
- Operator tooling requires safe summaries and explicit reveal controls, which adds tests and audit records.
- This boundary does not protect against the logged-in account or a fully compromised machine; it prevents accidental cross-surface leakage and unauthorized future exposure.

## Related

This applies artifact handling from [ADR 0008](0008-content-addressed-artifact-storage.md), operational logging from [ADR 0011](0011-single-worker-source-scheduling.md), and the resource model from [ADR 0003](0003-agentbrain-owns-durable-ingestion.md). See [`CONTEXT.md`](../../CONTEXT.md) for sensitivity terminology.
