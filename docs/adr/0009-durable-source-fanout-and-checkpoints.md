# ADR 0009: Durable source fanout and checkpoints

- Status: Accepted
- Date: 2026-07-18

## Context

X posts and recurring sources discover additional resources after their own work begins. The previous X path indexed a root and attempted children synchronously, producing root-first partial responses whose failed children had no independent queue lifecycle. Recurring source discovery adds another crash boundary: advancing a checkpoint before discovered work is durable can permanently skip items, while waiting for every child extraction to complete would make polling unnecessarily slow and fragile.

Discovery surfaces are also incomplete. X timeline pagination may return warnings or a diagnostic oldest item that is not a seekable historical cursor, and RSS/timeline windows omit older entries without proving deletion. Fanout policy therefore must distinguish durable admission, extraction completion, suppression, and deletion evidence.

## Decision

- **Scrapectl emits authoritative typed outbound relations.** Supported automatic classes begin with `content_link`, `article`, and `quoted_post`; reply and repost relations require intentional provider support rather than generic URL guessing.
- **Eligible X children are bounded.** External HTTP(S) destinations, X Articles, and quoted X posts may be admitted automatically. Profiles, author chrome, media assets, analytics, and navigation are excluded.
- **Automatic fanout remains one hop and is capped at 25 eligible children per root.** A child created through fanout does not recursively create another automatic content-link layer.
- **Suppression is durable.** Discoveries omitted by type policy, safety policy, duplication, or the fanout cap are recorded as observations with a reason and ordering evidence rather than silently discarded.
- **Shared destinations retain all provenance.** Equivalent destination intent may reuse one active or completed acquisition job and one resource while each parent relation and discovery observation remains independently recorded.
- **Parent completion does not await child completion.** A parent job completes after its own resource is indexed and every eligible child intent, relation, or suppression is durably committed. Child extraction and terminal outcomes remain independent jobs.
- **Source checkpoints advance after durable fanout.** A committed discovery window may advance only after every discovered item is durably admitted, explicitly recognized as existing equivalent intent, or durably suppressed according to policy.
- **Checkpoint and pagination cursor are distinct.** In-progress provider cursors may support one run, while a stable high-water identifier anchors incremental recovery across runs.
- **Partial discovery blocks unsafe advancement.** Provider warnings, truncated traversal, malformed pages, or uncertain boundaries retain run evidence but do not advance past an unproven checkpoint.
- **Forward X polling uses stable post IDs.** `since_id` is the incremental checkpoint. Historical backfill uses separate state and cannot claim resumable completeness until Scrapectl exposes a genuinely seekable older-page contract.
- **Absence is not deletion.** Missing items from bounded feeds, timelines, or partial discovery responses do not remove resources or collection membership. Explicit upstream tombstones or a source-specific authoritative deletion signal are required.
- **No-new-content runs may succeed.** A complete discovery run that proves no newer items may update health and observation timestamps without manufacturing jobs.

## Consequences

- Saved X roots complete promptly while linked destinations remain durable and inspectable.
- Child failures no longer require replaying or re-scraping the parent.
- Source polling can advance after queue durability instead of waiting for potentially slow extraction.
- The schema needs source runs, checkpoints, observations, typed relations, parent/child jobs, and suppression records.
- X deep backfill remains explicitly incomplete until extractor-side historical pagination exists.
- Retrieval can navigate parent and child resources without concatenating their content or provenance.

## Related

This applies transactional derived work from [ADR 0003](0003-agentbrain-owns-durable-ingestion.md), job completion semantics from [ADR 0004](0004-durable-ingestion-job-lifecycle.md), conservative identity from [ADR 0006](0006-conservative-resource-identity.md), and the Scrapectl envelope from [ADR 0007](0007-synchronous-scrapectl-extraction-contract.md). See [`CONTEXT.md`](../../CONTEXT.md) for observation and checkpoint terminology.
