## Description

Originating finding F1 (evidence: src/db.ts search(), the
`MIN(chunks_fts.rank) AS score ... GROUP BY d.id` query and the
subsequent per-hit `snippet ... WHERE chunk_id=row.chunk_id` fetch).
The correctness of chunk_id/chunk_index/start_char/end_char depends on
SQLite's rule that bare columns take values from the row producing a
single MIN()/MAX() aggregate. Add a one-line comment at that query in
src/db.ts stating this reliance and warning that adding a second
aggregate, or selecting a bare column, would make the chosen chunk (and
thus the returned snippet/citation) indeterminate. No query or behavior
change.

Files:
- src/db.ts (search() FTS query)

## Acceptance

- [ ] A comment at the search() query names the SQLite single-MIN/MAX bare-column reliance and its effect on chunk selection
- [ ] The comment warns a second aggregate / bare-column select would break it
- [ ] Query results unchanged; existing search/query tests still pass

## Done summary
Documented SQLite single-MIN/MAX bare-column reliance with a warning comment at the search() FTS query in src/db.ts; no query or behavior change.
## Evidence
