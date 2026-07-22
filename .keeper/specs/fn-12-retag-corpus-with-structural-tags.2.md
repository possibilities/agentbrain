## Description

**Size:** M
**Files:** src/cli.ts, src/help.ts, src/guide.ts, CONTEXT.md, docs/adr/0013-structural-tag-derivation.md, README.md, test/retag-cli.test.ts

### Approach

Add a `retag` mutation subcommand that applies the Task 1 derivation + write across all documents in the index, plus its documentation. Mirror the `delete` command's structure: a `parse<X>Request`/`execute<X>` pair, a dispatch branch that opens `ResearchStore` with the `existsSync` `db_not_found` guard and closes it in `finally`, and emission via `writeByFormat(..., { readOnly: false })`. Iterate documents BY ID (never by `source_uri` — duplicate source_uris are possible), deriving and writing each via the Task 1 store method. Support `--dry-run`: compute and report per-document tag diffs and totals WITHOUT writing. The success envelope reports counts (documents scanned / changed / unchanged) and — per the envelope-only audit decision — a per-document before/after tag summary. No new audit table and no schema-version bump (this stays DATA-only).

Register the command on ALL surfaces or it will work but be undocumented/misclassified: COMMANDS / COMMAND_NAMES (src/cli.ts:67), MUTATION_COMMANDS (src/cli.ts:76), the dispatch block (src/cli.ts:257), per-command help (src/help.ts), and `guide.ts` `mutation_commands` list + per-command description.

Docs land WITH the code: add a "Structural tag" entry to CONTEXT.md's glossary — deterministically derived from structural attributes; search-affecting (indexed in FTS), unlike Sensitivity which is a handling policy, not a tag; distinct from a user-supplied `--tag` — and leave the existing Backfill term unchanged (the command is `retag`). Author `docs/adr/0013-structural-tag-derivation.md` (template: `docs/adr/0010-legacy-recovery-import-contract.md`) recording the decision: curated lean structural vocabulary, `legacy-recovery` preserved, targeted FTS-synced idempotent write, envelope-only audit, no schema change. Add a README command-reference entry beside the Deletion section.

### Investigation targets

*Verify before relying — planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/cli.ts:257-286 — mutation dispatch block; :269-285 is the `delete` branch to mirror (incl. `existsSync` `db_not_found` guard).
- src/cli.ts:1214-1258 — `parseDeleteRequest` + `executeDelete`, the closest template for the new parse/execute pair.
- src/cli.ts:67,76 — COMMANDS / MUTATION_COMMANDS registration points.
- src/help.ts:5-66 — per-command help entries.
- src/guide.ts:59-65 — `mutation_commands` list; :107,123 — per-command descriptions.
- src/db.ts:470-482 — the `tags()` read command (verification surface; new tags surface here via `json_each`).
- test/mutation-cli.test.ts:19-46,71-85,133-166 — subprocess CLI test pattern, temp-DB fixture, and the "invalid argv never initializes a DB" table-test.

**Optional**:
- test/cli.integration.test.ts:817-822 — the `guide --json` negative-substring check (no golden fixture, so adding a command won't shatter a golden file — but keep the guide truthful).
- docs/adr/0010-legacy-recovery-import-contract.md — ADR structure.
- CONTEXT.md:16,18,30 — Source / Sensitivity / Backfill terms to disambiguate the new entry against.

### Risks

- Missing one of the 4+ registration surfaces → command works but is undocumented/misclassified, and tests won't catch it.
- `--dry-run` accidentally writing, or the real run not being idempotent end-to-end (add a CLI-level rerun assertion on top of Task 1's store test).

### Test notes

Subprocess CLI tests over a temp DB seeded with documents: run `retag --json` and assert envelope counts + `read_only:false`; run `retag --dry-run` and assert the DB is unchanged; run `retag` twice and assert the second run reports zero changed; assert a document is findable by a derived tag via the `tags`/search read. Arg-validation: invalid `retag` argv never initializes a DB. `bun run check`.

## Acceptance

- [ ] `agentbrain retag` applies structural tags across every document in the index and returns a JSON envelope reporting documents scanned / changed / unchanged with `read_only:false`.
- [ ] `agentbrain retag --dry-run` reports the same per-document tag diffs and counts without mutating the database.
- [ ] Running `agentbrain retag` a second time reports zero changed documents (idempotent end to end).
- [ ] The command is registered on every surface — command list, MUTATION_COMMANDS, dispatch, help text, and `guide --json` mutation_commands + description — so `agentbrain guide --json` lists it truthfully.
- [ ] A document is retrievable by a newly derived structural tag through the existing tags/search read path.
- [ ] CONTEXT.md defines "Structural tag" (disambiguated from Sensitivity and the user `--tag`), docs/adr/0013 records the derivation + mutation decision, and README documents the `retag` command; the existing Backfill glossary term is unchanged.
- [ ] Invalid `retag` arguments never initialize or mutate a database.
- [ ] `bun run check` passes.

## Done summary
Added the retag mutation CLI command that applies Task 1's structural-tag derivation and targeted FTS-synced write across every document by id, with --dry-run preview, idempotent counts/diffs, and registration on every CLI surface (COMMANDS, MUTATION_COMMANDS, dispatch, help, guide). Documented in CONTEXT.md, README.md, and new ADR 0013.
## Evidence
- Commits: 156950a32d85fe9285020443c1b5c5812b205b29