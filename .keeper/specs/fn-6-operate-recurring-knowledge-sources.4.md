## Description

**Size:** M
**Files:** config/sources.yaml, src/sources.ts, src/worker.ts, src/cli.ts, src/help.ts, README.md, test/source-config.test.ts

### Approach

Materialize the 11 recovered configured blogs and 14 configured X accounts as stable, versioned source definitions with explicit discovery settings, daily/hourly cadence, limits, collections, and sensitivity. Represent the 13 recommendations as disabled candidates, expose health/pause controls, and connect due evaluation to the singleton worker without auto-running deep backfill.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `~/docs/agentbrain-source-recovery-2026-07-15.jsonl:1` — confirmed versus recommended source evidence.
- `~/docs/agentbrain-recovery-report-2026-07-15.md:30-36` — recovered counts and horizon.
- `docs/adr/0011-single-worker-source-scheduling.md:1` — daily/hourly and catch-up policy.

**Optional** (reference as needed):
- `README.md:1` — forward-facing command and architecture style.

### Risks

Recommendation evidence can be mistaken for consent, mutable X handles can become identity, and enabling all sources at install can cause an unbounded first run.

### Test notes

Validate exact confirmed/recommended counts, stable IDs, duplicate URLs/handles, disabled candidates, cadence, per-run caps, and install/update behavior with no live calls.

### Detailed phases

1. Encode confirmed blog and X source definitions from recovered evidence.
2. Encode recommended X accounts as disabled candidate records.
3. Add bounded schedule activation, health, pause/resume, and documentation.

### Alternatives

Flattening watched accounts/homepages into saved links is rejected because source definitions and emitted resources have different lifecycle.

### Non-functional targets

Configuration is deterministic, reviewable, credential-free, bounded on first activation, and safe to update without resetting checkpoints.

### Rollout

Land all definitions disabled; the final live task enables confirmed sources in controlled cohorts after provider smoke. Candidate recommendations stay disabled.

## Acceptance

- [ ] Configuration contains exactly 11 confirmed blog sources and 14 confirmed X sources with stable source IDs and locked default cadences.
- [ ] Exactly 13 recommended X accounts are represented as disabled candidates and cannot schedule runs.
- [ ] First activation uses explicit lookback/caps and cannot silently request unsupported deep X backfill.
- [ ] Source list/status/pause/resume exposes safe health and checkpoint data without credentials or private content.
- [ ] Worker due evaluation creates durable source-run jobs rather than executing discovery inline.

## Done summary
Materialized the confirmed source manifest (11 blogs + 14 X accounts, disabled by default with locked daily/hourly cadences and bounded caps) plus 13 disabled x_account_candidate rows, and added the agentbrain sources apply command to install/update it.
## Evidence
