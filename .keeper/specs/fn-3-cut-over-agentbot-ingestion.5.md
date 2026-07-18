## Description

**Size:** S
**Files:** README.md, docs/architecture.md, docs/references.md, docs/twitter-scraper-prd.md, tests/test_boundaries.py

### Approach

Reconcile Hermes documentation and boundary tests with Agentbrain-owned durable ingestion, Scrapectl-only extraction, and Linkctl removal. Preserve Hermes as a non-writing ad hoc extraction/Perplexity surface and distinguish historical watcher evidence from live architecture.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `README.md:5-28` — current retained/retired responsibility summary.
- `docs/architecture.md:38-65` — ownership boundaries.
- `tests/test_boundaries.py:79-111` — prohibited research ownership regression guard.

**Optional** (reference as needed):
- `docs/twitter-scraper-prd.md:1` — historical future-watcher wording.

### Risks

Documentation can accidentally imply Hermes regained ingestion or overstate recurring-source features not yet delivered.

### Test notes

Run Hermes boundary/install tests and search live docs for Linkctl or Scrapectl-queue ownership claims.

### Detailed phases

1. Update current architecture and retained capabilities.
2. Mark historical watcher material clearly without deleting useful evidence.
3. Tighten boundary tests around no Agentbrain writes or queue ownership.

### Alternatives

Leaving stale docs is rejected because agents use them as architecture instructions.

### Non-functional targets

Documentation is forward-facing, concise, and contains no private recovery bodies or secret material.

### Rollout

Land after runtime removal so prose describes the deployed boundary rather than an intermediate state.

## Acceptance

- [ ] Hermes docs identify Agentbrain as durable ingestion/index owner and Scrapectl as sole URL extractor.
- [ ] No current guidance instructs callers to use Linkctl or a Hermes research adapter.
- [ ] Historical watcher references are clearly non-live and do not claim complete backfill.
- [ ] Boundary tests continue to prohibit Hermes research DB, queue, watcher, and index writes.

## Done summary

## Evidence
