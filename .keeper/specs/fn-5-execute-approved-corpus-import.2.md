## Description
**Size:** M
**Files:** src/store.ts, src/worker.ts, src/cli.ts, src/help.ts, src/types.ts, src/jobs.ts, test/worker.test.ts, test/jobs-cli.test.ts, test/cli.integration.test.ts

### Approach

**PRIOR-ATTEMPT LANE STATE — READ FIRST (supervisor note, 07-20 07:0x).** The previous
worker FULLY implemented and verified this task: an 11-file diff satisfying all acceptance
items sits UNCOMMITTED on this lane (154 tests were passing at its verification). Its
commit was refused only by an ownership conflict against its own wrapped leg's file claims
(since released or releasable), and the task was reset to todo. Your job: verify the
existing lane diff against the acceptance criteria (run the named gates yourself), then
LAND it via `keeper commit-work` with real evidence. Do NOT re-implement from scratch, do
NOT discard the diff, and NEVER mark done without the commit landing — an empty-evidence
done on this diff is exactly the #59 phantom-done failure. If commit-work still names a
live foreign claimant, use the envelope's request_release rail (bounded bus notice +
grace), then park OWNERSHIP_CONFLICT with the claimant named if it persists.


Extend the existing leased worker with an operator-controlled execution scope that pins one Run, an expected generation/approval digest, and an allowlist of job kinds before claims become eligible. Generic workers must skip operator-controlled runs; a scoped `worker --run ... --allowed-kind ... --once` performs no source scheduling and claims only matching jobs through the same lease, attempt, retry, artifact, fencing, and completion paths. Add safe run inspection and fail-closed CLI validation so operational tasks never need broad queue scans or raw URL reveal.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but predecessor integration may move them.*

**Required** (read before coding):
- `docs/adr/0004-durable-ingestion-job-lifecycle.md:13-27` — leases, fencing, attempts, and retry states remain authoritative.
- `docs/adr/0011-single-worker-source-scheduling.md:13-31` — singleton worker and scoped operator-drain contract.
- `docs/adr/0010-legacy-recovery-import-contract.md:29-38` — run-scoped offline/online recovery and rollback gates.
- `test/source-boundary.test.ts:16-35` — Agentbrain production source cannot gain a network client.

**Optional** (reference as needed):
- `src/store.ts` — re-verify the landed `claimJob` and Run schema after the durable-ingestion dependency merges.
- `src/worker.ts` — re-verify stale-lease recovery, `--once`, and claim-loop behavior after the worker dependency merges.
- `src/jobs.ts` — reuse safe job/run views rather than raw intent output.

### Risks

An optional scope that silently falls back to generic claims is worse than no scope. Generic and scoped workers can race unless controlled runs are excluded from ordinary claims; kind filtering after claim is too late. Schema/API changes must preserve ordinary LaunchAgent behavior and lease recovery.

### Test notes

Use temp SQLite, fake clocks, and fake Scrapectl. Seed target and unrelated due jobs, run scoped workers under concurrent generic-claim pressure, and prove only matching run/kind jobs receive attempts. Test digest/cardinality mismatch, stale leases, interruption, retry_wait, safe output, and zero source scheduling. Keep suites synthetic, socket-denied, and small.

### Detailed phases

1. Represent an operator-controlled Run scope and immutable authorization digest without creating another queue.
2. Make generic claims exclude controlled runs and add transactional run/kind-scoped claims with normal leases and fencing.
3. Add scoped `worker --once`, safe run inspection, quiescence checks, and explicit no-schedule/offline-kind behavior.
4. Exercise races, retries, cancellation, resume, and unrelated-job isolation in lightweight tests.

### Alternatives

Queue-wide quiescence alone is rejected because ingress can enqueue work during the window. A recovery-specific executor bypassing the worker is rejected because it would duplicate lifecycle and index-write ownership.

### Non-functional targets

No network code, no second queue, no full-table polling loop, bounded transactions, deterministic claim ordering, unchanged generic worker throughput, and ordinary output containing only safe opaque metadata.

### Rollout

Land and exercise scoped execution entirely against temporary runs first. Existing unscoped worker behavior remains the default; controlled runs remain non-runnable until an explicitly matching scoped invocation.
## Acceptance

- [ ] Generic workers never claim jobs belonging to an operator-controlled Run, including under concurrent claim attempts.
- [ ] A scoped worker fails closed unless Run ID, authorization digest, and allowed kinds match persisted Run policy; there is no fallback to unscoped execution.
- [ ] Scoped `--once` drains only eligible jobs in the pinned Run, performs no source scheduling, and leaves unrelated due jobs untouched.
- [ ] Offline scopes reject URL/external extraction kinds before claim, while online scopes can allow only the two URL jobs already bound to their Run.
- [ ] Scoped jobs retain standard leases, fencing, immutable Attempts, retry classification, cancellation, artifact reconciliation, and idempotent completion.
- [ ] Safe run/job output exposes opaque IDs, counts, states, attempts, and sanitized classes without raw intents, exact unsafe URLs, bodies, or credentials.
- [ ] Targeted tests are offline, synthetic, lightweight, and cover concurrent generic/scoped claims, mismatch, crash/resume, and retry_wait.

## Done summary

## Evidence
