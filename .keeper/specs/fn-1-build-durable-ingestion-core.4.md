## Description

**Size:** M
**Files:** src/admission.ts, src/ingest.ts, src/args.ts, src/cli.ts, src/help.ts, src/guide.ts, src/types.ts, test/admission.test.ts, test/cli.integration.test.ts

### Approach

Add the versioned `agentbrain submit` contract and route text, file, directory, and existing ingest commands through durable admission. Validate malformed requests before persistence, snapshot accepted local content, hash immutable intent for idempotency, return queued/duplicate success envelopes, and implement `--wait` as observation of the same job.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/ingest.ts:120-183` — synchronous text/file/URL path to replace.
- `src/cli.ts:372-425` — current one-source mutation dispatch.
- `src/args.ts:26-43` — output and database option conventions.
- `docs/adr/0005-public-ingestion-admission-contract.md:1` — locked acknowledgement semantics.

**Optional** (reference as needed):
- `src/completed-link-input.ts:24-120` — bounded payload validation pattern.

### Risks

Compatibility aliases can accidentally retain direct writes. Idempotency-key reuse with changed intent must not be misreported as a harmless duplicate.

### Test notes

Assert exact JSON and human envelopes, exit codes, invalid pre-admission behavior, duplicate identity, mismatched key rejection, `--wait` timeout, and no parser/extractor call before durable creation.

### Detailed phases

1. Define and validate versioned submission intents/results.
2. Persist idempotent jobs and local snapshots.
3. Convert existing public ingestion commands to the same path and add wait behavior.

### Alternatives

Keeping synchronous `ingest` as a fast path is rejected because it violates universal durability.

### Non-functional targets

Admission is bounded, does not perform network work, and acknowledges only after SQLite and required snapshot bytes are durable.

### Rollout

Preserve `ingest` as a queued alias during cutover; specialized completed-link adapters remain until their producer epic migrates.

## Acceptance

- [ ] New valid intent returns exit 0 with queued status and stable job identity only after durable persistence.
- [ ] Equivalent intent returns exit 0 with duplicate status and the existing job; conflicting explicit idempotency reuse fails.
- [ ] Invalid syntax or structurally invalid intent creates no job or artifact.
- [ ] Text, file, directory, and legacy ingest command surfaces cannot directly write documents.
- [ ] `--wait` disconnect or timeout leaves the accepted job active and recoverable.

## Done summary
Added versioned agentbrain submit contract with durable idempotent admission; routed text/file/directory/legacy ingest surfaces through admission with local snapshotting, intent-hash idempotency, queued/duplicate acknowledgements, conflict rejection, and --wait observation.
## Evidence
