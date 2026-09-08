---
name: brain
description: >-
  Find previously saved articles, papers, threads, and notes with agentbrain;
  save sources and check ingestion outcomes. Use for prior reading and local
  research context; use chats for past agent conversations.
---

# Brain — saved research

Use Agentbrain's MCP tools through Executor to retrieve collected sources and
admit new material to the research library. Discover tools in the `agentbrain`
namespace and inspect their current input schemas; `guide` supplies the domain
contract when more detail is needed. Tool paths include deployment-specific
connections, so use the discovered path.

The local index is useful context, especially for prior reading and recurring
subjects. It is not a freshness check or a prerequisite before every network
read. Follow the user's requested sources, search the live web when current
information matters, and open relevant links while investigating. Use `chats`
for past conversations and `wiki` for authored documents.

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

With Executor, a successful tool call's `data` is the upstream MCP result;
read its `structuredContent` for the Agentbrain envelope. On `mcp_tool_error`,
the separate JSON text block in `error.details.content` preserves the original
error code and recovery. Check the domain result before claiming success.

Use the supported tools for the index. Do not open or mutate the research
database directly: a stray write can corrupt its FTS index. A missing index
is distinct from an empty search. Installation and worker repairs belong in
their owning repositories and supported installers, not a second worker
started alongside the managed one.
