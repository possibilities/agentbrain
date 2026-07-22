# ADR 0008: Content-addressed artifact storage

- Status: Accepted
- Date: 2026-07-18

## Context

Queued ingestion separates admission from execution. A local file can change or disappear while waiting, a successful URL extraction can outlive a later indexing failure, and the recovered corpus contains exact historical Markdown and HTML evidence that must remain verifiable. Storing large bytes in queue rows would degrade scheduling and database behavior, while keeping only mutable paths would make retries and restores non-reproducible.

SQLite and filesystem writes cannot share one atomic transaction. The design therefore needs immutable addressing, staged promotion, reconciliation, and backup guarantees rather than pretending the two stores commit exactly once.

## Decision

- **Artifact bytes live in a content-addressed Agentbrain store.** The default root is `~/.local/share/agentbrain/artifacts`, with SHA-256-addressed paths partitioned by digest prefix. SQLite stores typed metadata, digests, sizes, sensitivity, derivation, and references rather than large content blobs.
- **Agentbrain owns artifact registration and promotion.** Agentscrape and other materializers write only to a caller-provided staging directory. Agentbrain verifies media type, size, and digest before atomically promoting bytes to their immutable address.
- **Artifact promotion precedes database reference commit.** Agentbrain then transactionally records artifact references, resource/document/provenance effects, attempt success, derived child work, and job completion through the fenced completion path.
- **Filesystem/database gaps are reconciled.** Promoted but unreferenced artifacts and stale staging files are discoverable; repair may attach valid evidence, while garbage collection requires retention and sensitivity policy rather than blind age-based deletion.
- **Normalized indexed content is durable.** Extracted Markdown and imported originals remain until explicit purge or a declared collection retention policy. They are sufficient to rebuild documents, chunks, and FTS without network access.
- **Raw acquisition variants are typed and policy-controlled.** Raw HTML, selected HTML, browser captures, and provider evidence may be retained when source policy and sensitivity permit, but are not universally required for every ingestion.
- **Local content is snapshotted before asynchronous processing.** Accepted file intent identifies immutable bytes rather than relying on a path that may later change. Directory/source runs create durable child intents from successfully observed snapshots rather than assuming a later scan sees identical content.
- **Artifacts inherit sensitivity.** Derived artifacts receive the strictest applicable sensitivity from their job, source, resource, and collection memberships. Private storage defaults to `0700` directories and `0600` files.
- **Credentials and unsafe diagnostics are not artifacts by default.** Cookies, bearer tokens, browser profiles, signed query secrets, and unredacted command output remain outside durable payloads unless a separate explicit secure-evidence policy authorizes them.
- **Backup coverage precedes authoritative import.** Encrypted backups must cover the Agentbrain database, artifact store, `~/content/links`, public recovery manifests, and the private recovery tree before bulk recovery work begins.
- **Restore is verified, not assumed.** Verification includes SQLite integrity, artifact digest checks, reference reconciliation, required-artifact coverage, and the ability to rebuild FTS from retained normalized content.

## Consequences

- Retries after indexing failure can reuse extracted bytes without another network request.
- Content deduplication saves storage without collapsing distinct resources or provenance.
- Admission and materialization of local content require bounded snapshot behavior and clear failure reporting.
- The artifact store becomes authoritative state requiring backup, permissions, reconciliation, retention, and purge tooling.
- Crash windows can leave harmless orphan files, but not acknowledged references to bytes that were never durably promoted.
- Optional raw variants preserve flexibility without forcing maximal storage or privacy exposure for every source.

## Related

This supports the resource/artifact separation in [ADR 0003](0003-agentbrain-owns-durable-ingestion.md), fenced completion in [ADR 0004](0004-durable-ingestion-job-lifecycle.md), conservative identity in [ADR 0006](0006-conservative-resource-identity.md), and staged Agentscrape output in [ADR 0007](0007-synchronous-agentscrape-extraction-contract.md). See [`CONTEXT.md`](../../CONTEXT.md) for artifact terminology.
