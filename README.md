# agentbrain

Agentbrain owns Mike's local research index and is its sole durable ingestion authority. It owns Admission, the SQLite ingestion queue, Attempts, Artifacts, schema, Resources, Documents, chunks, FTS, and provenance. Read commands use structurally read-only SQLite connections; mutation commands use the separate writable store. The database lives at `~/.local/share/agentbrain/research.db`; `--db PATH` wins over `AGENTBRAIN_DB`, which wins over that default.

An Ingress such as the CLI submits intent at Admission. Admission validates it and durably creates or identifies an immutable ingestion job before returning; it does not materialize content. The Worker is Agentbrain's executor: it leases jobs, delegates extraction, and commits fenced outcomes, while Agentbrain remains the index owner. A retry creates another Attempt instead of replacing the job. Agentscrape remains the URL extraction and network-policy boundary, but it does not own Agentbrain's queue or index.

Architecture references:

- [Agentbrain owns durable ingestion](docs/adr/0003-agentbrain-owns-durable-ingestion.md)
- [Durable ingestion job lifecycle](docs/adr/0004-durable-ingestion-job-lifecycle.md)
- [Public Admission contract](docs/adr/0005-public-ingestion-admission-contract.md)
- [Single Worker operation](docs/adr/0011-single-worker-source-scheduling.md)
- [External recurring-Source trigger contract](docs/adr/0016-external-source-trigger-contract.md)
- [Agentbrain database namespace](docs/adr/0014-agentbrain-database-namespace.md)
- [Parser-derived content classification](docs/adr/0015-parser-derived-content-classification.md)

## Quick start

```bash
bun install
bun run src/cli.ts --help
bun run src/cli.ts stats --json
bun run src/cli.ts context "agent memory" --limit 5 --max-chars 10000 --json
bun run src/cli.ts search "agent memory" --limit 5 --json
bun run src/cli.ts get --document-id 123 --json
```

Recommended evidence flow: `context`, or `search -> get -> cite`. Cite `document_id`, `chunk_id` when present, `title`, `source_uri`, and relevant relation provenance. Parser-derived content form is durable and independently filterable from URL identity:

```bash
agentbrain search "model routing" --content-kind thread --json
agentbrain context "reasoning systems" --content-kind article --json
```

`content_kind` is `post`, `thread`, `article`, or `null` for legacy/unclassified documents; `content_item_count` records the parser-observed number of posts/items. These fields appear in search, context, get-document, and get-chunk output.

## Durable Admission and ingestion

Use `submit` for new integrations. `ingest` is a compatibility alias with the same queued behavior.

```bash
agentbrain submit "A pasted research note" --kind text --tag notes --json
agentbrain submit ./paper.pdf --kind file --tag paper --json
agentbrain submit ./research --kind directory --recursive=true --json
agentbrain submit https://example.com/article --kind url --max-bytes 5000000 --json
```

Text and local file bytes are captured as immutable Artifacts before acknowledgement. URL Admission performs syntax validation and queues normalized intent without network work. A new intent returns `queued`; a replay returns `duplicate` with the same job identity. Materialization happens only after a Worker leases the job.

For URL jobs, the Worker invokes PATH-resolved `agentscrape fetch-markdown URL --envelope --max-content-bytes N --max-relations N` without a shell. Agentscrape owns fetching, browser/session behavior, redirects, credentials, backend retries, and extraction hardening. The live schema-v1 envelope must identify `agentscrape`; malformed and unknown versions are protocol defects. Agentbrain bounds and sanitizes extractor output and remains the only component allowed to mutate the index.

Successful extraction bytes are promoted before index commit so a retry does not refetch. New promotion records retain `record_version: 1` and carry extractor identity `agentscrape`. Existing version-1 records remain readable with their bounded opaque historical extractor identity preserved in provenance; replay validates the same URL, digest, path, size, and content constraints and does not rewrite the record, Artifact bytes, or SQLite merely to rename provenance. Agentscrape may additionally report the optional, validated `content_kind` and `content_item_count`; Agentbrain persists them on the Document while keeping `source_type` as locator identity.

Operate the queue explicitly with:

```bash
agentbrain jobs stats --json
agentbrain jobs list --state queued --json
agentbrain jobs show JOB_ID --json
agentbrain jobs retry JOB_ID --reason "provider repaired" --json
agentbrain doctor --json
agentbrain worker --once --json
```

`worker --once` recovers stale leases, drains eligible jobs, and exits, so it is the deterministic offline and repair seam. The long-running `agentbrain worker` stops taking claims on `SIGTERM`, observes its shutdown grace, and leaves unfinished work recoverable through lease expiry. Do not run a manual long-lived Worker alongside the installed LaunchAgent.

