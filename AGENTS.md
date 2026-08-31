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
- The three services that run this code — `agentbrain.worker`,
  `agentbrain.doctor`, and the opt-in `agentbrain.share` — are defined and
  installed by AgentStart (`~/code/agentstart/config/launchd/`), not here. This
  installer ships the command only. the machine's service verification asserts those labels by
  name, and supplies the bind address and conduit paths to
  AgentStart as `AGENTSTART_INSTALL_*`; renaming a label breaks provisioning in
  both places.
- Skills call `search "<q>" --json` and `get --document-id N --full --json`, and
  hardcode `~/.local/share/agentbrain/research.db`.

## The agent contract

- `src/contract.ts` is the single authorship of what this CLI is. `guide
  --json` emits it verbatim, and `--help`, `agentbrain help <command>`,
  `--agent-help`, `--agent-teaser`, and `prompt` are renders of it. `src/help.ts`
  holds layout and no prose: a sentence that states a fact about the CLI
  belongs in the contract, or it becomes a second authorship that nothing
  compares.
- Adding or changing a command means editing the contract in the same commit.
  Every command appears there, including ones no agent should call — `audience`
  (`agent` / `operator` / `internal`) is how a command is hidden, never
  omission, because a missing command is indistinguishable from an oversight.
  Every leaf declares `mutates`, and `concepts.read_only_commands` must be
  exactly the non-mutating leaves by full path.
- Every `new CliError("code", …)` outside `src/share-server.ts` must appear in
  `concepts.error_codes`; `test/agent-contract.test.ts` fails on either
  direction of drift, and also checks the whole document against
  `~/code/agentstart/scripts/validate-agent-contract.ts` when that checkout is
  present. The schema at `~/code/agentstart/config/agent-contract/schema.json`
  is normative.
- `src/cli.ts` is the package bin and holds nothing but the entrypoint;
  dispatch lives in `src/dispatch.ts` so the command table is importable.

## The brain skill

- `skills/brain/SKILL.md` is the canonical deep runbook for agents. The
  in-binary fallback is `--agent-help`, which is *rendered* from the contract
  in `src/contract.ts` and names the skill; the two must keep agreeing.
- AgentStart's skills scan copies it into the fixed private fleet resources by running
  `npx skills add --copy` against this checkout and discovering nested
  `skills/<name>/SKILL.md`. The installed
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

## The fleet

This checkout is one of the agent* fleet under `~/code`. Shared machinery
lives in two siblings, and some changes here must cascade:

- Skills under `skills/<name>/` ship into AgentStart's fixed private
  fleet resources (`~/code/agentstart/scripts/sync-skills`, run six-hourly
  by the scheduled updater). AgentLaunch loads them into every managed
  session: Claude Code exposes `/agent:<name>`, Codex uses
  `$agent:<name>`, and Pi uses `/<name>`. A SKILL.md edit is live within
  six hours, or on demand by running that script. Whether a new skill earns a TOOLS.md
  advertisement line is a deliberate decision —
  `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentstart/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, maintain, story, the resource
  skills — is `~/code/agentguidance`; tool-specific runbooks stay here.
