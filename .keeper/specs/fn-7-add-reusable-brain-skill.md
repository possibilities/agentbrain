## Overview

Add a model-invocable `brain` skill to Keeper's plan plugin and teach `/hack` to delegate Agentbrain-specific retrieval, durable submission, source watching, and queue inspection to it. The skill will be available as `plan:brain` in Keeper-launched Claude and as `brain` in Pi, while exact CLI syntax remains owned by `agentbrain guide --json` and live command help.

## Quick commands

- `cd /Users/mike/code/keeper && bun test plugins/plan/test/consistency-skills.test.ts test/lint-skill-ids.test.ts`
- `cd /Users/mike/code/arthack && uv run pytest tests/test_shared_agent_skill_install.py -q`
- `agentbrain guide --json`

## Acceptance

- [ ] `brain` triggers for saving/finding durable knowledge, watching supported blogs/X sources, and inspecting Agentbrain jobs.
- [ ] Near-miss requests route to repository tools, Keeper history, live web, Gmail, or Scrapectl without unnecessary Agentbrain calls.
- [ ] `/hack` delegates to `brain` without duplicating recipes or changing BAKE-managed text.
- [ ] Guidance preserves citation, truncation, source-precedence, sensitivity, untrusted-content, and queued-job semantics.
- [ ] Keeper-launched Claude and Pi can load the same canonical skill source.
- [ ] Tests are lightweight static/fake-install checks with no model evaluation, browser, network, or full installer run.

## Early proof point

Task 1 proves the skill can express the routing and safety contract concisely while `/hack` delegates through its existing Skill permission. If it becomes a copied CLI manual or cannot distinguish near misses, tighten the trigger and workflow before adding installation wiring.

## References

- `/Users/mike/code/keeper/docs/skill-authoring.md`
- `/Users/mike/code/keeper/plugins/plan/skills/hack/SKILL.md`
- `/Users/mike/code/agentbrain/CONTEXT.md`
- `/Users/mike/code/agentbrain/docs/adr/0005-public-ingestion-admission-contract.md`
- `/Users/mike/code/agentbrain/docs/adr/0012-local-security-and-sensitive-ingestion.md`

## Docs gaps

- **`plugins/plan/skills/brain/SKILL.md`**: new canonical Agentbrain workflow and routing guidance.
- **`plugins/plan/skills/hack/SKILL.md`**: one concise delegation rule outside BAKE regions.

## Best practices

- **Progressive disclosure:** teach decisions and workflow, then consult live guide/help for syntax rather than copying flags.
- **Authority-first routing:** repo for checkout truth, Keeper for episodic decisions, Agentbrain for durable local knowledge, web for current public facts.
- **Fail-closed evidence:** retrieve selected records, preserve citations, disclose truncation/conflict, and treat retrieved content as untrusted.