## Worker LaunchAgent

First prove the checked-out Worker against a temporary database without launchd, a browser farm, or network access:

```bash
scratch="$(mktemp -d)"
mkdir -p "$scratch/home"
HOME="$scratch/home" XDG_DATA_HOME="$scratch/data" \
  bun run src/cli.ts --db "$scratch/research.db" --json \
  submit "offline worker smoke" --kind text
HOME="$scratch/home" XDG_DATA_HOME="$scratch/data" \
  bun run src/cli.ts --db "$scratch/research.db" --json worker --once
rm -rf "$scratch"
```

Then install the commands and the one user service:

```bash
./scripts/install.sh --help
./scripts/install.sh --install
```

The idempotent installer creates only these owned entries:

- `~/.local/bin/agentbrain`, linked to this checkout;
- `~/Library/LaunchAgents/agentbrain.worker.plist`, invoking only the installed `agentbrain worker` command;
- `${XDG_STATE_HOME:-~/.local/state}/agentbrain/worker.log` in a private state directory;
- `~/.local/share/agentbrain/research.db` as the default durable database.

The data and state directories are mode `0700`; the database, rendered plist, and log are mode `0600`; the service uses umask `077`. Its arguments contain no submitted content, URLs, Artifact paths, or credentials. Installation runs `bun install --frozen-lockfile` before changing the command or service, so immutable managed checkouts do not expose a runtime missing its dependencies. Reinstall unloads the known label, atomically replaces only a marker-owned plist, and loads it again. The installer may replace the exact legacy command link `/Users/mike/code/agentbrain/src/cli.ts`; managed deployments with a different known predecessor can set `AGENTBRAIN_INSTALL_LEGACY_SOURCE` to that one exact source. It refuses unrelated command links, regular files, and foreign service files rather than taking them over.

Installation never guesses between database copies. If the retired `~/.hermes/research-cache/research.db` exists, or both retired and namespaced databases exist, default-path commands and installation fail closed until an operator completes the [verified database namespace migration](docs/runbooks/database-namespace-migration.md). `--db` and `AGENTBRAIN_DB` remain available for explicit recovery and rollback; no compatibility symlink is created.

Writable schema upgrades are applied transactionally when the installed Worker opens the database; read-only commands deliberately never migrate. After an upgrade, wait for the Worker to start and require `doctor` to report the current schema before treating the deployment as available. Older binaries cannot read a database after a schema upgrade, so rollback requires restoring the matching pre-upgrade backup rather than merely switching the command link.

Check operation with:

```bash
launchctl print "gui/$(id -u)/agentbrain.worker"
agentbrain jobs stats --json
agentbrain doctor --json
tail -n 100 "${XDG_STATE_HOME:-$HOME/.local/state}/agentbrain/worker.log"
```

For repair, rerun `./scripts/install.sh --install`; this clears a stale service with the owned label before loading the rendered plist. If queue state needs deterministic reconciliation, unload the service, run `agentbrain worker --once`, and reinstall it:

```bash
launchctl bootout "gui/$(id -u)/agentbrain.worker" || true
agentbrain worker --once --json
./scripts/install.sh --install
```

Uninstall is also idempotent:

```bash
./scripts/install.sh --uninstall
```

It gracefully unloads the Worker and removes only owned command links and the marker-owned service file. It intentionally preserves the namespaced database, Artifacts, and private log. For rollback, uninstall the service before restoring a pre-migration database snapshot, restore the matching Agentbrain code, run the temporary-database smoke with that version, and only then install its service. Never start the newer Worker against a snapshot being restored.

The LaunchAgent drains already admitted ingestion jobs only. Installation does **not** create, schedule, or enable recurring remote Sources. A future external scheduling service may invoke the idempotent one-shot Source commands below; Agentbrain remains the durable Run/checkpoint authority and the resident Worker executes admitted work.

Legacy provenance labels such as `source=linkctl` remain queryable as historical data. They do not identify a live Ingress or an installed command.

## Recurring sources

A Source is a recurring producer or discovery definition, such as a direct RSS/Atom feed, a blog homepage that advertises a feed, or an X account. Three names are executable: `blog_feed` and `blog_source` share the bounded feed discovery path, while `x_account` performs forward-only X timeline polling by stable post ID and never claims complete historical pagination. Any other kind, including the disabled `x_account_candidate` recommendation records below, is listable and showable but never admits a Run.

