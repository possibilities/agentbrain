## Description

**Size:** M
**Files:** src/research-ingest-link.ts, src/link-ingest.ts, src/cli.ts, src/help.ts, src/guide.ts, scripts/install.sh, test/install.test.ts, test/link-ingest.test.ts, test/cli.integration.test.ts, README.md

### Approach

Remove `research-ingest-link`, specialized synchronous `ingest-link` admission, bare-JSON/exit-2 compatibility, and installer ownership for retired executables after Agentbot and Scrapectl producers migrate. Preserve reusable extraction-envelope-to-resource logic behind worker internals and keep legacy Linkctl source values readable as provenance.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/research-ingest-link.ts:1` — temporary bare-JSON adapter.
- `src/link-ingest.ts:283-473` — completed root and old partial behavior.
- `src/help.ts:185-206` — current single-item compatibility help.
- `scripts/install.sh:1` — known-link replacement and cleanup ownership.

**Optional** (reference as needed):
- `test/fixtures/prescraped_x_tweet.json:1` — historical Linkctl provenance that remains data.

### Risks

Removing an executable before all queue files migrate loses work; deleting fixture provenance would confuse runtime compatibility with historical evidence.

### Test notes

Assert retired commands are absent, installer removes only links it owns, worker envelope paths still index generic/X resources, and historical source labels remain queryable.

### Detailed phases

1. Remove public compatibility command routing and old exit contracts.
2. Move retained completion logic behind worker-only interfaces.
3. Remove installer links and rewrite tests/docs.

### Alternatives

A hidden alias is rejected because the human explicitly does not require runtime Linkctl compatibility.

### Non-functional targets

Installation remains idempotent and cannot remove foreign executables; no retired adapter can bypass durable jobs.

### Rollout

Delete only after Task 2 reconciliation reports no unresolved supported handoff record.

## Acceptance

- [ ] `research-ingest-link`, public synchronous `ingest-link`, exit-2 partial semantics, and their installer links no longer exist.
- [ ] Every remaining resource write from extracted output occurs through a leased Agentbrain job.
- [ ] Historical Linkctl provenance fixtures remain readable and are explicitly labeled as legacy data.
- [ ] Installer cleanup removes only known owned links and preserves unrelated local binaries.
- [ ] Agentbrain docs/help contain no instruction to use retired adapters.

## Done summary

## Evidence
