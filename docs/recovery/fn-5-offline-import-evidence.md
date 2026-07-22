# fn-5 offline recovery import evidence

Date: 2026-07-20  
Scope: frozen legacy-corpus admission and offline drain only  
Result: completed; online extraction was not authorized or executed

This document is intentionally aggregate-only. It contains no exact recovered URLs, message bodies, chat/message identifiers, credentials, or private locators.

## Frozen generation

- Generation: `sha256-c16991f14af2cbc1146696d30b6e6115ac51cb9227f333eacf0accd35614becf`
- Atomic pointer: `$HOME/.local/share/agentbrain/recovery/manifests/current`
- Protected checksum inventory mode: `0600`
- Generation files verified against the protected inventory: 6/6
- Files verified against the generation-local inventory: 5/5
- Bound inventory:
  - candidate manifest: `014028365e439acce63f4f66ddf8778d1bf18614d9a9d0338eecefd7873f48e0`
  - private reconciliation: `2cf01c0cec6fe740b2e3ba44f1019413f9d2e901acc4edb0081e14e6ceb8ecbb`
  - public summary: `e0e1341f5ab7bb6518c9ebb17eb0dcc5335abbb7429ddfa0a5b166b00ef8e57d`
  - online allowlist: `3095e9ac906c01d9a173f015f0f26a1640ada8ef44f15a6bd45ed4ef5a5a46fa`

The current CLI has no separate `--expected-digest` import option. Generation identity, the generation-local checksum inventory, the protected inventory, and all locked cohort counts were enforced by the importer.

## Preflight and backup

The ordinary `agentbrain.worker` LaunchAgent was unloaded and no ordinary worker process was present before admission or drain.

Pre-import snapshot:

- Bundle: `$HOME/.local/share/agentbrain/recovery/snapshots/pre-legacy-import`
- Database SHA-256: `56d9cd880ff1b2e0519410e7ddd05ccdbdee71d20c2ad00192140a3031b3b223`
- Manifest SHA-256: `2cc8ae623aa36a621dc25c093942f70c427d9b15952b8c5b4f327958f4c676cd`
- Schema: 8 (current)
- Restore verification: passed
- Checks passed: database digest, SQLite integrity, schema, artifact references, isolated FTS rebuild, artifact bytes
- Bundle directory mode: `0700`; files: `0600`

Other preflight results:

- Live doctor: healthy; SQLite integrity and schema checks passed; no active or expired leases.
- Artifact store mode: `0700`; no directory or file permission drift found.
- Offline artifact descriptors: 581, totaling 7,632,142 source bytes.
- Free space: 11,005,894,656 bytes; required safety floor: 268,435,456 bytes.
- Disposable rehearsal and scoped-worker isolation tests passed before the live drain.

## Commands executed

The operational command shapes were:

```sh
bun src/cli.ts --db "$HOME/.hermes/research-cache/research.db" \
  backup create --output "$HOME/.local/share/agentbrain/recovery/snapshots/pre-legacy-import" --json
bun src/cli.ts backup verify \
  --backup "$HOME/.local/share/agentbrain/recovery/snapshots/pre-legacy-import" --json
bun src/cli.ts --db "$HOME/.hermes/research-cache/research.db" doctor --json

bun src/cli.ts --db "$HOME/.hermes/research-cache/research.db" recovery import \
  --manifest-generation "$HOME/.local/share/agentbrain/recovery/manifests/current" \
  --artifact-root "$HOME/content/links" --dry-run --json

bun src/cli.ts --db "$HOME/.hermes/research-cache/research.db" recovery import \
  --manifest-generation "$HOME/.local/share/agentbrain/recovery/manifests/current" \
  --artifact-root "$HOME/content/links" --json

bun src/cli.ts --db "$HOME/.hermes/research-cache/research.db" recovery import \
  --manifest-generation "$HOME/.local/share/agentbrain/recovery/manifests/current" \
  --artifact-root "$HOME/content/links" --authorize-offline --json

PATH="$FORBIDDEN_AGENTSCRAPE_DIR:$PATH" \
  /usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  bun src/cli.ts --db "$HOME/.hermes/research-cache/research.db" worker --once \
  --run 1 \
  --authorization-digest c16991f14af2cbc1146696d30b6e6115ac51cb9227f333eacf0accd35614becf \
  --allowed-kind recovery_offline \
  --worker-id fn5-recovery-offline --json

bun src/cli.ts --db "$HOME/.hermes/research-cache/research.db" jobs run 1 --limit 1 --json
bun src/cli.ts --db "$HOME/.hermes/research-cache/research.db" jobs stats --run 1 --json
bun src/cli.ts --db "$HOME/.hermes/research-cache/research.db" doctor --json
```

The initially admitted Run lacked an operator policy. Minimal tested support was added so `--authorize-offline` binds the existing Run through `ResearchStore.authorizeRunScope`; no direct SQL mutation was used. The logical `recovery_offline` scope selects only recovery-owned file jobs and cannot be combined with URL or ordinary file kinds.

## Dry-run and admission accounting

Dry-run observed exactly the frozen contract:

