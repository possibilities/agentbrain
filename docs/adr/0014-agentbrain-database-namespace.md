# ADR 0014: Agentbrain database namespace

- Status: Accepted
- Date: 2026-07-23

## Context

Agentbrain took sole ownership of the local research index while its first cutover deliberately retained the Hermes-era database location, `~/.hermes/research-cache/research.db`. That reduced risk during the ownership transfer, but the path now misstates who owns the durable queue and index, complicates restore instructions, and leaves database files outside Agentbrain's private data tree.

Changing a SQLite path is not only a naming edit. The live database uses WAL mode and a resident LaunchAgent Worker, so copying the main file while a writer is active can omit committed WAL state. Starting new-default code before state is moved can also create a second empty database. A compatibility symlink would preserve ambiguity and expose SQLite WAL/SHM naming and stale-binary locking hazards.

## Decision

- **The default database is `~/.local/share/agentbrain/research.db`.** Explicit override precedence remains `--db`, then `AGENTBRAIN_DB`, then this fixed default. The fixed path keeps interactive and LaunchAgent behavior aligned without depending on an inherited `XDG_DATA_HOME`.
- **Default-path use fails closed around legacy state.** If `~/.hermes/research-cache/research.db` exists while the namespaced database is absent, commands report `db_migration_required`. If both exist, or if the namespaced database is a symlink, commands report `db_location_conflict`. Explicit `--db`/`AGENTBRAIN_DB` access remains available for controlled backup, verification, and rollback.
- **The installer never migrates or chooses a database.** It refuses the same legacy/collision states before replacing or loading the Worker service. On a fresh or migrated installation it creates the Agentbrain data directory as mode `0700`; writable default-path access enforces directory mode `0700` and database mode `0600`.
- **Cutover uses a verified standalone SQLite image.** The operator first creates and verifies an Agentbrain backup, unloads the Worker, confirms zero open DB/WAL/SHM handles, creates a final consistent snapshot from the legacy database, restores its standalone `database.sqlite` through a private temporary file beside the target, fsyncs and atomically renames it, and verifies integrity and counts explicitly against the target before restarting the Worker.
- **The complete legacy database set is archived, never linked.** The old main DB, WAL, and SHM files are moved out of the retired pathname under a timestamped private archive. Rollback requires stopping the Worker, preserving divergent namespaced state, restoring the verified pre-cutover image and matching old code, and verifying before service restart.
- **Restic treats the consistent Agentbrain backup as authoritative.** The raw namespaced live DB and its transient WAL/SHM files are excluded from broad backup roots. Restore verification materializes the verified standalone snapshot at the namespaced path with private permissions.

## Consequences

- Agentbrain's durable database, Artifacts, and recovery data now share an owner-named data namespace.
- Fresh installs cannot silently adopt legacy state, and upgrades cannot silently create a second database during an incomplete migration.
- Current help, guide, installer, backup, and restore surfaces name the new path; historical recovery evidence continues to record the path actually used at the time.
- Operators retain explicit path overrides for forensic inspection and rollback, but there is no permanent legacy alias.

## Related

This decision supersedes only the database-location deferral in [ADR 0003](0003-agentbrain-owns-durable-ingestion.md). The first-cutover history in [superseded ADR 0001](superseded/0001-agentbrain-owns-research-index.md) and the executed recovery evidence under [`docs/recovery`](../recovery/) remain unchanged. Consistent snapshots and restore verification use Agentbrain's existing backup contract; the exact cutover and rollback commands live in the [database namespace migration runbook](../runbooks/database-namespace-migration.md).
