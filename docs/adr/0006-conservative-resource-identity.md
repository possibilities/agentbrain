# ADR 0006: Conservative resource identity

- Status: Accepted
- Date: 2026-07-18

## Context

Agentbrain must reconcile exact legacy Linkctl URLs, current normalized URL identities, X status and article aliases, redirects, publisher canonical declarations, repeated discoveries, and immutable content artifacts. Treating every observed URL as distinct creates avoidable duplicates, but automatically merging by redirect target, canonical declaration, title, or content digest can irreversibly combine resources with different semantics or provenance.

The recovered catalog also contains ordered `link-NNNNN` identities that describe historical collection position rather than the identity of the linked item. Migration must retain that evidence without making an unstable list position the modern primary key.

## Decision

- **Every resource has a typed resource key.** Trustworthy provider identities are preferred, including `x:status:<id>`, `x:article:<id>`, and stable provider account IDs. Generic web resources use `url:<conservatively-normalized-url>`.
- **Generic URL normalization is conservative.** It lowercases scheme and host, removes default ports and fragments, and preserves path and query semantics. Domain-specific query removal requires an explicit, tested rule rather than a global heuristic.
- **Observed URL roles remain distinct.** Submitted, normalized, redirect-resolved, publisher-canonical, and historical URLs are stored as typed aliases or observations with evidence and timestamps.
- **An alias is not automatic merge proof.** Redirect destinations, publisher canonical declarations, matching titles, and equal artifact digests do not by themselves collapse two existing resources.
- **Known provider identity may converge aliases.** Equivalent X URL forms carrying the same status or article ID resolve to one provider-keyed resource. Other convergence requires explicit, auditable reconciliation.
- **Under-merging is preferred to false merging.** Duplicate resources can be reconciled later while retaining evidence; an incorrect destructive merge can lose independent provenance and refresh semantics.
- **Artifact digests identify bytes, not resources.** Equal content may be attached to distinct resources, and one resource may have multiple artifacts over time.
- **Legacy exact URLs remain first-class evidence.** Migration preserves the exact submitted string even when it also records a normalized lookup alias.
- **Legacy positional IDs remain external identifiers.** `link-NNNNN`, catalog position, and ordered membership are attached to the legacy collection observation or membership, not used as resource keys.
- **Historical classifications remain raw provenance.** Legacy source types, tags, summaries, notes, and `source=linkctl` values are retained alongside mapped modern kinds and collections.
- **Idempotent admission uses typed intent and resource identity.** Repeated equivalent submissions may identify an existing job or resource without erasing the new ingress observation or requested URL.

## Consequences

- X aliases converge reliably while generic web identity remains intentionally cautious.
- Search and retrieval may temporarily expose near-duplicate generic resources until reconciliation policy is implemented.
- The schema needs resource keys, typed URI aliases, historical external identifiers, ordered collection membership, and auditable reconciliation evidence.
- Recovery import can preserve exact catalog semantics while indexing against stable modern identities.
- Content-addressed artifact storage can deduplicate bytes without forcing resource deduplication.
- Redirect and canonical metadata remain useful for ranking, display, and later reconciliation without becoming irreversible identity policy.

## Related

This refines the resource model in [ADR 0003](0003-agentbrain-owns-durable-ingestion.md) and the idempotent admission contract in [ADR 0005](0005-public-ingestion-admission-contract.md). See [`CONTEXT.md`](../../CONTEXT.md) for resource, resource key, alias, artifact, and provenance terminology.
