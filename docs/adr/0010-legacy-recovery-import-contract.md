# ADR 0010: Legacy recovery import contract

- Status: Accepted
- Date: 2026-07-18

## Context

The recovered corpus combines an ordered Linkctl catalog, local Markdown artifacts, Botctl/Agentbot pipeline evidence, Discord metadata, historical document references, test and infrastructure URLs, and configured-source evidence. These classes do not all express permission to ingest content. Treating every recovered URL as an approved fetch would scrape conversational noise and private-context references, while importing only the available Markdown would discard known provenance, missing work, and review decisions.

The original populated SQLite database is unavailable, so historical row IDs, chunks, timestamps, and relations cannot be recreated exactly. The import needs an explicit, reproducible acceptance contract based on the verified recovery manifest rather than an implied restoration of unknown state.

## Decision

- **Recovery is a queued import run.** The verified manifest and artifact inventory are admitted through Agentbrain's durable ingestion ledger; the importer does not write documents through a bypass path.
- **The manifest has 1,075 authoritative candidate evidence rows.** Import preserves one outcome per candidate even when conservative identity resolution maps aliases to fewer logical resources.
- **The legacy catalog contributes 584 ordered memberships.** Original URL strings, catalog positions, `link-NNNNN` identifiers, summaries, hashes, and available provenance remain attached to the `legacy-links` collection evidence.
- **Exactly 581 approved local artifacts are eligible for offline content ingestion.** They are queued without network access, validated against recorded hashes, and should produce 581 searchable documents when every item validates and indexes successfully.
- **Two probable-test catalog entries remain preserved but excluded.** Their historical membership and evidence remain queryable to operators, while they produce no searchable document by default.
- **Four fetch candidates become blocked review jobs.** This cohort includes the missing `codex-voice` artifact. Import does not fetch them; a human may later retry or exclude each job.
- **Five retry candidates become blocked review jobs.** Their failed save-link pipeline evidence remains attached, with no automatic network retry during recovery import.
- **Ninety-eight human-submitted and 356 Discord-recovered candidates remain reviewable evidence.** They do not automatically create fetch work or searchable documents.
- **Twenty-five infrastructure and all six probable-test candidates remain excluded evidence.** The two probable-test catalog members are counted in both their catalog provenance and the six-candidate exclusion cohort without duplication of candidate rows.
- **Private message bodies are never imported.** Recovery records may retain approved metadata, IDs, timestamps, URLs, hashes, and counts while raw private content stays in the protected recovery tree.
- **Validation failure is isolated per candidate.** Missing bytes, hash mismatch, malformed frontmatter, or parser failure blocks that item with evidence and attempts; it does not roll back successful sibling imports.
- **Import is resumable and idempotent.** Candidate IDs, exact manifest content, importer version, artifact digests, and intent hashes prevent duplicate effects across partial reruns.
- **The run produces durable reconciliation output.** Per-candidate dispositions and aggregate expected-versus-actual counts distinguish completed, blocked, excluded, duplicate, and failed outcomes. A run with unresolved review cohorts may complete as `completed_with_review` without claiming full historical restoration.
- **Historical database references remain evidence, not recreated identities.** Observed old document IDs and aggregate counts are retained as provenance fields; new resource, document, chunk, job, and attempt IDs are native to the rebuilt system.

## Consequences

- The useful 581-item corpus can be restored immediately and entirely offline.
- Every known catalog position and recovery candidate remains accounted for without making every URL searchable or fetchable.
- The resulting resource count need not equal 1,075 because provider identities and aliases may converge conservatively; candidate outcome counts remain exact.
- Operators can review missing and failed saves through the same queue tooling as future ingestion.
- Recovery acceptance is based on reproducible manifests, hashes, and outcomes rather than unverifiable historical row fidelity.
- Backup coverage for the database, artifact store, legacy corpus, manifests, and private recovery evidence is a prerequisite to execution.

## Related

This uses the domain model in [ADR 0003](0003-agentbrain-owns-durable-ingestion.md), identity rules in [ADR 0006](0006-conservative-resource-identity.md), artifact guarantees in [ADR 0008](0008-content-addressed-artifact-storage.md), and job lifecycle in [ADR 0004](0004-durable-ingestion-job-lifecycle.md). See [`CONTEXT.md`](../../CONTEXT.md) for recovery-evidence terminology.
