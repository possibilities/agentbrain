## Description

**Size:** M
**Files:** apps/scrapectl/scrapectl/api.py, apps/scrapectl/scrapectl/run_process_queue.py, apps/scrapectl/scrapectl/cli.py, apps/scrapectl/tests/test_queue_indexing.py, apps/scrapectl/tests/test_upstream_down.py, apps/scrapectl/README.md

### Approach

Add a bounded migration/reconciliation path that inventories old pending/failed YAML jobs, submits their Agentbrain intent through the new CLI with preserved URL/destination/frontmatter/source evidence, and records imported/drained/dispositioned outcomes. Freeze new Agentbrain-targeted YAML submission while leaving explicitly scrape-only queue behavior independent.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `apps/scrapectl/scrapectl/api.py:340-397` — old atomic YAML submission and indexer labels.
- `apps/scrapectl/scrapectl/run_process_queue.py:210-291` — Agentbrain adapter handoff.
- `apps/scrapectl/scrapectl/run_process_queue.py:323-411` — pending/failed/delete lifecycle.
- `apps/scrapectl/tests/test_queue_indexing.py:21-126` — isolated HOME queue fixtures.

**Optional** (reference as needed):
- `~/.local/share/scrapectl/failed/1776690536249-0073edb0.yaml` — known failed scrape-only evidence; read-only during implementation.

### Risks

Replaying a completed old job can duplicate acquisition, and malformed YAML may contain sensitive or unsupported fields. Migration must not delete evidence before Agentbrain acknowledgement is durable.

### Test notes

Build temporary pending/failed directories with valid, malformed, duplicate, legacy-indexer, scrape-only, and known codex-voice-shaped jobs; assert exact outcome manifests and no real CLI calls.

### Detailed phases

1. Inventory and classify old queue records without mutation.
2. Submit supported Agentbrain intents and persist reconciliation outcomes.
3. Freeze/remove new Agentbrain-targeted enqueue paths while preserving scrape-only use.

### Alternatives

Blindly drain through `research-ingest-link` is rejected because it preserves the obsolete authority split and deletes successful files.

### Non-functional targets

Migration is resumable, idempotent, content-redacting, and never deletes a source record before a durable destination receipt exists.

### Rollout

Run dry-run inventory first; execute live migration only during the epic cutover window after Agentbot changes are ready.

## Acceptance

- [ ] Every old pending/failed YAML record receives a durable imported, drained, duplicate, unsupported, or explicitly excluded outcome.
- [ ] The known codex-voice failure can become an inspectable Agentbrain job without fetching its URL.
- [ ] No new Agentbrain/research-cache indexer job can enter the Scrapectl YAML queue after freeze.
- [ ] Scrape-only queue behavior remains clearly separate and cannot write Agentbrain state.
- [ ] Migration tests use temporary HOME and fake Agentbrain commands only.

## Done summary

## Evidence
