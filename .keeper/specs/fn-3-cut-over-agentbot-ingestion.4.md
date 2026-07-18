## Description

**Size:** M
**Files:** apps/linkctl/, pyproject.toml, uv.lock, pnpm-lock.yaml, scripts/install.sh, system/linkctl/, apps/scrapectl/README.md, apps/scrapectl/tests/test_queue_indexing.py

### Approach

Delete the Linkctl app and tests, remove workspace/package/type/lock declarations, remove install/stow wiring and the owned installed symlink/config, and scrub live runtime references. Preserve Git history and leave `~/content/links` plus all catalog/artifact bytes untouched.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `apps/linkctl/linkctl/api.py:10-49` — exact admission and queue behavior now replaced.
- `apps/linkctl/linkctl/helpers.py:11-71` — config and legacy corpus paths that must not be deleted.
- `pyproject.toml:15-79` — workspace/dependency declarations.
- `scripts/install.sh:115-118,527-545` — stow/install wiring.

**Optional** (reference as needed):
- `apps/linkctl/linkctl/run_list_links.py:19-50` — positional legacy semantics preserved by recovery.

### Risks

Broad lockfile/workspace edits can damage unrelated packages, and uninstall cleanup can accidentally delete the corpus or foreign configuration. Historical `.keeper` references are not live dependencies.

### Test notes

Re-lock through normal workspace tooling, run Arthack lint/type/test gates, assert no importable/installed Linkctl command, and verify corpus hashes plus protected alias-file hash remain unchanged.

### Detailed phases

1. Delete app/source/tests and remove workspace declarations.
2. Re-lock and remove install/stow/config ownership.
3. Scrub live docs/tests and verify corpus/non-target invariants.

### Alternatives

Deprecation stubs and aliases are rejected; Git history is sufficient for archaeology.

### Non-functional targets

Root locks remain reproducible, unrelated workspace packages collect, and `/Users/mike/code/arthack/system/zsh/.zsh/aliases/arthack.zsh` remains byte-identical with SHA-256 `b6300638ed8b16334a8b85f0719635f556da43c9aa9621f6fa60b983333c1ca0`.

### Rollout

Remove the installed command only after Agentbot switch and queue reconciliation; rollback is Git plus snapshots, not a retained shim.

## Acceptance

- [ ] Arthack contains no Linkctl app, package, workspace dependency, test, stow package, installer branch, or live documentation reference.
- [ ] `~/.local/bin/linkctl` and owned Linkctl configuration are removed by the supported installer cleanup without touching `~/content/links`.
- [ ] Root lockfiles regenerate and all affected Arthack checks pass.
- [ ] The 584-entry catalog and existing artifacts retain their recorded hashes and ordering.
- [ ] The protected Arthack alias file remains byte-for-byte unchanged with its recorded SHA-256.

## Done summary

## Evidence
