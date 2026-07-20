## Description

From audit finding F1 (Should fix) plus merged F5 (Test Gaps bullet 2). The fail-closed prepare-phase gates in `src/recovery-online.ts` that guard the irreversible online-egress backfill are covered only on the happy path and three digest-mismatch cases (`test/recovery.integration.test.ts`); the tamper/divergence gates have no direct negative test. Evidence path (Phase 2): grep of `test/recovery.integration.test.ts` in commit c7508fa finds no assertion of the codes `recovery_offline_accounting_mismatch` (hardcoded total gate, recovery-online.ts:333), `recovery_snapshot_corpus_mismatch`, `recovery_protected_jobs_changed` / `assertProtectedInventory`, `recovery_scope_widened`, `recovery_snapshot_stale`, or `assertQuiescent`. Merged F5: no direct assertion that an active online execution lease globally fences ordinary lease recovery (`recoverExpiredLeases`), only ordinary claims.

Files: `src/recovery-online.ts`, `test/recovery.integration.test.ts` (and the worker lease-recovery path in `src/worker.ts` for the F5 fence assertion).

## Acceptance

- [ ] A negative test mutates the live-vs-snapshot corpus and asserts `recovery_snapshot_corpus_mismatch`
- [ ] A negative test breaks the offline accounting and asserts `recovery_offline_accounting_mismatch`
- [ ] A negative test tampers protected inventory and asserts `recovery_protected_jobs_changed`
- [ ] A negative test widens scope and asserts `recovery_scope_widened`
- [ ] A negative test injects a post-snapshot job / non-quiescent worker and asserts `recovery_snapshot_stale` / the quiescence gate
- [ ] A test asserts that an active online execution lease fences `recoverExpiredLeases` globally (not only ordinary claims)

## Done summary

## Evidence
