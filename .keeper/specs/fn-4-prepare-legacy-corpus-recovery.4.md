## Description

**Size:** M
**Files:** src/text.ts, src/store.ts, src/types.ts, package.json, bun.lock, test/chunking.test.ts, test/query.test.ts

### Approach

Replace blind character splitting for Markdown artifacts with deterministic block-aware chunking that preserves heading breadcrumbs, paragraphs, lists, fenced code, tables, and blockquotes. Store structural anchors, line ranges, block types, revision digest, chunker version, and resource-level deduplication metadata while retaining safe fallbacks for oversized atomic blocks and non-Markdown text.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/store.ts:77-99` — current FTS chunk fields and tokenizer.
- `src/store.ts:193-314` — current chunk replacement during upsert.
- `src/text.ts:1` — current text chunking helpers.
- `test/query.test.ts:1` — retrieval result expectations.

**Optional** (reference as needed):
- `src/extract.ts:325-376` — Markdown/local file extraction path.

### Risks

Parser dependencies can alter formatting, unstable anchors can churn every chunk, and oversized code/tables can exceed limits or dominate results.

### Test notes

Use fixtures covering nested headings, code fences, lists, tables, quotes, Unicode, oversized blocks, repeated sections, and deterministic re-chunk/rebuild.

### Detailed phases

1. Parse Markdown into stable structural blocks and breadcrumbs.
2. Pack blocks within bounded chunk targets with type-specific fallback.
3. Persist structural metadata/version and preserve lexical regression behavior.

### Alternatives

Fixed characters with overlap are rejected because they sever structure and duplicate term frequency; embeddings remain deferred.

### Non-functional targets

Chunking is deterministic, linear in input size, bounded in memory, and does not execute HTML or code.

### Rollout

Version the chunker and rebuild only through explicit ingestion/reindex paths; do not silently mix incompatible generations.

## Acceptance

- [ ] Markdown chunks preserve heading paths and keep reasonable code, table, list, and quote blocks intact.
- [ ] Oversized blocks split deterministically with enough repeated context to remain understandable.
- [ ] Every chunk records stable structural provenance and the source artifact revision.
- [ ] Reprocessing unchanged Markdown yields identical chunk identities and ordering.
- [ ] Existing exact-token and non-Markdown lexical tests remain green.

## Done summary

## Evidence
