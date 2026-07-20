## Overview

Two hardening items survived the close audit of the legacy corpus recovery
work: a provenance-link correctness bug in the recovery importer's
foreign-owner merge branch (job ends up linked to a document-less resource),
and an operational defect in the restic backup scripts where per-run snapshot
directories accumulate unbounded on local disk and get re-walked every run.
Both are bounded, low-risk fixes in code that will be reused on the next touch.

## Acceptance

- [ ] Recovery import job->resource->document link resolves correctly after a foreign-owner merge (or the divergence is documented as intended), with a regression test.
- [ ] Restic backup snapshot directories are reclaimed so local disk does not grow unbounded and restic stops re-walking stale snapshots.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | worker.ts:648 merge branch links the job to recoveryResource.id (no document_id there) while the document lands under documentOwner.id, so job->resource->document resolves NULL. |
| F2 | culled | — | Defense-in-depth partial index; exactly-one-outcome already serialized by SELECT-then-write under BEGIN IMMEDIATE, no shipped defect. |
| F3 | culled | — | Observability/framing only; per-candidate transactions make replay idempotent and the dead guard is harmless. |
| F4 | culled | — | Metadata-only; no access gate reads resource_artifacts sensitivity. |
| F5 | culled | — | Orphan content-addressed blob is harmless on rerun, merely unreclaimed. |
| F6 | culled | — | Criterion 3 holds as shipped (offline recovery); latent only on a future online retry, and task .6 persisted the 2-ID allowlist artifact. |
| F7 | culled | — | Free-text raw_metadata is not FTS-indexed and rendered by no read command; Criterion 6 holds. |
| F8 | kept | .2 | restic-backup:173 drops a fresh snapshot dir into $SNAPSHOT_DIR each run with no prune, and $SNAPSHOT_DIR is in the restic source set (line 234); unbounded disk growth. |
| F9 | culled | — | cleanText markdown-sniff false positive only preserves whitespace instead of collapsing it; benign, gating is a design preference. |
| F10 | culled | — | Worst-case aggregate memory bound; the real 581-artifact rehearsal completed, scale-theoretical. |
| F11 | culled | — | LOCKED counts correct as shipped (verified against dispositions); hand-maintained-sum drift is a maintainability nit. |
| TG1 | culled | — | Coverage gap not a defect; behavior manually verified across 6 tamper vectors. |
| TG2 | culled | — | Misleading no-op unit assertion, but the real offline guard exists (integration forbidden-Scrapectl). |
| TG3 | culled | — | Tautological dry-run assertions echo LOCKED constants; test-quality nit. |
| TG4 | merged-into-F1 | .1 | TG4 (missing job->resource->document link test) folds into F1: same root cause as F1's merge-branch divergence; the F1 task adds the assertion. |

## Out of scope

- The admission-layer hardening Considers (partial unique index F2, run-state framing F3, artifact sensitivity F4, orphan blob F5, egress-allowlist persistence F6, free-text value inspection F7) — culled as non-shipping, deferred to a later touch.
- Broader test-coverage backfill (tamper/rerun cases TG1, unreachable/tautological assertions TG2/TG3) and the cleanText sniff-breadth review (F9).
