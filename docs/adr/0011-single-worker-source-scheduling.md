# ADR 0011: Single worker with source scheduling

- Status: Accepted
- Date: 2026-07-18

## Context

Agentbrain is a local single-user system backed by SQLite. URL extraction benefits from bounded concurrency, but SQLite still serializes writes, and multiple independent worker processes would increase lease, shutdown, logging, and database-contention complexity before measurements justify it. Recurring sources also need durable schedule admission without introducing a second queue or an unrelated scheduler database.

The worker must survive login-session restarts and machine sleep while remaining easy to test without launchd or real network access.

## Decision

- **One long-running Agentbrain worker process is the initial deployment topology.** A macOS LaunchAgent keeps it alive for the user session.
- **Concurrency is bounded inside the process.** Materialization may use separate configured limits for URL extraction and local parsing, while fenced SQLite completion is serialized through the sole writer path.
- **The persisted lease model remains process-agnostic.** Schema and claims are safe for multiple workers, but additional worker processes are disabled until measurement demonstrates useful throughput without unacceptable contention.
- **Source scheduling uses the same process and ledger.** The worker periodically evaluates enabled source definitions and durably admits idempotent source-run jobs when their schedules are due; scheduling does not execute discovery inline or create a second queue.
- **Confirmed default schedules are policy.** Confirmed blog sources begin with daily cadence and confirmed X sources with hourly cadence, each with per-source pause, limits, health, and checkpoint state.
- **`agentbrain worker --once` is the deterministic execution seam.** It performs bounded due-schedule admission, stale-lease recovery, reconciliation, and job draining for tests, manual operation, and repair without requiring launchd.
- **Startup performs recovery before ordinary claims.** It identifies expired leases, fences stale attempts, reconciles artifact staging, and surfaces integrity defects before resuming normal work.
- **Shutdown is graceful and bounded.** The worker stops claiming new jobs, propagates cancellation or permits configured bounded completion for active materialization, and leaves any unfinished work recoverable by lease expiry.
- **Operational state is queryable through Agentbrain.** Job statistics, source status, and doctor output cover queue depth and age, active and stale leases, retries and terminal failures, source lag, database integrity, artifact references/staging, backup prerequisites, and required external executables.
- **Logs are diagnostic metadata only.** They include correlation IDs, transitions, durations, counts, and sanitized classifications, never indexed bodies, private artifacts, credentials, cookies, or unsafe signed URLs.
- **Sleep and clock changes are tolerated through durable due times.** Wake-up may produce one idempotent catch-up run per overdue source rather than replaying every missed wall-clock tick.

## Consequences

- Initial operations remain simple: one worker, one ledger, one index writer, and one launchd service.
- Network extraction can overlap without holding SQLite transactions, while completion order remains deterministic enough to test.
- Worker leases and fencing are not omitted merely because the first deployment is singleton; crashes and stale subprocesses still require them.
- Schedule evaluation and source-run admission share lifecycle, metrics, and operator tooling with every other ingestion kind.
- Higher throughput later requires measured changes to worker count and concurrency policy rather than a schema redesign.
- LaunchAgent installation, unloading, stale-service cleanup, logging, and offline worker tests become explicit rollout work.

## Related

This operationalizes the queue ownership in [ADR 0003](0003-agentbrain-owns-durable-ingestion.md), lease lifecycle in [ADR 0004](0004-durable-ingestion-job-lifecycle.md), artifact reconciliation in [ADR 0008](0008-content-addressed-artifact-storage.md), and source checkpoints in [ADR 0009](0009-durable-source-fanout-and-checkpoints.md). See [`CONTEXT.md`](../../CONTEXT.md) for worker terminology.
