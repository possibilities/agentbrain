## Overview

Two audit survivors from the controlled online-backfill work. First, the fail-closed prepare-phase gates guarding an irreversible remote-egress path are unproven to reject: they hold "by construction" but have no direct negative tests, so a future refactor could silently weaken one and let a mutated corpus, widened scope, or non-quiescent state through to live egress with no failing test. Second, the recovery task globally reclassified `upstream_unavailable` retry semantics for every URL extraction job, not just recovery, and that blast radius must be scoped or deliberately confirmed.

## Acceptance

- [ ] Every security-critical prepare-phase gate has a direct negative test asserting its `onlineError` code
- [ ] The active-online-lease fence over `recoverExpiredLeases` is directly asserted
- [ ] The `upstream_unavailable` retry reclassification is either scoped to recovery or confirmed-and-documented as an intentional global change, with ordinary URL jobs protected from unbounded retry on a persistent outage

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | recovery.integration.test.ts has no negative assertion for any prepare-gate error code guarding irreversible online egress |
| F2 | kept | .2 | scrapectl.ts:978-980 reclassifies upstream_unavailable to infra for ALL URL jobs, changing ordinary-worker retry semantics |
| F3 | culled | — | 629/581 literals are for a frozen digest-pinned one-shot generation; provably correct at execution, stale-if-changed risk purely theoretical |
| F4 | culled | — | WorkerResult.scheduled is declared/init 0, never incremented, no production consumer - speculative-generality dead field |
| F5 | merged-into-F1 | .1 | F5 (companion recoverExpiredLeases fence test) folds into F1's prepare-gate test-coverage task - same irreversible-fencing negative-test cluster |

## Out of scope

- The 629/581 magic-number derivation (F3, culled - frozen one-shot generation)
- Removing or wiring WorkerResult.scheduled (F4, culled - dead field, no impact)
