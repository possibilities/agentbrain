## Overview

The scrapectl URL-extraction work left two live extraction paths carrying byte-identical
copies of the same security-load-bearing sensitive-query redaction data: the token set,
the query-name set, the compact-name set, and the JWT regex. Because these lists only
have value while they stay identical, editing one without the other silently opens a
secret-redaction gap in a single path, and no test guards their identity today. This
follow-up hoists the shared redaction data into one module both paths import, closing
the divergence hazard.

## Acceptance

- [ ] The sensitive-query token/name/compact sets and the JWT regex exist in exactly one
      module inside the scrapectl package, imported by both extraction paths.
- [ ] No behavior change: the redaction output of both paths is identical to before for
      the existing offline redaction tests, which continue to pass.
- [ ] A test asserts both paths use the shared definitions (or an equivalent guard) so a
      future single-sided edit cannot silently diverge them.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | Refuted: pre-existing table-level UNIQUE(run_id, resource_id, observed_locator) with matching NULL semantics already prevents any legacy dupe from wedging the V6 partial index. |
| F2 | culled | — | agentbrain X_MEDIA_HOSTS is belt-and-suspenders behind the authoritative scrapectl filter; the ton.twitter.com typo has no observable effect on a redundant layer. |
| F3 | kept | .1 | Byte-identical sensitive-query redaction sets + JWT regex copy-duplicated across two live arthack paths (x.py, run_fetch_markdown.py); silent divergence opens a secret-redaction gap. |
| F4 | culled | — | Long-function maintainability smell only; well-tested, no user impact. |
| F5 | culled | — | Comment-only remedy on test-fixture fidelity; production mapping path already covered. |
| F6 | culled | — | Regression test for a path already verified safe by reading normalizedWebUrl. |

## Out of scope

- The third partial copy of the JWT/known-secret regexes in agentbrain src/sanitize.ts:
  it is a separate repo and a different language (TypeScript), so it cannot share the
  Python module and is not part of this hoist.
- Any change to what counts as sensitive (the redaction semantics stay identical; this is
  a consolidation, not a policy change).
- The X media-host suppression set and the migration index (both culled at audit).
