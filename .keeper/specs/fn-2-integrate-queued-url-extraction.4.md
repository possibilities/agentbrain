## Description

**Size:** M
**Files:** test/source-boundary.test.ts, test/scrapectl.test.ts, test/link-hardening.test.ts, scripts/smoke-scrapectl-url-ingest.sh, README.md, src/help.ts, src/guide.ts

### Approach

Turn the cross-repo protocol, network prohibition, error redaction, cancellation, artifact reuse, and child durability into explicit regression gates. Update the opt-in real smoke to submit a URL into a temporary Agentbrain queue and drain it through the worker rather than invoking synchronous ingestion.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `test/source-boundary.test.ts:16-36` — production-source network guard.
- `test/link-hardening.test.ts:114-198` — existing bounded failures and sanitization.
- `scripts/smoke-scrapectl-url-ingest.sh:1` — current opt-in smoke.
- `README.md:74` — real-provider smoke documentation.

**Optional** (reference as needed):
- `/Users/mike/code/arthack/apps/scrapectl/README.md:420-425` — live X opt-in convention.

### Risks

Tests can accidentally require a live browser farm or accept fixtures that no longer match the producer. Docs can imply the old queue still owns Agentbrain work.

### Test notes

Run both repositories' offline suites with fake executables, then keep a separate explicitly opted-in temporary-state smoke command for the browser farm.

### Detailed phases

1. Add protocol-version and malformed-envelope contract fixtures.
2. Expand source-boundary, sanitization, cancellation, and replay tests.
3. Rewrite smoke/help/README around queued execution.

### Alternatives

A normal-test live backend probe is rejected because reliability and privacy require deterministic offline gates.

### Non-functional targets

Offline checks make zero network calls; the opt-in smoke never touches the live database or source registry.

### Rollout

Run the live smoke only after offline suites pass and a browser farm is available; smoke failure leaves its temporary job evidence for inspection.

## Acceptance

- [ ] Cross-repo fixtures fail clearly on incompatible envelope changes.
- [ ] Boundary tests prohibit every direct Agentbrain web/network implementation and fallback.
- [ ] Errors, logs, and default job output redact content and unsafe diagnostics.
- [ ] The opt-in smoke creates a temporary queued URL job, drains it, verifies searchability, and preserves failed evidence on error.
- [ ] Normal test and check commands require no Scrapectl, browserctl, credentials, or network.

## Done summary
Added offline regression gates for the Scrapectl extraction envelope contract, source/network boundaries, redaction, cancellation, and artifact replay; rewrote the opt-in smoke, README, help, and guide around temporary queued URL admission drained by the worker.
## Evidence
