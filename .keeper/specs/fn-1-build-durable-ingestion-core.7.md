## Description

**Size:** M
**Files:** scripts/install.sh, system/Library/LaunchAgents/agentbrain.worker.plist, test/install.test.ts, README.md

### Approach

Install one user LaunchAgent for `agentbrain worker`, with deterministic paths, private logs, graceful unload/reload, and stale-service cleanup. Document admission, operation, repair, and rollback without enabling recurring remote sources yet.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `scripts/install.sh:1` — current owned-link installer behavior.
- `test/install.test.ts:1` — installer isolation and ownership tests.
- `/Users/mike/code/arthack/system/launchagents/Library/LaunchAgents/arthack.scrapectl.process-queue.plist:5-29` — existing QueueDirectories service reference, not an ownership template.

**Optional** (reference as needed):
- `README.md:1` — current architecture and command overview.

### Risks

Hard-coded checkout paths, duplicate workers, broad log permissions, or unload races can leave stale claims or silently disable ingestion.

### Test notes

Render/plutil-check the plist in a temporary HOME, assert idempotent install/uninstall ownership, and run the worker against a temporary DB without launchd.

### Detailed phases

1. Add service plist and install/uninstall ownership.
2. Add singleton startup and safe log/state locations.
3. Update forward-facing README and install tests.

### Alternatives

Reusing Scrapectl's QueueDirectories watcher is rejected because Agentbrain jobs live in SQLite and include non-URL work.

### Non-functional targets

Install is idempotent, never deletes foreign links/services, preserves private permissions, and leaves source scheduling disabled by default.

### Rollout

Install only after temporary-DB smoke passes; unload and revert the service before restoring a pre-migration snapshot if rollback is needed.

## Acceptance

- [ ] Installation creates exactly one owned user service invoking the installed Agentbrain worker.
- [ ] Reinstall and uninstall are idempotent and cannot remove foreign files or services.
- [ ] Service logs and state use private locations and contain no content-bearing arguments.
- [ ] Plist validation and offline worker smoke pass without a browser farm or network.
- [ ] README and help accurately describe implemented queue ownership and explicitly defer remote source activation.

## Done summary

## Evidence
