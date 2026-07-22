# ADR 0004: Durable ingestion job lifecycle

- Status: Accepted
- Date: 2026-07-18

## Context

Durable ingestion must survive worker crashes, backend outages, malformed content, and operator intervention without losing the original intent or its failure history. A single mutable queue row that is reset on retry cannot distinguish a requested ingestion from one execution, and an unbounded retry policy can let a poisonous item churn forever. Conversely, treating every temporary provider outage as terminal would abandon otherwise valid work.

External extraction cannot share an atomic transaction with local SQLite state. The lifecycle therefore needs at-least-once execution, idempotent index effects, and fencing against workers that finish after their claim has expired.

## Decision

- **Jobs have these states:** `queued`, `running`, `retry_wait`, `blocked`, `failed`, `completed`, `excluded`, and `cancelled`.
- **Every execution appends an immutable attempt.** Retry reuses the original job and intent while creating a new attempt; it never erases or rewrites prior attempt outcomes.
- **Claims use expiring leases and fencing tokens.** A worker must present the current token when heartbeating or committing. An expired attempt is recorded as stale, and a late worker cannot overwrite a newer attempt or terminal disposition.
- **Infrastructure unavailability retries indefinitely.** Missing or unavailable Agentscrape/browser infrastructure uses capped exponential backoff with jitter and remains visible in `retry_wait` until service recovers or an operator intervenes.
- **Item-specific transient failure has a bounded automatic budget.** Timeouts, throttling, and retryable upstream responses attributable to one item eventually move the job to `blocked` for human inspection instead of churning forever.
- **Permanent input or content failure stops automatically.** Invalid input, unsupported content, malformed successful output, and deterministic processing defects move the job to `failed` with a sanitized classification.
- **Authentication and configuration failures block.** They move the affected job to `blocked`; source-wide credential or configuration failures may also pause the source rather than repeatedly scheduling equivalent work.
- **Operator actions preserve history.** Manual retry requeues the same job and appends an attempt. Exclusion, cancellation, and any later reopening are durable audited transitions.
- **Cancellation is fenced.** A running worker cannot commit after cancellation unless the cancellation itself lost a documented compare-and-swap race to an already-committed completion.
- **Completion is transactional with Agentbrain state.** Resource, document, artifact reference, provenance, derived child jobs, source checkpoint effects, attempt success, and job completion commit together whenever they share the local database.
- **External work occurs outside write transactions.** Workers claim briefly, perform Agentscrape or local materialization work without holding the writer lock, then commit through the fenced idempotent completion path.
- **Retry and lease durations are policy, not identity.** Defaults are configurable and testable without changing persisted job semantics or idempotency keys.
- **Durable diagnostics are bounded and sanitized.** Jobs and attempts retain structured classifications and safe summaries; large or sensitive raw output belongs in policy-controlled artifacts rather than hot queue rows.

## Consequences

- A provider outage resumes automatically without converting every waiting item into operator work.
- Resource-specific poison jobs stop consuming work while preserving enough evidence for a human decision.
- At-least-once execution may repeat extraction, but idempotent completion and fencing prevent duplicate index effects or stale finalization.
- The schema needs separate job and attempt records, lease indexes, transition validation, and operator-audit evidence.
- Workers require recovery logic for stale leases, database contention, process termination, and completion races.
- Operational tooling must distinguish active retry delay, blocked intervention, permanent failure, exclusion, cancellation, and stale attempts.

## Related

This refines the durable-ingestion ownership decision in [ADR 0003](0003-agentbrain-owns-durable-ingestion.md) and retains the extraction boundary in [ADR 0002](0002-agentscrape-owns-url-extraction.md). See [`CONTEXT.md`](../../CONTEXT.md) for job, attempt, and run terminology.
