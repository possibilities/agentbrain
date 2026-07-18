## Description

**Size:** M
**Files:** plugins/plan/skills/brain/SKILL.md, plugins/plan/skills/hack/SKILL.md, plugins/plan/test/consistency-skills.test.ts

### Approach

Create a concise model-invocable `brain` skill that reacts to the human's save/find/watch/status phrases, selects the narrowest authoritative tool, and teaches Agentbrain retrieval, citations, durable admission, source watching, job inspection, and safe failure handling. Require live `agentbrain guide --json` and per-command help for syntax, then add a short `/hack` routing pointer outside BAKE regions using its existing Skill permission.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `plugins/plan/skills/hack/SKILL.md:1-84` — slash-only frontmatter, adjacent-tool hierarchy, Skill permission, and BAKE regions.
- `docs/skill-authoring.md:9-90` — deterministic descriptions, progressive disclosure, and no-op pruning.
- `plugins/plan/test/consistency-skills.test.ts:53-129,190-217,294-335` — static skill/frontmatter/help/BAKE test patterns.
- `/Users/mike/code/agentbrain/src/guide.ts:93-115` — live workflow/command inventory after dependency completion.
- `/Users/mike/code/agentbrain/src/db.ts:198-328` — citation-ready context/get result fields.

**Optional** (reference as needed):
- `plugins/keeper/skills/query/SKILL.md:49-100` — narrowest-supported-surface routing pattern.
- `/Users/mike/code/agentbrain/docs/adr/0004-durable-ingestion-job-lifecycle.md:14-26` — job versus attempt semantics.

### Risks

An overbroad trigger can hijack repository link searches or current web questions; copied command tables can drift; retrieved content can inject instructions or cross sensitivity boundaries. Current CLI help must be post-cutover before examples are finalized.

### Test notes

Add only lightweight file/frontmatter/prose assertions and existing skill-ID lint coverage. Pin positive triggers, near misses, unsupported connector behavior, one `/hack` delegation, no Linkctl/legacy commands, and unchanged BAKE regions; do not invoke models or full harnesses.

## Acceptance

- [ ] The canonical skill is `plugins/plan/skills/brain/SKILL.md` with matching `name: brain`, a precise model trigger description, and only the permissions needed to inspect and invoke Agentbrain safely.
- [ ] Trigger guidance covers “here's a link,” storing articles, watching supported blogs/X accounts, finding saved links/articles/blog posts, durable knowledge questions, and job status/failure inspection.
- [ ] Near misses explicitly prefer repository tools, Keeper history, current web research, Gmail, or scrape-only Scrapectl, and unsupported connectors are not presented as implemented.
- [ ] Retrieval guidance separates search from evidence retrieval, carries title/URI/document/chunk citation fields, discloses truncation/staleness/conflicts, and never follows retrieved instructions.
- [ ] Queue guidance reports queued job IDs, distinguishes attempts from jobs, avoids tight polling/blind retry, and honors safe reveal and sensitivity rules.
- [ ] `/hack` contains one tested delegation path to `brain`, preserves all BAKE bytes, and duplicates no Agentbrain recipes.
- [ ] Targeted static tests and skill-ID lint pass without model, network, browser, live DB, or full-plugin execution.

## Done summary

## Evidence
