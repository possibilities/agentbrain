## Overview

The FTS search() query in src/db.ts groups by document and uses a single
MIN(chunks_fts.rank) aggregate; the bare columns chunk_id/chunk_index/
start_char/end_char therefore take their values from the min-rank row via
SQLite's single-aggregate bare-column rule, and that chunk_id then drives
the per-hit snippet fetch. This follow-up documents that load-bearing,
non-obvious reliance in code so a future refactor does not silently select
the wrong chunk's snippet. Documentation-of-invariant only; no behavior change.

## Acceptance

- [ ] The reliance on SQLite's single-MIN/MAX bare-column rule is stated in a comment at the search() query
- [ ] The comment warns that adding a second aggregate or selecting a bare column would make chunk selection indeterminate
- [ ] No behavior or query-result change

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | db.ts:261 MIN()+GROUP BY d.id makes chunk_id/chunk_index/start_char/end_char bare-column values that drive the snippet fetch; a refactor could silently pick the wrong chunk. |
| F2 | culled | — | jobs() SELECT * with JS-side limit/aggregation over an append-only ledger, but stays human-scale and sub-perceptible on a single-user local SQLite tool; latent optimization. |
| F3 | culled | — | search() per-hit N+1 enrichment is bounded by limit <= 50 and rated acceptable for a local tool; minor optimization. |
| F4 | culled | — | Signal wiring is thin delegation to the already-tested requestStop path; testing process.on registration mostly exercises Node. |
| F5 | culled | — | The fenced-rejection safety outcome is already proven via lease-recovery tests; the heartbeat-abort trigger is a redundant early-out behind a tested backstop. |

## Out of scope

- Pushing job list/stat limits and counts into SQL (F2) — deferred to a later touch of the jobs surface
- Batching search per-hit enrichment (F3)
- Direct tests for the worker signal-handler and heartbeat-abort branches (F4, F5)
