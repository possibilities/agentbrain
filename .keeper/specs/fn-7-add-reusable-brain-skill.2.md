## Description

**Size:** S
**Files:** scripts/install.sh, tests/test_shared_agent_skill_install.py

### Approach

Extend the existing never-clobber shared-skill installer and cleanup allowlist so Pi receives `~/.pi/agent/skills/brain` pointing at Keeper's canonical plan-plugin skill. Claude requires no extra install because the skill ships in the already-loaded plan plugin. Keep “install every Keeper skill into Pi” explicitly out of scope; incidental Codex installation through the shared helper is not an acceptance requirement.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `scripts/install.sh:158-200` — existing whole-directory, idempotent, never-clobber skill-link helpers.
- `scripts/install.sh:440-468` — cleanup allowlist and Pi/Codex install calls.
- `tests/test_arthack_claude_pick_auto_profile.py:1` — lightweight root-test style.

**Optional** (reference as needed):
- `/Users/mike/code/keeper/scripts/lint-skill-ids.ts:46-79` — canonical directory/frontmatter parity rules.

### Risks

Cleanup can remove foreign skills, a stale symlink can point at the wrong checkout, and testing the complete installer would perform expensive or destructive environment work.

### Test notes

Use a small static or extracted-function temporary-HOME test that verifies the `brain` source/destination, idempotency, and never-clobber behavior. Do not run `scripts/install.sh`, uv sync, plugin rendering, browser work, or network.

## Acceptance

- [ ] The supported installer makes Keeper's canonical `brain` skill available at `~/.pi/agent/skills/brain` without copying or generating a second source.
- [ ] Existing correct links are idempotent, managed stale links are replaceable, and foreign files/directories are never clobbered.
- [ ] Claude availability relies on the existing plan plugin and requires no new Agentbrain plugin or configuration mutation.
- [ ] No broad “all Keeper skills in Pi” migration is introduced.
- [ ] The targeted lightweight installer test passes without executing the full installer, package sync, model, browser, or network.

## Done summary
Wired Pi's global profile to symlink ~/.pi/agent/skills/brain at Keeper's canonical plan-plugin brain skill via the existing never-clobber install_skill_link helper, plus lightweight temp-HOME tests covering fresh install, idempotency, stale-link replacement, and foreign-file preservation.
## Evidence
