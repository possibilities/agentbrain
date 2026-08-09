# Agentbrain contributor notes

Read `README.md` for what this is and `CONTEXT.md` for the glossary. Everything
below is a constraint you cannot recover by reading a single file.

## Boundaries

- **Agentbrain never fetches.** Every network read belongs to the sibling
  `agentscrape`, which owns transport, browser sessions, and network policy
  (ADR 0002). A change that makes this process open a socket to the open web is
  wrong even when it is convenient.
- **Admission is not indexing.** `submit` durably queues an immutable job and
  returns; it never materializes content. "Accepted" says a job exists, not that
  anything was fetched, extracted, or made searchable. Do not let a command
  report success on behalf of work the Worker has not done.
- **`ResearchCache` reads, `ResearchStore` writes.** `src/db.ts` opens a
  structurally read-only connection and refuses a missing database;
  `src/store.ts` creates, migrates, and owns every write. Reaching for
  `ResearchStore` in a read command silently turns it into a writer — and
  creates the database it was supposed to find.

## Traps

- **`chunks_fts` is a regular, non-contentless fts5 table.** A bare
  `UPDATE ... SET tags=?` on an indexed column silently corrupts the index. Every
  mutation must delete the affected rows and reinsert them with *every* indexed
  column supplied (ADR 0013; see `src/store.ts` for the pattern to copy).
- **The database deliberately does not honor `XDG_DATA_HOME`** while the
  artifact store does (ADR 0014). Half-honored is the decision, not a bug.

## Consumer contracts that must not break

- `agentscrape`'s queue machine-parses the JSON acknowledgement from
  `agentbrain submit <url> --kind url --ingress <s> --collection saved-links
  --notes <json> --json`. Exit 0 plus that envelope on stdout is a wire format,
  not console output.
- `funk` asserts the launchd labels `agentbrain.worker` and `agentbrain.share`
  by name, and the installer's `AGENTBRAIN_INSTALL_SHARE_HOST` /
  `AGENTBRAIN_INSTALL_CONDUIT_SOCKET` / `AGENTBRAIN_INSTALL_CONDUIT_TOKEN_FILE`
  environment contract. Renaming any of them breaks provisioning elsewhere.
- Skills call `search "<q>" --json` and `get --document-id N --full --json`, and
  hardcode `~/.local/share/agentbrain/research.db`.

## The brain skill

- `skills/brain/SKILL.md` is the canonical deep runbook for agents. `--agent-help`
  in `src/help.ts` is the in-binary fallback and names the skill; the two must
  keep agreeing.
- Funk's skills scanner installs it globally by running `npx skills add` against
  this checkout and discovering nested `skills/<name>/SKILL.md`. The installed
  copy is this file — do not add a second source or a sync path.
- Every claim in the skill was verified against live CLI output. A change to
  command behavior, envelope shape, exit codes, or submission statuses is not
  finished until those claims are re-verified (`agentbrain guide --json`,
  `--agent-help`, `help <command>`) and the prose corrected.
- The skill directory is installed away from this repository, so it must stay
  self-contained: no `../` paths, no links into `docs/`.

## Working here

- `bun run check` (typecheck, lint, ~40s serial test suite) is the gate. Run it
  before handing work off.
- `config/sources.schema.json` is generated — never hand-edited. The zod
  schema in `src/source-manifest-schema.ts` is the single source of truth:
  the loader validates manifests with it, `bun run generate:schema` emits the
  published file from it, and `test/sources-schema.test.ts` fails on drift.
  Adding a manifest key means declaring and describing it in the schema
  module; the loader and the published schema both follow.
- Use `CONTEXT.md`'s terms exactly — Ingress, Admission, Attempt, Run, Resource,
  Document, Artifact are distinct and each entry says what *not* to call things.
  Prose that swaps them is a defect, not a style choice.
- Tests are hermetic: temp directories, a stubbed `agentscrape`, a vendored
  contract fixture. No network, no real database, no installed service.
- Comments state constraints the code cannot show. No narration.
