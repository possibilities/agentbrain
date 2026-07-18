## Description

**Size:** M
**Files:** src/worker.ts, src/jobs.ts, src/cli.ts, src/help.ts, src/guide.ts, test/worker.test.ts, test/jobs-cli.test.ts

### Approach

Build the singleton worker loop over atomic leases, local materializer dispatch, heartbeats, fenced completion, stale recovery, bounded shutdown, and due retries. Add safe `jobs list/show/retry/cancel/exclude`, `jobs stats`, and `doctor` surfaces with explicit content reveal and audited operator transitions.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/store.ts:148-315` — transaction and sole-writer conventions.
- `src/extract.ts:208-376` — local materializers owned by Agentbrain.
- `src/format.ts:1` — existing output formatting conventions.
- `docs/adr/0011-single-worker-source-scheduling.md:1` — locked process topology.
- `docs/adr/0012-local-security-and-sensitive-ingestion.md:1` — safe inspection boundary.

**Optional** (reference as needed):
- `test/scrapectl.test.ts:40-62` — fake PATH executable pattern.

### Risks

Shutdown or cancellation can race completion; default inspection can leak sensitive content; worker polling can create SQLite contention.

### Test notes

Use fake clocks/materializers and temporary state to cover once mode, long-loop wakeup, signal shutdown, stale recovery, blocked jobs, audit events, redaction, explicit reveal, and doctor failures.

### Detailed phases

1. Implement worker claim/dispatch/heartbeat/finalization loop.
2. Add recovery, shutdown, and bounded internal concurrency.
3. Add operator and doctor commands with safe machine envelopes.

### Alternatives

Multiple daemon processes and implicit content display are rejected for the first local release.

### Non-functional targets

Worker idle polling is low-cost, active materialization never holds a write transaction, and logs contain IDs/counts/classifications only.

### Rollout

Provide `worker --once` before enabling a long-running service; all tests use fake materializers and temporary state.

## Acceptance

- [ ] `worker --once` deterministically drains eligible local jobs and leaves blocked/future-due work untouched.
- [ ] Graceful shutdown and lease expiry preserve recoverable intent without stale completion.
- [ ] Operator transitions append audit records and never erase attempt history.
- [ ] Default list/show/stats/doctor output excludes content and unsafe URL/query details; explicit reveal is required for artifact bodies.
- [ ] Worker and operator tests require no Scrapectl installation or network.

## Done summary
Implemented the singleton worker loop (atomic fenced leases, local materializer dispatch outside write transactions, heartbeats, stale-lease recovery, bounded graceful shutdown, due-retry handling, --once mode) plus jobs list/show/retry/cancel/exclude/stats and doctor CLI surfaces with redacted-by-default output, explicit content reveal, and audited operator transitions.
## Evidence
