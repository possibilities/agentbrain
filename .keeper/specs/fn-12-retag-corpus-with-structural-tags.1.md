## Description

**Size:** M
**Files:** src/tagging.ts, src/store.ts, test/tagging.test.ts, test/retag-store.test.ts

### Approach

Add a pure, deterministic tag-derivation function in a new `src/tagging.ts`, plus a targeted retag write method on `ResearchStore`. The derivation function maps a document's structural attributes — `source_type`, URL domain (via the existing `domainFromUri`), and collection slugs — to a small curated set of lowercase structural tags, and unions them with the document's existing tags, always preserving `legacy-recovery` and any pre-existing user tag. It MUST emit tags in a deterministic order (existing tags first in stored order, then structural tags grouped source_type -> domain -> collection, each group sorted), because `normalizeTags` dedupes but does NOT sort — idempotency depends on the derivation's own ordering producing a byte-identical `documents.tags` JSON on re-run.

The store method updates `documents.tags` (serialized via the same `pythonStyleTagJson` the upsert uses — export it rather than hand-rolling a second serializer) and refreshes the denormalized `chunks_fts.tags` for every chunk of the document. `chunks_fts` is a REGULAR fts5 table, so a partial-column `UPDATE ... SET tags=?` is unsafe — delete+reinsert the document's FTS rows (mirroring `deleteDocument`), re-inserting all indexed columns, reading `content` back from the `chunks` table and `title`/`source_uri` from `documents`. Wrap the whole per-document write in one `this.db.transaction(...).immediate()`. Do NOT reuse `upsertDocument` — it re-chunks from re-supplied content.

Curated starting vocabulary (extensible; keep it lean and dot-free):
- source_type: `x` -> `x`, `social`; `url` -> (no source_type tag)
- domain (exact host match, incl. `www.`/`m.` variants): `github.com` and `gist.github.com` -> `github`, `code`; `youtube.com` -> `youtube`, `video`; `reddit.com` -> `reddit`, `social`; any unmapped domain -> (no domain tag)
- collection: each membership slug becomes that slug as a tag (currently only `legacy-links`)

Guard the collection lookup for pre-migration DBs (the `resources` table may be absent and `resources.document_id` may be NULL). Assert/skip any derived tag containing a `.` before it reaches the FTS column.

### Investigation targets

*Verify before relying — planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/store.ts:1117-1274 — `upsertDocument`; the FTS insert column shape (all indexed columns, ~:1240-1259) and `pythonStyleTagJson` usage. DO NOT reuse this heavy path; mirror its column list.
- src/store.ts:1590-1640 — `deleteDocument`; the targeted transactional doc+FTS delete idiom (`DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id=?)`).
- src/store.ts:912 — `pythonStyleTagJson` (NOT exported today; export and reuse).
- src/text.ts:121 — `normalizeTags` (dedupes, does NOT sort).
- src/query.ts:119 — `domainFromUri` (exported; returns the full lowercased hostname, dots included).
- src/db.ts:666-669 — collection join path (documents -> resources -> collection_memberships -> collections.slug).
- test/store.test.ts:140-166 — canonical created/unchanged/updated idempotency test to mirror.

**Optional**:
- src/store.ts:172-190 — chunks + chunks_fts schema (`chunks.content` exists; `chunks_fts` is regular fts5 with UNINDEXED document_id/chunk_id + title/content/tags/source_uri).

### Risks

- FTS index corruption from a partial-column UPDATE on a regular fts5 table — must reinsert all columns.
- Non-idempotent re-run if tag emission order isn't deterministic — `normalizeTags` won't save it (no sort).
- `source_type=x` documents also resolve domain `x.com`; keep the mapping so they don't produce confusing duplicates (dedup covers it, but map deliberately).

### Test notes

Unit-test the derivation across source_type/domain/collection combinations including an unmapped domain, a malformed/non-URL source_uri (`domainFromUri` returns null), a doc with only `legacy-recovery`, and dedup of overlapping tags. Store test: seed a document + chunks, retag, assert both the `documents.tags` JSON and the `chunks_fts.tags` row values, then retag AGAIN and assert zero changes (byte-identical). Include a pre-migration DB case (no `resources` table). Run `bun run check`.

## Acceptance

- [ ] A pure derivation function maps source_type + URL domain + collection slugs to the curated structural-tag set and unions them with a document's existing tags, always preserving `legacy-recovery` and any pre-existing user tags.
- [ ] Derived tags are lowercase, dot-free, and emitted in a deterministic order such that re-deriving yields a byte-identical tag list.
- [ ] A store method writes a document's merged tags to `documents.tags` and refreshes that document's `chunks_fts.tags` rows within a single transaction, keeping the two serializations consistent, without re-chunking.
- [ ] Running the retag write twice on the same document produces no change on the second run, verified by a test.
- [ ] A document is retrievable by a newly derived tag through the existing FTS tag path after retag.
- [ ] The collection lookup is guarded so retag does not crash on a pre-migration database lacking the `resources` table.
- [ ] `bun run check` passes.

## Done summary
Added a deterministic structural-tag derivation (source_type + domain + collection, dot-free, sorted per group) in src/tagging.ts, and a ResearchStore.retagDocument method that syncs documents.tags and chunks_fts.tags in one transaction via delete+reinsert, verified idempotent on re-run and guarded for pre-migration DBs lacking resources.
## Evidence
- Commits: fa84fbe777f5099f422a0794771adc5080eaa258