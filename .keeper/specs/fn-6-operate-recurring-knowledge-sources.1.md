## Description

**Size:** M
**Files:** apps/scrapectl/scrapectl/handlers/feed.py, apps/scrapectl/scrapectl/schemas.py, apps/scrapectl/scrapectl/cli.py, apps/scrapectl/tests/test_feed_discovery.py, apps/scrapectl/tests/fixtures/feeds/, apps/scrapectl/README.md

### Approach

Add a Scrapectl-owned feed/archive discovery command that parses RSS/Atom stable IDs, dates, canonical candidate URLs, explicit tombstones, validators, warnings, and bounded archive pages into a provider-neutral discovery envelope. Preserve HTTP/browser/security ownership and return partial boundaries honestly.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `apps/scrapectl/scrapectl/cli.py:278-281` — current command registration surface.
- `apps/scrapectl/scrapectl/schemas.py:223-275` — typed timeline discovery result pattern.
- `apps/scrapectl/README.md:121-148,245-268` — current link/nav discovery capabilities and gap.

**Optional** (reference as needed):
- `hermes-greybird@9ca07e5^:bin/research-source-watch:147-375` — historical behavioral evidence only, not reusable ownership.

### Risks

Feed GUIDs can be absent or unstable, archives can loop or contain undated navigation, and malformed XML can cause unsafe checkpoint claims. Provider output may contain signed URLs or private metadata.

### Test notes

Use fixtures for RSS, Atom, GUID/no-GUID, edits, tombstones, duplicate URLs, pagination, invalid XML, archive loops, partial warnings, ETag/Last-Modified, and date cutoffs.

### Detailed phases

1. Define typed feed/archive source options and discovery result.
2. Implement standard feed parsing plus bounded configured archive traversal.
3. Add validators, warnings, stable identities, and comprehensive fixtures.

### Alternatives

An Agentbrain feed client is rejected; generic selector scraping without stable entry semantics is insufficient.

### Non-functional targets

Discovery enforces response/page/item bounds, URL safety, timeout/cancellation, deterministic ordering, and sanitized diagnostics.

### Rollout

Ship the command with fixtures before any Agentbrain source enables it; source-specific archive patterns remain explicit configuration.

## Acceptance

- [ ] RSS and Atom entries expose stable upstream IDs, URLs, publication/update times, and explicit tombstones when present.
- [ ] Configured archive traversal is bounded, loop-safe, date-filterable, and honest about partial discovery.
- [ ] Validators and pagination evidence support incremental polling without treating absence as deletion.
- [ ] Malformed or unsupported sources produce classified bounded failures rather than guessed success.
- [ ] All tests use local fixtures with no browser, credentials, or network.

## Done summary

## Evidence
