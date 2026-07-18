## Description

**Size:** M
**Files:** src/link-ingest.ts, src/store.ts, src/worker.ts, src/types.ts, test/link-ingest.test.ts, test/fixtures/prescraped_x_tweet.json, test/fixtures/prescraped_x_article.json

### Approach

Replace synchronous X child extraction with transactional parent completion that records authoritative typed relations, shared-child provenance, suppressions, and at most 25 one-hop child jobs. Parent success requires durable child intent, not child completion; child retry never replays the parent.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/link-ingest.ts:110-153` — current recursive `links` discovery.
- `src/link-ingest.ts:366-473` — synchronous root-first child loop to replace.
- `src/store.ts:317-389` — durable relation upsert and shared target behavior.
- `test/link-ingest.test.ts:43-296` — existing fanout, partial, retry, and replay coverage.

**Optional** (reference as needed):
- `docs/adr/0009-durable-source-fanout-and-checkpoints.md:1` — locked fanout semantics.

### Risks

Canonical aliases can collapse legitimate parent observations, shared child metadata can be overwritten, and over-limit links can disappear unless suppression is explicit.

### Test notes

Cover zero/one/over-25 links, shared children, duplicate aliases, quoted posts, excluded chrome/media, parent replay, child failure/retry, and parent deletion.

### Detailed phases

1. Map typed extractor relations into resource observations and suppressions.
2. Commit parent document, relations, and child jobs atomically.
3. Remove synchronous child provider calls and partial exit semantics from worker behavior.

### Alternatives

Concatenating child content into the X document and retrying children by replaying roots are rejected for provenance and durability reasons.

### Non-functional targets

Fanout is deterministically bounded, idempotent under replay, and adds no recursive network depth.

### Rollout

Preserve Linkctl-origin fixture labels as historical evidence while updating their extraction-envelope shape.

## Acceptance

- [ ] Parent completion atomically records every eligible child job/relation or durable suppression reason.
- [ ] Parent completion does not wait for child extraction, and child retry never re-extracts the parent.
- [ ] Fanout admits at most 25 eligible one-hop children and records all additional discoveries as suppressed.
- [ ] Multiple parents can share one destination job/resource without losing any parent relation or observation.
- [ ] Generic non-X roots do not gain implicit Markdown-link crawling.

## Done summary

## Evidence