| Cohort/evidence | Expected | Observed |
|---|---:|---:|
| candidate outcomes | 1,088 | 1,088 |
| baseline candidates | 1,075 | 1,075 |
| appended candidates | 13 | 13 |
| URL observations | 294 | 294 |
| observation-bearing candidates | 131 | 131 |
| provenance-only merges | 118 | 118 |
| ordered catalog memberships | 584 | 584 |
| offline-eligible artifacts | 581 | 581 |
| approved-online candidates | 2 | 2 |
| probable-test exclusions | 12 | 12 |
| infrastructure exclusions | 25 | 25 |
| legacy-fetch reviews | 4 | 4 |
| retry reviews | 5 | 5 |
| human reviews | 98 | 98 |
| Discord reviews | 356 | 356 |
| bot-output reviews | 5 | 5 |

Admission created 1,088 candidate outcomes, 294 observations, 584 memberships, and 629 jobs. Idempotent replay created no additional outcome, observation, artifact, or job.

## Scoped offline Run

- Run ID: 1
- Mode: offline
- Immutable authorization digest: `c16991f14af2cbc1146696d30b6e6115ac51cb9227f333eacf0accd35614becf`
- Allowed kind: `recovery_offline` only
- Expected authorized jobs: 581
- Scheduling performed by scoped worker: 0
- Jobs claimed/completed/failed/fenced: 581 / 581 / 0 / 0
- Attempts succeeded/failed/stale/cancelled: 581 / 0 / 0 / 0
- URL-kind attempts: 0
- Unrelated attempts: 0
- Retries: 0
- Agentscrape sentinel invocations: 0
- Network policy during drain: `deny network*`
- Final Run state: completed and quiescent; no runnable work or active/stale leases

Cohort closeout:

| Disposition | Candidate outcomes | Job state | Attempts |
|---|---:|---|---:|
| offline import | 581 | 581 completed | 581 succeeded |
| approved online | 2 | 2 blocked | 0 |
| legacy fetch review | 4 | 4 blocked | 0 |
| retry review | 5 | 5 blocked | 0 |
| probable test | 12 | 12 excluded | 0 |
| infrastructure | 25 | 25 excluded | 0 |
| human review | 98 | evidence only | 0 |
| Discord review | 356 | evidence only | 0 |
| bot-output review | 5 | evidence only | 0 |

The two approved-online entries remain checksum-bound to the generation allowlist, blocked, and attempt-free. The offline policy cannot claim URL jobs. No online execution policy or execution lease was created; activation and egress remain separately authorized work.

## Integrity and retrieval

- Candidate outcomes: 1,088 across 1,088 current resources.
- Original locator aliases verified: 1,088/1,088.
- Imported documents: 581.
- Chunks: 8,947.
- Imported artifact resource links and provenance links: 581 / 581.
- Distinct imported bodies: 578 (content-addressed deduplication; candidate accounting remains 581).
- Imported artifact inventory SHA-256: `9aa3099ee2303aa2e728eaf0b938daa51254eb4c1b81fa7c8db7289278a4bd6d`.
- Document source locators matched the frozen candidates: 581/581.
- Forbidden private provenance fields found: 0.
- Representative filtered search results: 5; collection membership present on 5/5.
- Representative context hits/citations: 3/3.
- Representative document retrievals resolved with retained content and source locator: 3/3.
- Post-drain doctor: healthy.

Post-offline snapshot:

- Bundle: `$HOME/.local/share/agentbrain/recovery/snapshots/post-legacy-offline-import`
- Database SHA-256: `f7aa16a37cbce6c89f939bc9679a1f4b1ac92bdae2f82264153ab38928a7ed34`
- Manifest SHA-256: `7ff3510b0a281c59d15f59b967ea4a943d0da869f384f93d94f95e96d26178d0`
- Required artifacts checked: 578/578
- Restore verification: passed
- Checks passed: database digest, SQLite integrity, schema, artifact references, isolated FTS rebuild, artifact bytes
- Bundle directory mode: `0700`; files: `0600`

## Tests

- Focused recovery, scoped-worker, and CLI suites: 38 passed; two load-related timeouts passed on isolated rerun.
- New recovery authorization/scoped-drain tests: passed.
- Disposable `scripts/rehearse-recovery-import.sh`: passed with 581 completions, two blocked approved-online jobs, and zero network calls.
- `bun run typecheck`: passed.
- Biome check on changed source/tests: passed.
- `bun run check`: typecheck and lint passed; 154 tests passed and two tests timed out under concurrent suite load. Both timeout cases passed on isolated rerun, including the six-process claim race.

No test was skipped, weakened, or deleted.

## Rollback

The ordinary LaunchAgent must remain unloaded throughout rollback.

1. Verify the pre-import bundle again:

   ```sh
   bun src/cli.ts backup verify \
     --backup "$HOME/.local/share/agentbrain/recovery/snapshots/pre-legacy-import" --json
   ```

2. Confirm no Agentbrain worker or CLI process has the live database open. Preserve the current database and any WAL/SHM files under timestamped names; do not delete them.
3. Copy `pre-legacy-import/database.sqlite` to a private temporary file beside the live database, set mode `0600`, then atomically rename it to `research.db`.
4. Run `doctor`, `stats`, and `jobs stats` against the restored database before reloading any service.
5. Do not blanket-delete Artifact objects. A database-only rollback leaves newly imported content-addressed bodies as unreferenced objects; retain them until a digest-aware reconciliation compares the verified pre- and post-offline manifests.
6. To return to the successful offline state instead, perform the same isolated procedure with `post-legacy-offline-import/database.sqlite`; its manifest requires and verifies all 578 retained Artifact bodies.

A local snapshot can roll back database and referenced local effects. No remote request occurred in this offline phase.
