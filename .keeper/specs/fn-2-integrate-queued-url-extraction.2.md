## Description

**Size:** M
**Files:** src/scrapectl.ts, src/worker.ts, src/artifacts.ts, src/types.ts, src/sanitize.ts, test/scrapectl.test.ts, test/worker.test.ts

### Approach

Add the URL-job worker materializer that invokes the versioned Scrapectl command with explicit argv and caller-owned staging, validates the envelope, promotes artifacts, maps failure classes to the durable lifecycle, and commits resources/documents/provenance through the fenced completion path. Remove any direct synchronous URL write from public ingestion while preserving syntactic identity helpers only.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/scrapectl.ts:18-48` — current provider typing and retry classification.
- `src/scrapectl.ts:233-248` — explicit argv subprocess pattern.
- `test/source-boundary.test.ts:16-36` — forbidden network implementation guard.
- `docs/adr/0007-synchronous-scrapectl-extraction-contract.md:1` — locked contract ownership.

**Optional** (reference as needed):
- `src/url.ts:1-79` — identity-only URL helpers that remain local.

### Risks

Process timeout, signal propagation, malformed output, stale leases, and artifact promotion failure cross different failure domains. A retry must reuse a valid extracted artifact after index failure instead of unnecessarily scraping again.

### Test notes

Use fake PATH Scrapectl executables for all success/failure/protocol/cancellation cases and assert no network primitive enters production source.

### Detailed phases

1. Implement bounded subprocess/envelope validation and staging.
2. Map classifications into attempts, retries, blocked and failed jobs.
3. Add idempotent artifact reuse and fenced resource completion.

### Alternatives

Submitting another Scrapectl queue job is rejected because it recreates split queue authority.

### Non-functional targets

No external process runs inside a SQLite transaction; stdout, stderr, runtime, content, and staging are bounded and sanitized.

### Rollout

Keep execution behind the Agentbrain worker and temporary databases until protocol fixtures pass in both repos.

## Acceptance

- [ ] A queued URL job invokes only the versioned Scrapectl extraction command and completes through its current fencing token.
- [ ] Infrastructure, item, auth/config, permanent, policy, cancellation, and protocol outcomes map to the accepted job states.
- [ ] Index failure after successful extraction reuses the promoted artifact on retry without mandatory refetch.
- [ ] Malformed or unknown envelopes fail visibly without fallback parsing or direct URL transport.
- [ ] Production Agentbrain source remains free of HTTP, DNS, socket, browser, and provider-schema implementation.

## Done summary

## Evidence