The bundled manifest at `config/sources.yaml` currently encodes the 11 confirmed blog sources and 14 confirmed X accounts recovered from historical operator evidence, plus 13 recommended-but-unconfirmed X accounts represented as `x_account_candidate` — disabled candidate evidence, not active configuration. Every definition in the bundled manifest ships `enabled: false`; applying it creates or updates durable source rows without scheduling any Run. Confirmed blogs default to daily cadence, confirmed X accounts to hourly, each with an explicit bounded `limits.max_items_per_run` / `limits.max_pages_per_run` so a first activation cannot silently request an unbounded or deep-historical X backfill. Enabling confirmed sources in controlled cohorts is an explicit operator rollout performed with the activation overlay described below — never an implicit side effect of `sources apply`.

```bash
agentbrain sources apply --json
agentbrain sources list --json
agentbrain sources show blog.simon-willison --json
agentbrain sources status --json
agentbrain sources sync --due --dry-run --json
agentbrain sources sync x.karpathy --due --wait --wait-timeout-seconds 300 --wait-timeout-ok --json
agentbrain sources pause x.karpathy --reason "provider smoke pending" --json
agentbrain sources resume x.karpathy --json
```

`sources apply` reads a manifest (default: `config/sources.yaml`) and durably creates or updates matching source definitions; a higher version may declaratively enable or disable a Source, but apply never deletes or runs one implicitly. Re-applying identical content is a no-op; raising `version` admits changed content, while changing content without raising `version` is refused. `sources list` / `show` / `status` expose kind, cadence, bounded limits, collection and sensitivity policy, checkpoint presence, and health without credentials, payload secrets, or private content — `credential_refs` are opaque reference names, never credential values.

`sources sync SOURCE_ID --due` is the preferred external-scheduler trigger. It durably admits at most one catch-up Run when due; repeated invocations return the pending/active Run instead of duplicating it. `--wait` returns a scheduler-facing terminal receipt through the resident Worker: timeout normally exits 124 and non-success exits 1. A `not_due` retry includes the latest terminal Run when one exists, preventing an observer timeout from hiding a later failure; no prior Run or a latest success remains an exit-0 no-op. Supervisors that treat every nonzero exit as an execution failure can add `--wait-timeout-ok`; JSON still records `timed_out:true` while the independent durable Run continues. Source completion covers discovery, durable observations/admissions, and checkpointing—not eventual completion of every independently retryable child URL job. Live X and RSS/Atom/blog discovery remain Agentscrape-owned provider work. See [the external scheduling runbook](docs/runbooks/external-source-scheduling.md) and [ADR 0016](docs/adr/0016-external-source-trigger-contract.md).

`sources sync --due` remains the global manual catch-up command. `sources pause` / `resume` append audit evidence and immediately block or unblock admission without discarding earlier Runs or checkpoints.

### Activating confirmed cohorts

The bundled manifest stays disabled; activation is a separate, reviewable overlay at `config/sources.activation.yaml` that enables exactly the 25 confirmed sources (11 blogs, 14 X accounts) at definition `version` 2 and leaves every `x_account_candidate` disabled. Apply it as a version-gated update over the installed baseline:

```bash
agentbrain sources apply --overlay config/sources.activation.yaml --reason "activate confirmed cohort" --json
```

Roll out in bounded cohorts rather than all at once: run the opt-in smoke first, apply the overlay, and `sources pause` any source you are not yet observing so it re-activates only after a healthy cycle. Because each definition carries bounded `limits` and X keeps `max_pages_per_run: 1`, activation never authorizes deep historical X backfill, and candidates cannot schedule a Run even if force-enabled.

The recurring-sources smoke is opt-in and outside `bun test`. It applies the manifest and activation overlay to a temporary database and Artifact root, drives one confirmed blog and one confirmed X account through the durable schedule → discovery → checkpoint loop, and checks that repeated overlap indexes nothing new, absence deletes nothing, and pause blocks admission — deleting the temporary state only on success:

```bash
./scripts/smoke-recurring-sources.sh [blog.simon-willison] [x.simonw]
```

Run it only after Agentscrape and any required browser farm / X session are up. It never touches the configured production database or the recurring Sources activated there.

## Legacy corpus recovery

Recovery admits one immutable, hash-bound frozen generation of legacy candidate evidence. A generation binds its candidate manifest, private reconciliation, public summary, and checksum inventory under a single `sha256-` generation ID and is verified in full before any state changes:

```bash
agentbrain recovery import --manifest-generation ~/.local/share/agentbrain/recovery/manifests/current --dry-run --json
agentbrain recovery import --manifest-generation ~/.local/share/agentbrain/recovery/manifests/current --artifact-root ~/content/links --authorize-offline --json
agentbrain worker --once --run OFFLINE_RUN_ID --authorization-digest GENERATION_DIGEST --allowed-kind recovery_offline --json
agentbrain recovery online --manifest-generation ~/.local/share/agentbrain/recovery/manifests/current \
  --artifact-root ~/content/links --offline-run OFFLINE_RUN_ID \
  --post-offline-snapshot ~/.local/share/agentbrain/recovery/snapshots/post-legacy-offline-import \
  --generation-digest GENERATION_DIGEST --approval-digest ONLINE_ALLOWLIST_SHA256 \
  --snapshot-digest POST_OFFLINE_DATABASE_SHA256 --execute --json
```

