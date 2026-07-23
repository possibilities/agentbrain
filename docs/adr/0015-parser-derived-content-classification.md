# ADR 0015: Persist parser-derived content classification

## Context

A source URL identifies a Resource but does not reliably identify the rendered content form. In particular, an X `/status/` URL may render a single post, a same-author thread, or an X Article. Agentbrain historically canonicalized all status URLs as `source_type=tweet`; Agentscrape preserved its extractor identity in provenance, but post-versus-thread classification was not durable or filterable. Inferring a thread later from Markdown separators is brittle and unsuitable as a UI facet.

## Decision

Agentscrape's schema-v1 success metadata may include these optional fields:

- `content_kind`: `post`, `thread`, or `article`;
- `content_item_count`: a positive integer, equal to one for posts and Articles and at least two for threads.

The two fields are emitted together. Existing envelopes without them remain valid. X tweet extraction derives the values from the structured `TweetThread.tweets` array; quoted posts do not increase the count. X Article extraction emits `article` with one item. The broad existing `content_type` and extractor identity retain their current meanings.

Agentbrain validates the optional pair against the extractor, persists it as typed `documents.content_kind` and `documents.content_item_count` columns, returns both fields from search/context/get surfaces, and supports exact `--content-kind` filtering in search and context. Source type and Resource identity remain unchanged: classification describes parsed content, not locator identity.

`null` means legacy or not yet classified. Schema migration backfills Articles only when existing URL-extraction provenance identifies `x-article` or `content_type=article`. It does not guess post versus thread from stored Markdown; those documents require parser-backed re-extraction for authoritative classification.

## Consequences

- Agents and future UI clients receive a stable, indexed facet without parsing content or provider URLs.
- Status-form X Articles are distinguishable even though their source identity remains `tweet`.
- Historical promotion records remain replayable because the new metadata keys are optional.
- Agentbrain's consumer support must deploy before Agentscrape begins emitting the additive keys; Agentbrain intentionally rejects unknown envelope fields.
- Read-only commands do not migrate. Deployment must let the writable Worker complete schema v12 migration before serving reads.
- Rolling Agentbrain back after migration requires the matching pre-v12 database backup; switching only the binary would leave the older reader facing a newer schema.
- Legacy X documents remain explicitly unclassified until trustworthy parser evidence is available.
