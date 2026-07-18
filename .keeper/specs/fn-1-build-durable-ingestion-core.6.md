## Description

**Size:** M
**Files:** src/db.ts, src/query.ts, src/render.ts, src/cli.ts, src/help.ts, test/query.test.ts, test/cli.integration.test.ts

### Approach

Extend lexical retrieval and context rendering with resource kind, collection, source, sensitivity, date, and path filters while preserving current FTS ranking. Rank chunks, deduplicate at resource level, and expose typed relations without concatenating linked resource content.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/db.ts:117-180` — current FTS query, filtering, and BM25 order.
- `src/query.ts:1` — query contract and context assembly.
- `test/query.test.ts:1` — retrieval fixture patterns.

**Optional** (reference as needed):
- `src/store.ts:77-99` — FTS indexed fields and tokenizer.

### Risks

Joining many-to-many membership can duplicate rows and distort BM25; sensitivity filters must run before snippets or context rendering.

### Test notes

Build resources with shared collections/sources and mixed sensitivity; assert filtering, stable ordering, resource deduplication, relation display, and read-only behavior.

### Detailed phases

1. Add typed query filters and efficient membership joins.
2. Deduplicate chunk hits by resource and preserve best-score context.
3. Render safe provenance and relation summaries.

### Alternatives

Encoding collections and sources as tags is rejected because it cannot preserve membership history or enforce sensitivity.

### Non-functional targets

Filtered lexical queries remain indexed and bounded; no retrieval path writes state or reveals filtered content.

### Rollout

Keep embeddings out of scope and validate against the existing lexical suite plus new collection fixtures.

## Acceptance

- [ ] Search and context support exact collection, source, resource-kind, sensitivity, date, and local-path filters.
- [ ] Shared membership cannot duplicate a resource within one result page.
- [ ] Sensitivity is enforced before snippets, rendering, and relation expansion.
- [ ] Linked resources remain separate searchable results with typed relation context.
- [ ] Existing unfiltered FTS behavior and exact-token queries remain compatible.

## Done summary

## Evidence
