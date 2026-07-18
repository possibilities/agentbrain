## Description

**Size:** M
**Files:** src/behaviors/save-links.ts, src/cli.ts, test/behavior_core.test.ts, README.md, docs/behaviors.md

### Approach

Replace `linkctl add-link` with explicit-argv `agentbrain submit --kind url --ingress agentbot --collection saved-links`. Parse the versioned queued/duplicate success envelope, preserve one acknowledgement covering all message URLs, and fail loudly on invalid/mismatched command output without importing sibling code.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/behaviors/save-links.ts:4-45` — current Linkctl loop and user response.
- `src/behaviors/save-links.ts:57-73` — strict JSON-object parsing.
- `test/behavior_core.test.ts:111-167` — injected command and exact argv tests.
- `CLAUDE.md:3-14` — no sibling source imports and deterministic dependency injection.

**Optional** (reference as needed):
- `docs/behaviors.md:24-65` — current documented external contract.

### Risks

Duplicate semantics change from exit 1 to exit 0, and a partial multi-URL submission can leave some durable jobs before a later malformed response.

### Test notes

Cover all queued, all duplicate, mixed, invalid JSON, wrong envelope version, conflicting idempotency, nonzero admission failure, and metadata output.

### Detailed phases

1. Replace argv and result parser.
2. Preserve aggregate user text and saved/skipped metadata.
3. Update deterministic tests and forward-facing docs.

### Alternatives

Direct Scrapectl submission is rejected because Agentbrain owns admission and collection intent.

### Non-functional targets

No shell invocation, no network in tests, bounded one-command-per-URL behavior, and no private URL content in error logs beyond the already-submitted locator.

### Rollout

Deploy only when `agentbrain submit` is installed; validate with fake CLI first and real Agentbot smoke during epic rollout.

## Acceptance

- [ ] Agentbot invokes only the installed Agentbrain CLI for saved-link admission.
- [ ] Queued and duplicate URLs both produce successful user acknowledgement and correct metadata counts.
- [ ] Malformed, incompatible, or failed Agentbrain output fails the behavior clearly without claiming the URL was saved.
- [ ] Tests assert exact argv and require no live Telegram, Agentbrain database, Scrapectl, or network.
- [ ] Agentbot documentation contains no live Linkctl dependency.

## Done summary

## Evidence
