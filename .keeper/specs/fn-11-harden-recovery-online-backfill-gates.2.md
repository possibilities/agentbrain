## Description

From audit finding F2 (Consider). `src/scrapectl.ts:978-980` (commit c7508fa) reclassifies `upstream_unavailable` from `item_transient`/`item` to `infra`/`infrastructure`. Confirmed against the audited blob: the reclassification is unconditional, so it applies to every URL extraction job system-wide, not just the recovery drain it shipped with. Ordinary URL jobs hitting `upstream_unavailable` now take infra backoff and no longer consume the item-retry budget toward permanent failure - risking unbounded retry on a persistent upstream outage instead of failing out. The commit message and done summary describe recovery-only intent; the code change is global.

Files: `src/scrapectl.ts`, `test/scrapectl.test.ts`.

Resolve in one of two directions: (a) scope the infra reclassification to the recovery execution context so ordinary URL jobs retain their prior item-transient semantics, or (b) confirm the global change is intended and guard ordinary jobs against unbounded retry on a persistent outage (cap/permanent-failure path), documenting the deliberate blast radius.

## Acceptance

- [ ] `upstream_unavailable` retry semantics for ordinary URL jobs are either restored to item-transient or given a bounded-retry / permanent-failure path
- [ ] The chosen direction is covered by a test in `test/scrapectl.test.ts`

## Done summary

## Evidence