Dry-run verifies every descriptor, checksum, candidate row, and local Markdown front-matter without writing to the database or the Artifact store and without invoking Agentscrape. It reports the exact accounting only: 1,088 candidate outcomes, 294 Secretary observations, 118 provenance merges, 13 appended exact candidates, 584 ordered `legacy-links` memberships, and 581 approved offline artifacts. Comparison URIs are diagnostic aliases; they never collapse candidate outcomes.

Admission is offline, idempotent, and resumable. It creates one pending recovery Run, stable candidate outcomes, body-free observations, 581 runnable offline file jobs, 11 blocked jobs, and 37 exclusions; review and evidence-only cohorts create no jobs at all. `--authorize-offline` immutably binds the Run to the generation digest and logical `recovery_offline` kind. Ordinary workers then skip the controlled Run, while the matching scoped command claims only its 581 recovery file jobs. The two human-approved candidates for **controlled online backfill** are admitted as **blocked** jobs and are never eligible for the offline scope; egress stays deferred to the separate downstream online phase.

`recovery online` refuses to prepare work unless the offline Run is terminal and exactly reconciled, the post-offline snapshot independently restore-verifies, all Artifact/FTS/integrity/quiescence gates pass, all three supplied digests match, and the immutable allowlist maps exactly two distinct approved candidate evidence rows to their original blocked jobs. Preparation creates a separate immutable `recovery_online` Run with two URL jobs; `--execute` holds its concurrency-one execution lease and delegates each acquisition only to Agentscrape. Item failures preserve sibling isolation, shared provider/auth/config/integrity failures pause the Run, replay never substitutes work, and a terminal non-success reports `completed_with_review`. Rollback covers local database/Artifact effects only—remote requests cannot be undone.

Every recovery surface is sanitized: output carries opaque generation/candidate/Run/Attempt IDs, bounded states and classifications, aggregate counts, and snapshot/Artifact hashes, never exact candidate URLs, private locators, message bodies, chat/session identifiers, credentials, or unsafe evidence.

Before any live admission, prove the whole path end to end in throwaway roots with a forbidden Agentscrape on PATH:

```bash
./scripts/rehearse-recovery-import.sh
```

The rehearsal drives the real frozen generation and local artifacts through dry-run, admission, an offline worker drain, retrieval and citations, backup create/verify restore, and idempotent replay in a disposable database and Artifact store, then prints one sanitized aggregate summary. It performs zero network operations, removes its temporary state on success, and preserves it for inspection on failure. Override `AGENTBRAIN_RECOVERY_GENERATION` and `AGENTBRAIN_RECOVERY_ARTIFACT_ROOT` to rehearse a different generation or artifact root.

## Deletion

Deletion is intentionally guarded:

```bash
agentbrain delete --document-id 123 --confirm delete --json
```

## Structural retagging

`retag` deterministically derives structural tags (from `source_type`, URL domain, and collection membership) and applies them across every document, keeping `documents.tags` and the denormalized `chunks_fts.tags` in sync and always preserving `legacy-recovery` and any user tag:

```bash
agentbrain retag --dry-run --json
agentbrain retag --json
```

`--dry-run` reports the same per-document tag diffs and scanned/changed/unchanged counts without writing. Re-running `retag` is idempotent: a document whose derived tags already match its stored tags is reported unchanged.

## Agent discovery and checks

Use `agentbrain guide --json` for the machine-readable command and ownership contract, and `agentbrain prompt` to generate harness-local instructions.

Run all project checks with:

```bash
bun run check
```

`bun test` uses the vendored generic Agentscrape contract fixture at `test/fixtures/extraction-generic.expected.json`, so fresh runners do not need a sibling `arthack` checkout. Set `AGENTSCRAPE_CONTRACT_FIXTURE` to validate against an explicit alternate fixture path.

The real Agentscrape smoke is opt-in and outside `bun test`. It creates a temporary database and Artifact root, submits a queued URL job, drains it with `worker --once`, verifies the materialized document is searchable, and deletes the temporary state only after success:

```bash
./scripts/smoke-agentscrape-url-ingest.sh [https://example.com/]
```

Run it only after the human has brought Agentscrape and any required browser farm up. If the smoke fails, it preserves the temporary directory and JSON evidence so the admitted job and Attempt can be inspected without touching the live database or configured recurring Sources.
