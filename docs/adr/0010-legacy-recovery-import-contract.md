# ADR 0010: Legacy recovery import contract

- Status: Accepted
- Date: 2026-07-18

## Context

The recovered corpus combines an ordered Linkctl catalog, local Markdown artifacts, Botctl/Agentbot pipeline evidence, Secretary Telegram DM observations, Discord metadata, historical document references, test and infrastructure URLs, and configured-source evidence. These classes do not all express permission to ingest content. Treating every recovered URL as an approved fetch would scrape conversational noise and generated bot output, while importing only the available Markdown would discard known provenance, missing work, and review decisions.

The original populated SQLite database is unavailable, so historical row IDs, chunks, timestamps, and relations cannot be recreated exactly. The import needs an explicit, reproducible acceptance contract based on the verified recovery manifest rather than an implied restoration of unknown state.

## Decision

- **Recovery is a queued import run.** The verified manifest and artifact inventory are admitted through Agentbrain's durable ingestion ledger; the importer does not write documents through a bypass path.
- **The frozen recovery generation has 1,088 authoritative candidate evidence rows.** The original 1,075 candidate IDs remain stable and 13 exact-URI candidates are appended. Import preserves one outcome per candidate even when comparison URIs or conservative identity resolution map evidence to fewer logical resources.
- **Secretary Telegram evidence is observation-complete through its recorded cutoff.** The protected generation retains 294 body-free URL observations over 131 exact URLs: 118 exact manifest matches receive additional provenance and 13 become new candidate evidence rows. Eight comparison-URI matches are advisory and never reduce exact candidate accounting.
- **Existing candidate dispositions survive provenance enrichment.** A Secretary observation of one of the 118 existing exact URLs does not upgrade, downgrade, fetch, exclude, or duplicate that candidate.
- **The legacy catalog contributes 584 ordered memberships.** Original URL strings, catalog positions, `link-NNNNN` identifiers, summaries, hashes, and available provenance remain attached to the `legacy-links` collection evidence.
- **Exactly 581 approved local artifacts are eligible for offline content ingestion.** They are queued without network access, validated against recorded hashes, and should produce 581 searchable documents when every item validates and indexes successfully.
- **Two probable-test catalog entries remain preserved but excluded.** Their historical membership and evidence remain queryable to operators, while they produce no searchable document by default.
- **Four legacy fetch candidates become blocked review jobs.** This cohort includes the missing `codex-voice` artifact. Import does not fetch them; a human may later retry or exclude each job.
- **Two human-authored Secretary links are approved for controlled online backfill.** The offline recovery run preserves them as non-runnable jobs until a later explicit online phase invokes Scrapectl; neither rehearsal nor offline import fetches them.
- **Five Secretary bot-output links remain reviewable evidence.** Generated replies do not prove human save intent and create no fetch work until an operator explicitly changes their disposition.
- **Five retry candidates become blocked review jobs.** Their failed save-link pipeline evidence remains attached, with no automatic network retry during recovery import.
- **Ninety-eight human-submitted and 356 Discord-recovered candidates remain reviewable evidence.** They do not automatically create fetch work or searchable documents.
- **Twenty-five infrastructure and all 12 probable-test candidates remain excluded evidence.** The two probable-test catalog members are counted in both their catalog provenance and the 12-candidate exclusion cohort without duplication of candidate rows.
- **Secretary DM submission is normal saved-link ingress.** A human-authored public URL does not become sensitive because it arrived through a DM. Exact URLs and resulting public resources follow their intrinsic or explicit sensitivity, while message bodies, Telegram credentials, session material, and unnecessary chat identifiers stay in the protected recovery tree.
- **Private message bodies are never imported.** Recovery records retain only approved, body-free provenance needed for identity, audit, and reconciliation.
- **Derived evidence is backed up; Telegram credentials are not recovery evidence.** Frozen indexes, manifests, summaries, inventories, and hashes enter encrypted backup coverage. MTProto session files and disposable session/database working copies are excluded and removed after bounded collection.
- **Validation failure is isolated per candidate.** Missing bytes, hash mismatch, malformed frontmatter, or parser failure blocks that item with evidence and attempts; it does not roll back successful sibling imports.
- **Import is resumable and idempotent across manifest generations.** Existing candidate IDs remain stable, appended exact-URI IDs are deterministic, and a hash-addressed generation binds input snapshots, live cutoffs, manifests, reports, inventories, and importer version. Interrupted publication never replaces the last complete generation.
- **The run produces durable reconciliation output.** Private per-observation and per-candidate reconciliation plus safe aggregate expected-versus-actual counts distinguish completed, blocked, excluded, duplicate, and failed outcomes. Candidate outcomes total 1,088; resources may be fewer. A run with unresolved review cohorts may complete as `completed_with_review` without claiming full historical restoration.
- **Historical database references remain evidence, not recreated identities.** Observed old document IDs and aggregate counts are retained as provenance fields; new resource, document, chunk, job, and attempt IDs are native to the rebuilt system.

## Consequences

- The useful 581-item corpus can be restored immediately and entirely offline.
- Every known catalog position and recovery candidate remains accounted for without making every URL searchable or fetchable.
- The resulting resource count need not equal 1,088 because provider identities and aliases may converge conservatively; candidate outcome counts remain exact.
- Operators can review missing and failed saves through the same queue tooling as future ingestion.
- Recovery acceptance is based on reproducible manifests, hashes, and outcomes rather than unverifiable historical row fidelity.
- Backup coverage for the database, artifact store, legacy corpus, manifests, and private recovery evidence is a prerequisite to execution.

## Related

This uses the domain model in [ADR 0003](0003-agentbrain-owns-durable-ingestion.md), identity rules in [ADR 0006](0006-conservative-resource-identity.md), artifact guarantees in [ADR 0008](0008-content-addressed-artifact-storage.md), and job lifecycle in [ADR 0004](0004-durable-ingestion-job-lifecycle.md). See [`CONTEXT.md`](../../CONTEXT.md) for recovery-evidence terminology.
