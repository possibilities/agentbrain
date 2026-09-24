---
name: brain
description: >-
  Find previously saved articles, papers, threads, and notes with agentbrain;
  save sources and check ingestion outcomes. Use for prior reading and local
  research context.
---

# Brain — saved research

Use the `agentbrain` MCP server directly. Select the tool from the harness's
catalog or tool search, inspect its input schema, and call it with JSON
arguments. The host may prefix tool names with the server name. `guide`
provides the installed command contract and recovery guidance.
Retrieve collected sources and admit new material to the research library.

The local index is useful context, especially for prior reading and recurring
subjects. It is not a freshness check or a prerequisite before every network
read. Follow the user's requested sources, search the live web when current
information matters, and open relevant links while investigating. Use `wiki`
for authored documents.

## Retrieve evidence

Choose the reading shape that fits the question:

- `context` returns bounded chunks with citation metadata in one call. For
  example: `{"query":"agent memory","limit":6,"max-chars":12000}`.
- `search` ranks candidate chunks; retrieve the promising ones with `get`.
  Use `{"document-id":782,"char-limit":12000}` for a bounded document,
  `{"chunk-id":11246}` for one chunk, or `{"source-uri":"https://example.com/article"}`
  for a known source. Use actual IDs returned by retrieval.

Search results already arrive in relevance order. `mode: "any"` combines
terms with OR; use `all` to narrow or `raw` for deliberate FTS5 syntax. Filters
such as tag, collection, source, and update date help when the relevant value
is known. Follow `next_offset` for another page. Update dates describe the
indexed document; they do not prove the underlying claim is still current.

One empty query supports “no matches for this query,” not “we never saved it.”
Try a distinctive title, author, or alternate wording when prior material is
expected. Check `stats`, `tags`, or source status when an empty result suggests
an inventory or ingestion problem. This investigation need not delay useful
outside research.

Keep `document_id`, `chunk_id`, title, source URI, and the actual excerpt in
working evidence. Cite the source title and link in the answer; keep opaque
identifiers out of spoken prose. Respect the source's sensitivity when moving
material into another document or external service.

## Save and confirm

`submit` is the admission boundary for URLs, local files, directories, and
literal text. Use absolute local paths because the shared MCP server does not
inherit this session's cwd. For a worthwhile source, an example request is:

```json
{"source":"https://example.com/article","collection":["saved-links"],"tag":["agent-memory"],"notes":"Relevant to the prompting review"}
```

Admission and indexing are separate. A URL admission queues work without
fetching it; local bytes are snapshotted before acknowledgement. The resident
worker later extracts and indexes material through Agentscrape.

- `queued` means a durable job exists; retain its `job_id`.
- `duplicate` means the equivalent intent already exists; do not resubmit it.
- `already_indexed` supplies a materialized document to retrieve immediately.

Inspect `jobs_show` or use a bounded admission wait when the task needs indexing
confirmed. `wait_status: "timeout"` leaves the admitted job recoverable; it is
not a failed submission. Do not claim content is searchable merely because
admission succeeded.

For ingestion failures, recurring-source runs, and sensitive job inspection,
read [ingestion and recovery](references/ingestion.md).

## Results and boundaries

Inspect MCP `isError` and Agentbrain's `{schema_version, ok, error, data}`
envelope in `structuredContent`. If the host returns only content blocks,
parse the standalone JSON block and keep diagnostic prose separate. Read
`error.code` and `recovery` before retrying or claiming success.

Use the supported tools for the index. Do not open or mutate the research
database directly: a stray write can corrupt its FTS index. A missing index
is distinct from an empty search. Installation and worker repairs belong in
their owning repositories and supported installers, not a second worker
started alongside the managed one.
