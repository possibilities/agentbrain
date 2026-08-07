# ADR 0019: Deletion purges the resource and redacts its locator

- Status: Accepted
- Date: 2026-08-07

## Context

`agentbrain delete` removed a document, its chunks, and its FTS rows. Everything
else that ingesting the thing had created stayed: the Resource identity and its
aliases, provenance, collection memberships, the Artifact registration and the
extracted bytes on disk, and the job whose immutable intent carries the URL.

The gap is not academic. After deleting a document, `jobs show --reveal-content`
still prints the URL, the extracted content is still readable from the Artifact
store, and the database already holds thousands of Resource rows whose document
is gone. An operator who deletes something reasonably concludes it is gone; what
they actually got was a document that no longer answers searches.

[ADR 0003](0003-agentbrain-owns-durable-ingestion.md) states that a job is
immutable intent, and [ADR 0004](0004-durable-ingestion-job-lifecycle.md) that
operator actions preserve history and never erase prior attempt outcomes. Those
decisions were made about *execution*: retry must not rewrite what happened, and
disposition must remain auditable. They were not a decision that a locator an
operator asked to be forgotten is retained forever, which is the reading that a
literal application of "immutable intent" would produce.

## Decision

- **Deleting a document purges the Resource it materialized.** The document,
  its chunks and FTS rows, and the Resource row go, and the schema's existing
  cascades take aliases, Artifact registrations, collection memberships,
  provenance, relations, and observations with it. Deletion is no longer a
  narrower operation than the ingestion that created the state.
- **The job's locator is redacted; the job is not deleted.** Job, attempt, and
  transition rows survive with their states, timings, failure classes, and
  outcomes intact, so the lifecycle history ADR 0004 protects is unchanged. What
  is removed from the intent is the content-bearing part: the locator, any text
  payload, and the title. The record that an ingestion happened, and how it
  went, is history; the address of the thing ingested is the content itself.
- **The idempotency key and intent hash are retained.** They are one-way digests
  that disclose nothing, and dropping them would make replay behavior depend on
  whether an unrelated document had been deleted.
- **Artifact bytes are removed only after SQLite says they are unreferenced.**
  A registration is removed with its Resource; the bytes are unlinked only when
  no remaining Resource references that Artifact and nothing derives from it.
  Shared content-addressed bytes therefore survive deletion of one of their
  referents.
- **SQLite commits before any byte is unlinked.** ADR 0008 already establishes
  that the two stores cannot commit together. Ordering the durable delete first
  means a crash leaves unreferenced bytes, which reconciliation already collects;
  the reverse order would leave a registration pointing at nothing.
- **Deletion stays single, explicit, and confirmed.** One document per
  invocation, an explicit selector, and the literal `--confirm delete` token.
  Purging more per call would make the blast radius of a typo larger than the
  operation it names.

## Consequences

- Delete means the thing is gone: not searchable, not addressable, its bytes
  reclaimed unless shared, and its URL no longer recoverable from the ledger.
- The ingestion ledger stops being a durable record of locators an operator
  asked to forget, while remaining a complete record of ingestion activity.
- A redacted job cannot be re-executed from its intent. This is correct — its
  content was deleted on purpose — and it is not a regression, because
  re-submitting the same URL derives a fresh key and admits a new job.
- Deletion now touches the Artifact store, so it is no longer a pure SQLite
  operation, and a caller that wants bytes reclaimed must supply the store.
- Reconciliation remains the backstop for bytes orphaned by an interrupted
  delete, unchanged.

## Related

- [ADR 0003: Agentbrain owns durable ingestion](0003-agentbrain-owns-durable-ingestion.md)
- [ADR 0004: Durable ingestion job lifecycle](0004-durable-ingestion-job-lifecycle.md)
- [ADR 0008: Content-addressed Artifact storage](0008-content-addressed-artifact-storage.md)
- [ADR 0012: Local security and sensitive ingestion](0012-local-security-and-sensitive-ingestion.md)
