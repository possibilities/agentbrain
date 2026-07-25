# ADR 0016: External trigger contract for recurring Sources

- Status: Accepted
- Date: 2026-07-23

## Context

Agentbrain already owns durable Source definitions, source-sync Runs, jobs, observations, checkpoints, retries, Resources, and Documents. A separate local scheduling service is being developed to run registered commands on wall-clock schedules. Duplicating that timer inside Agentbrain would create two schedule authorities without improving ingestion correctness.

The useful boundary is therefore not an Agentbrain timer. It is a deterministic one-shot command that an external scheduler can invoke repeatedly while Agentbrain retains all ingestion state and Agentscrape retains all network/provider behavior. X timeline discovery is live today; blog, RSS, and Atom Sources additionally need live bounded feed transport rather than test-only recorded responses.

## Decision

- **The future scheduling service owns wall-clock process triggering.** Agentbrain does not add another timer, cron parser, scheduler database, or recurring daemon.
- **Agentbrain remains the durable ingestion authority.** A trigger invokes `agentbrain sources sync SOURCE_ID --due`; Agentbrain decides whether work is due, disabled, paused, unsupported, already active, or newly admitted.
- **Per-Source due triggers are idempotent and outcome-preserving.** Due gating uses the Source's persisted cadence. A retry while a Run is pending or active returns that existing Run as `duplicate` rather than creating another Run, even after `next_due_at` advanced at admission. With `--wait`, a `not_due` retry also includes the latest terminal Run receipt, so a Run that finished after an earlier observer timeout cannot have its failure hidden by the cadence gate.
- **The scheduler-facing completion seam is explicit.** `--wait` waits for the admitted or existing source-sync Run and its source job to settle, then returns the admission plus a bounded execution receipt. A timeout normally exits 124; `--wait-timeout-ok` preserves `timed_out:true` evidence while exiting 0 only while the job remains queued, running, or retrying. Blocked and other settled non-success jobs exit 1 immediately. A terminal outcome other than `success` exits 1. A healthy `not_due` no-op exits 0.
- **Source completion means discovery durability, not child extraction completion.** A successful source-sync Run proves that its bounded provider window, observations, suppressions, admissions, and checkpoint were committed consistently. Discovered URL jobs remain independently retryable and may finish later.
- **The resident Worker executes admitted jobs.** `sources sync` never performs provider I/O inline. The installed Worker keeps leases, attempts, retries, cancellation, and fenced completion in one queue.
- **Agentscrape owns live source transport.** X timelines use the X provider path. Direct RSS/Atom URLs and blog homepages use a bounded live feed command; homepage discovery follows only explicit RSS/Atom alternate links. Recorded responses remain an offline replay/test seam.
- **Feed validators are retrieval-scoped checkpoint evidence.** Conditional validators are supplied only when the last committed checkpoint is bound to the same configured feed URL, exact redirect-effective response URL, and Source definition version. Homepage autodiscovery never reuses them across a potentially changed advertised target. A matching `304 Not Modified` is a complete empty observation window. New validators advance only with Agentbrain's successful transactional Source checkpoint, and a definition change during discovery fences stale checkpoint and pause/health policy publication while preserving the strictest sensitivity.
- **X cursors are identity-scoped checkpoint evidence.** `since_id` and overlap IDs are reused only for the same normalized account handle, profile URL, and Source definition version. Legacy or mismatched checkpoints force a bounded full poll before publishing a newly scoped checkpoint.
- **Live transport is capability-gated and consumer-first.** Agentbrain verifies the PATH-resolved Agentscrape help contract before invoking live feed mode; a recorded-only producer is a configuration failure rather than an infinite infrastructure retry. Deploy Agentbrain first, then Agentscrape, then activate Sources.
- **Schedules remain Source policy.** Cadence, per-run item/page limits, collections, sensitivity, pause state, and health are versioned with the Source definition even though an external service decides how often to invoke the trigger command.
- **Machine-readable output is the integration contract.** Scheduling integrations use `--json`, stable Source/Run/job IDs, admission status, terminal outcome, counts, warning count, checkpoint flag, and sanitized failure classification. They do not inspect SQLite directly.

## Consequences

- The future scheduling service can safely register one command per Source:

  ```bash
  /absolute/path/to/agentbrain sources sync SOURCE_ID --due --wait --wait-timeout-seconds 300 --wait-timeout-ok --json
  ```

- The scheduling service may invoke more frequently than the Source cadence without duplicate scraping; `not_due` is a successful no-op.
- A scheduler timeout does not cancel or lose the durable Run. Repeating the same per-Source due command rejoins an active Run through the `duplicate` receipt.
- `sources sync --due` remains useful for manual/global catch-up admission, but per-Source due commands are the preferred scheduled integration because each invocation has one stable outcome.
- Worker availability is separately observable. Without the resident Worker, `--wait` times out while the queued Run remains durable.
- RSS/Atom transport hardening, redirects, DNS policy, response bounds, and parsing stay outside Agentbrain's source boundary.

## Superseded decision

This ADR supersedes the source-timer portions of [ADR 0011](0011-single-worker-source-scheduling.md): the Worker does not periodically evaluate Source schedules, and `worker --once` does not admit due Sources. ADR 0011's singleton Worker, lease, recovery, shutdown, and logging decisions remain in force.

## Related

- [ADR 0003: Agentbrain owns durable ingestion](0003-agentbrain-owns-durable-ingestion.md)
- [ADR 0009: Durable source fanout and checkpoints](0009-durable-source-fanout-and-checkpoints.md)
- [ADR 0011: Single worker with source scheduling](0011-single-worker-source-scheduling.md)
- [`docs/runbooks/external-source-scheduling.md`](../runbooks/external-source-scheduling.md)
- [`docs/contracts/source-sync-trigger-v1.md`](../contracts/source-sync-trigger-v1.md)
