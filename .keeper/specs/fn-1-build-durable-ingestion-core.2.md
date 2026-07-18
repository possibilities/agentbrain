## Description

**Size:** M
**Files:** src/store.ts, src/db.ts, src/types.ts, test/store.test.ts

### Approach

Add immutable ingestion intent, append-only attempts, audited transitions, due-time scheduling, atomic lease claims, heartbeats, fencing tokens, and idempotent completion. Encode the accepted state machine and distinguish infrastructure retry from bounded item retry without running external work inside write transactions.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/store.ts:148-315` — sole-writer transaction conventions.
- `test/store.test.ts:210-251` — concurrent duplicate-write serialization tests.
- `docs/adr/0004-durable-ingestion-job-lifecycle.md:1` — locked lifecycle and retry decision.

**Optional** (reference as needed):
- `src/sanitize.ts:1-48` — bounded persisted diagnostics.

### Risks

Select-then-update claims can double-execute jobs, and stale completion can corrupt newer attempts. State constraints must still permit repair of interrupted migrations and operator transitions.

### Test notes

Use multiple SQLite connections and fake clocks to race claims, expire leases, reject stale fencing tokens, exercise retry budgets, and replay completion.

### Detailed phases

1. Add job, attempt, transition/audit, lease, and due-work indexes.
2. Implement atomic claim/heartbeat/complete/recover APIs.
3. Cover every legal and illegal transition plus database contention.

### Alternatives

One mutable queue row is rejected because it destroys attempt history; an external broker is rejected for local deployment complexity.

### Non-functional targets

Claims and finalization use short bounded transactions; runnable scans use indexed status and due-time predicates.

### Rollout

Keep worker execution disabled; prove the lifecycle entirely through temporary-database APIs first.

## Acceptance

- [ ] Concurrent claimers cannot obtain the same active lease.
- [ ] Expired attempts become stale and late workers cannot heartbeat or complete with an old fencing token.
- [ ] Infrastructure failures remain retryable indefinitely while item-specific retry exhaustion becomes blocked.
- [ ] Manual retry preserves the job and prior attempts; cancel, exclude, reopen, and sensitive inspection append audit evidence.
- [ ] Idempotent completion cannot duplicate resource, provenance, or terminal job effects.

## Done summary

## Evidence
