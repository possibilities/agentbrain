## Description

**Size:** M
**Files:** apps/scrapectl/scrapectl/schemas.py, apps/scrapectl/scrapectl/cli.py, apps/scrapectl/scrapectl/run_fetch_markdown.py, apps/scrapectl/scrapectl/handlers/x.py, apps/scrapectl/tests/test_handler_options.py, apps/scrapectl/tests/test_x_links.py, apps/scrapectl/tests/fixtures/

### Approach

Add one versioned CLI result that normalizes generic, X tweet, and X article extraction into bounded content, typed artifacts, metadata, requested/final URL evidence, typed outbound relations, extractor versions, hashes, and stable failure classes. Provider-specific models remain inside Scrapectl and existing presets remain the extraction implementation.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `apps/scrapectl/scrapectl/run_fetch_markdown.py:1` — current JSON/Markdown output modes.
- `apps/scrapectl/scrapectl/schemas.py:197-275` — typed X timeline/result patterns.
- `apps/scrapectl/scrapectl/handlers/x.py:1128-1309` — bounded X discovery and warnings.
- `apps/scrapectl/tests/test_x_links.py:1` — expected X link filtering.

**Optional** (reference as needed):
- `apps/scrapectl/config/presets/x-tweet.yaml:1-9` — provider configuration boundary.

### Risks

Envelope fields can accidentally expose cookies/provider payloads or misclassify partial success. Output containing large Markdown must remain bounded without truncating into false success.

### Test notes

Convert recorded generic/X fixtures through the envelope, cover empty links, articles, redirects, malformed provider output, output limits, cancellation, and every failure class.

### Detailed phases

1. Define discriminated success/failure schemas and CLI mode.
2. Adapt existing handlers into provider-neutral metadata and relations.
3. Add contract fixtures and failure-class tests.

### Alternatives

Passing through arbitrary structured JSON is rejected because it couples Agentbrain to provider schemas.

### Non-functional targets

The command uses explicit bounded output, deterministic serialization, sanitized diagnostics, and no change to standalone Markdown extraction behavior.

### Rollout

Add the new contract alongside existing scrape-only modes until Agentbrain consumers land; no Agentbrain queue mutation occurs in this task.

## Acceptance

- [ ] Generic pages, X posts, and X Articles produce the same versioned top-level envelope shape.
- [ ] Outbound relations contain only typed eligible destinations and exclude profile, media, analytics, and navigation links.
- [ ] Every operational failure class is machine-readable and carries bounded sanitized evidence.
- [ ] Unknown provider fields cannot leak into the Agentbrain-facing domain payload.
- [ ] Existing offline Scrapectl suites and corpus fixtures pass without browser or network access.

## Done summary

## Evidence
