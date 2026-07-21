## Description

**Size:** M
**Files:** scripts/smoke-recurring-sources.sh, config/sources.yaml, ~/.hermes/research-cache/research.db, ~/.local/share/agentbrain/artifacts/

### Approach

Run opt-in temporary-state live smokes for one blog and one X account, inspect durable failure behavior, then enable confirmed sources in bounded cohorts and observe at least one scheduled cycle. Verify checkpoints, duplicate overlap, emitted jobs/resources, health, and pause/recovery without enabling recommended accounts or deep X backfill.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `scripts/smoke-scrapectl-url-ingest.sh:1` — temporary-state opt-in smoke precedent.
- `config/sources.yaml:1` — confirmed/disabled source definitions after Task 4.
- `/Users/mike/code/arthack/apps/scrapectl/README.md:420-425` — live X opt-in convention.

**Optional** (reference as needed):
- `~/docs/agentbrain-source-recovery-2026-07-15.jsonl:1` — source provenance evidence.

### Risks

The browser farm or credentials may be unavailable, source pages may change, and bulk activation can create excessive work. Live content and signed URLs must not enter committed evidence.

### Test notes

Offline suites are mandatory first. Live smoke uses explicit opt-in and temporary DB/artifact roots; production activation uses per-source caps, health observation, and immediate pause controls.

### Detailed phases

1. Smoke one blog and one X source in temporary state.
2. Prove failure/retry/block and checkpoint behavior, then enable small confirmed cohorts.
3. Observe a scheduled cycle, reconcile, and enable remaining confirmed sources if healthy.

### Alternatives

Enabling all sources before a live provider proof is rejected; leaving all source definitions permanently disabled would not satisfy operational scope.

### Non-functional targets

Activation is bounded, reversible by pause, privacy-safe, and leaves durable evidence for every discovered/admitted/suppressed item.

### Rollout

Keep candidate sources and deep X backfill disabled. On provider outage, jobs enter retry_wait/blocked according to policy and resume after the browser farm or credentials recover.

## Acceptance

- [ ] Temporary live smokes prove blog and X discovery, queued item extraction, artifact/index completion, and inspectable failure without touching production state.
- [ ] Confirmed sources activate in bounded cohorts with daily blog and hourly X schedules; all 13 recommendations remain disabled.
- [ ] At least one production schedule cycle records source runs, observations, durable resource jobs, safe checkpoints, and health metrics.
- [ ] Repeated overlap discovers no duplicate index effects and absence from bounded responses deletes nothing.
- [ ] Deep historical X backfill remains explicitly disabled and no result claims complete historical coverage.

## Done summary
Activated the 25 confirmed recurring sources (11 blogs daily, 14 X accounts hourly) via a reviewable config/sources.activation.yaml overlay, keeping all 13 x_account_candidate recommendations and deep X backfill disabled. Added an opt-in temporary-state smoke (scripts/smoke-recurring-sources.sh) that drives one blog and one X source through the durable schedule->discovery->checkpoint->overlap->pause loop, locked the activation contract with offline tests, and documented the bounded operator rollout in the README.
## Evidence
