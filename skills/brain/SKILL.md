---
name: brain
description: Search and grow the local research index with the agentbrain CLI — articles, threads, papers, and notes already collected on this machine, searchable offline with citations. Reach for it before any web search or paid research call, because the answer is often already local. Triggers: "have we researched this?", "didn't we read about X?", "what do we have saved on…"; finding something worth keeping and wanting it durably ingested; and checking whether a submitted link ever landed.
---

# Brain — the local research index

Agentbrain owns a durable local research index: everything saved from a
browser, a phone, a recurring source, or an agent, extracted into documents,
chunked, and searchable offline through SQLite FTS5. This skill is the runbook
for wielding it.

The index is a first-class research source. Before paying for a web search,
before fetching a URL, before telling the user "I don't know," search here
first — a lot of what looks like new research was already read, saved, and
indexed weeks ago.

Verified against agentbrain 0.2.0 on a live 900-document index. The CLI is
self-describing — when this document and the installed binary disagree, the
binary wins; see [Discovery and drift](#discovery-and-drift).

## Non-negotiables

- **Brain before web.** The local index is free, offline, and instant. Search
  it before reaching for the `search` skill (paid Perplexity calls) or the
  `scrape` skill (network fetch). Escalate outward only after brain is
  genuinely silent — see [When brain is silent](#when-brain-is-silent).
- **Admission is not indexing.** `submit` durably queues an immutable
  ingestion job and returns. It fetches nothing, extracts nothing, indexes
  nothing. A URL you just submitted is **not** searchable — extraction happens
  later, in the resident worker, through Agentscrape. Never submit-then-search
  in the same breath and conclude the index is broken.
- **Reads cannot mutate.** `search`, `get`, `context`, `stats`, `tags`,
  `sources list/show/status`, `jobs list/show/stats`, and `doctor` open SQLite
  read-only and never create or migrate a database. `meta.read_only: true`
  on the envelope is the proof. Run them freely.
- **Cite what you use.** Every claim sourced from the index carries
  `document_id`, `chunk_id` when present, `title`, and `source_uri`. A
  paraphrase with no ids is indistinguishable from a guess.
- **Absence needs evidence.** One zero-hit query proves nothing. Retry with
  alternate terms, then check inventory, and only then say the index doesn't
  have it.
- **Don't touch the database by hand.** No raw SQL, no opening
  `~/.local/share/agentbrain/research.db` yourself. The FTS table is a regular
  (non-contentless) fts5 table; a stray write corrupts the index silently.

## Preflight

Usually none. The read path is safe at any moment and needs no warm-up. Two
probes matter when something looks wrong:

```bash
agentbrain doctor --json    # exit 0 healthy, 1 when a required check fails
agentbrain stats --json     # document_count, chunk_count, tags, recent docs
```

`doctor` reports seven checks — `database_integrity`, `schema_version`,
`artifact_references`, `leases`, `stranded_ingestion`, `admission_review`,
`agentscrape` — plus a top-level `healthy` boolean, and never mutates the
ledger.

The database lives at `~/.local/share/agentbrain/research.db`. Precedence is
`--db PATH`, then `AGENTBRAIN_DB`, then that default. A read against a path
that doesn't exist fails with `db_not_found` and exit 1 rather than creating an
empty index — so an unexpected "nothing found" is worth one glance at
`meta.db_path`.

## The reading loop

Two shapes. Pick by what you need, not by habit.

**`context` — one bounded search-and-evidence call.** Use when you want
citation-ready material in a single step and don't intend to drill further.

```bash
agentbrain context "agent memory" --limit 6 --max-chars 12000 --json
```

Each hit carries bounded chunk `content` plus a prebuilt `citation` string:

```
[document_id:782 chunk_id:11246] What is Agent Memory? — https://www.letta.com/blog/agent-memory
```

`data` also reports `returned_chars` and `truncated`, so you know when the
budget clipped evidence. Linked resources are never concatenated into a hit —
what you get is what that chunk says.

**`search` → `get` — the ladder.** Use when you expect to triage many hits and
pull only the winners, or when you need a whole document.

```bash
# 1. Rank cheaply
agentbrain search "agent memory" --limit 10 --json

# 2. Pull only what earned it
agentbrain get --chunk-id 11246 --json                  # one chunk
agentbrain get --document-id 782 --char-limit 12000 --json
agentbrain get --document-id 782 --full --json          # whole document
agentbrain get --source-uri https://example.com/article --json
```

A search hit carries `document_id`, `chunk_id`, `chunk_index`, `title`,
`source_uri`, `source_type`, `resource_kind`, `sensitivity`, `content_kind`,
`tags`, `collections`, `sources`, `relations`, `updated_at`, `start_char`,
`end_char`, `score`, and a `snippet` whose matched terms are wrapped in
`⟦…⟧`. `score` is SQLite bm25 — negative, and more negative is a better match.
Results arrive already ranked; don't re-sort them.

`get --document-id` additionally returns `outbound_links` and `inbound_links`
relation arrays when the link graph has rows for that document — useful for
"what else did this article point at."

## Query language and filters

`--mode` controls how the query is tokenized:

| Mode | Behavior | Use |
|---|---|---|
| `any` (default) | terms joined with OR | always the first pass |
| `all` | every term/phrase required | narrowing a noisy `any` result |
| `raw` | SQLite FTS5 `MATCH` syntax passed through | phrases, `NEAR`, explicit boolean |

```bash
agentbrain search --mode all "cli mcp agents" --json
agentbrain search --mode raw '"agent memory" OR "context window"' --json
```

`data.normalized_query` echoes exactly what was executed — read it when hits
surprise you. Filters compose with any query and any mode:

| Filter | Selects |
|---|---|
| `--tag <tag>` | exact document tag |
| `--collection <slug>` | exact collection membership (e.g. `saved-links`) |
| `--content-kind post\|thread\|article` | parser-derived classification |
| `--source <id>` | exact recurring-source identifier |
| `--sensitivity public\|normal\|sensitive\|private` | effective handling policy |
| `--date`, `--date-from`, `--date-to` | document update date or ISO timestamp |

(`--source-type`, `--resource-kind`, and `--local-path` also exist for legacy
and path-exact selection; `agentbrain help search` lists them all.)

Page with `--limit` (max 50) and `--offset`; `data.next_offset` is the cursor
and is `null` on the last page. `--jsonl` streams one record per line, with a
leading `record_type: "meta"` record — useful for wide scans you intend to
filter in a pipe.

## When brain is silent

A zero-hit query is a lead, not a verdict. Work down this ladder before
concluding anything:

1. **Alternate terms.** `--mode any` already ORs; the failure is usually
   vocabulary, not coverage. Try the author's words, the product name, the
   error string, the acronym expanded.
2. **Drop filters.** A `--tag` or `--collection` that doesn't exist silently
   empties a good query. Confirm against `agentbrain tags --json`.
3. **Inventory.** `agentbrain stats --json` shows `document_count`,
   `by_source_type`, `top_tags`, and the most recent documents — enough to
   tell "the index is thin here" from "my query was wrong."
   `agentbrain sources list --json` shows which recurring producers feed it.
4. **Only then infer absence** — and say which terms you tried.

When the index genuinely lacks it, escalate outward: the `search` skill for
grounded web research with citations, the `scrape` skill to fetch and extract
a URL you already have. Then bring the good result back with `submit` so the
next session finds it locally.

## Writing: durable admission

`submit` is the single admission boundary for every kind of material.

```bash
agentbrain submit https://example.com/article --json
agentbrain submit ./notes/research.md --json
agentbrain submit ./corpus/ --max-files 1000 --json
agentbrain submit "a durable note worth keeping" --kind text --title "Note" --json

# Curate at submission time — it is much cheaper than retagging later
agentbrain submit https://example.com/article \
  --collection saved-links --tag agent-memory --notes "cited in the memory doc" --json
```

What happens, precisely: local bytes are snapshotted into the Artifact store
*before* acknowledgement, so the file can change or vanish afterwards without
losing the submission. URL admission performs **no network work** — it
validates HTTP(S) syntax, normalizes the locator, and queues. Materialization
happens later when the resident worker leases the job and delegates extraction
to Agentscrape, which is the sole network boundary.

The acknowledgement is `{version, status, job_id, idempotency_key,
intent_hash, state}`. Read `status`:

| `status` | Meaning | Your move |
|---|---|---|
| `queued` | new durable job created | note `job_id`; it becomes searchable after the worker runs |
| `duplicate` | equivalent intent already queued, same `job_id` | **success** — do not resubmit |
| `already_indexed` | this URL's resource identity already has a materialized document | use the returned `document_id` directly; `--force` queues rematerialization |

All three exit 0. `duplicate` in particular is a healthy answer, not an error —
re-sharing a link is idempotent by design. Reusing an explicit
`--idempotency-key` for a *different* intent fails with exit 2.

`--wait` observes the admitted job without bypassing the worker; on timeout it
exits **0** with `data.wait_status: "timeout"` and the job stays queued and
recoverable. (Exit 124 is a different surface — `sources sync --wait`.)
Waiting only helps when a worker is actually running; it is not a way to force
extraction.

Sensible defaults worth knowing: directories recurse with `--max-files 300`,
`--skip-secrets` is on, and per-file/text capture caps at 5 MB.

## The ledger

Every admission is a durable job with attempts and transitions. This is how
you answer "did that link ever land?"

```bash
agentbrain jobs stats --json                    # by_state counts, runnable_due, leases
agentbrain jobs list --state failed --limit 20 --json
agentbrain jobs list --state blocked --json
agentbrain jobs show 1234 --json                # + attempts[] and transitions[]
```

`jobs stats` reports `by_state` across `queued`, `running`, `retry_wait`,
`blocked`, `failed`, `completed`, `excluded`, `cancelled`, plus `runnable_due`,
`active_leases`, `stale_leases`, and `oldest_runnable_at`.

**Ordinary `jobs show` deliberately omits the durable intent** — no URL, no
text body, no Artifact contents. `--reveal-content` reads Artifact bodies and
appends a sensitive-inspection audit record. Pass it only when the body is
genuinely required, and say why.

Retry, cancel, and exclude are explicit operator acts. They append transitions
and preserve every attempt; nothing is rewritten.

```bash
agentbrain jobs retry 1234 --reason "extractor fixed" --actor agent --json
agentbrain jobs cancel 1234 --reason "no longer wanted" --actor agent --json
agentbrain jobs exclude 1234 --reason "paywalled, won't recover" --actor agent --json
```

Prefer proposing these to the user over performing them unprompted — a
stranded job is evidence, and disposing of it is a decision.

## Health and recovery

**A submission never landed.** The path is ledger first, health second:

```bash
agentbrain jobs list --state failed --json      # and --state blocked
agentbrain jobs show <id> --json                # failure_class + attempt history
agentbrain doctor --json
```

A **stranded** job is one in `blocked` or `failed` that carries a
`failure_class`: an attempt ran, no retry will revive it, and the link the
user saved never became searchable. `doctor` reports these as
`stranded_ingestion` and goes unhealthy — that is the intended reading.
`excluded` and `cancelled` are operator dispositions and are never stranded; a
job withheld before any attempt is reported separately as `admission_review`,
at warning, because an undecided question is not a defect.

The most common cause of mass stranding is `agentscrape` missing from the
worker's `PATH` — `doctor`'s `agentscrape` check names it. Text, file, and
directory ingestion is unaffected; only URL extraction degrades.

**Nothing is being drained at all.** `jobs stats` showing a rising `queued`
with `active_leases: 0` means the resident worker isn't running. That is
Funk-managed service state (`agentbrain.worker`), not something to fix by
launching a second worker beside the installed one — say so and let the human
decide.

## Output contract

Every `--json` call emits one envelope:

```json
{"schema_version": 1, "ok": true, "command": "search",
 "data": {...}, "meta": {"db_path": "…", "read_only": true, "generated_at": "…"}}
```

On failure, `error` replaces `data` and `meta` is absent:

```json
{"schema_version": 1, "ok": false, "command": "get",
 "error": {"code": "not_found", "message": "document not found"}}
```

`error.recovery` carries a concrete next step when one exists (`db_not_found`
answers "Pass --db PATH or set AGENTBRAIN_DB."). Follow it.

| Exit | Meaning |
|---|---|
| 0 | success |
| 1 | runtime, extraction, indexing, not-found, or database failure |
| 2 | argument or pre-admission validation error |
| 124 | `sources sync --wait` observation timeout — **the durable Run continues** |

124 means only that *you* stopped watching. The Run keeps executing in the
worker; re-check with `sources status` or `jobs stats` rather than re-firing
the sync.

## Recipes

**"Have we researched this?"** — the default opening move.

```bash
agentbrain context "retrieval augmented generation evaluation" --limit 6 --json
```

**"Didn't we read something about X?"** — a title or half-remembered phrase.

```bash
agentbrain search "prompt caching" --limit 10 --json
agentbrain get --document-id <winner> --full --json
```

**Everything saved on a topic** — scoped by date, curation, or form:

```bash
agentbrain search "agent memory" --date-from 2026-01-01 --limit 20 --json
agentbrain search "agent memory" --collection saved-links --limit 20 --json
agentbrain search "agent memory" --content-kind article --limit 10 --json
```

**Keep something worth keeping**, then confirm it landed:

```bash
agentbrain submit https://example.com/post --collection saved-links --tag topic --json
# → {"status":"queued","job_id":4321}
agentbrain jobs show 4321 --json     # later; completed means it is searchable
```

**Did my earlier submission land?**

```bash
agentbrain jobs stats --json
agentbrain search "distinctive phrase from that page" --limit 5 --json
```

**Survey the index before a research plan.**

```bash
agentbrain stats --json
agentbrain tags --limit 50 --json
agentbrain sources list --json
```

## What else feeds this index

Agents are not the main ingress, and recognizing the other fingerprints keeps
you from misreading the ledger:

- **Share ingress** (`agentbrain.share`) — an authenticated local HTTP listener
  that a Chrome extension and an Android share target post to. Every share
  resolves to exactly one Admission through the same `submit` path, so a
  re-share returns `duplicate` with the same `job_id`.
- **Recurring sources** — X accounts and blog feeds registered declaratively
  and synced on a cadence. `sources sync` admits durable Runs and performs no
  HTTP work itself.
- **The worker** (`agentbrain.worker`) — leases jobs, delegates extraction,
  commits fenced outcomes.

All three are Funk-managed services. Agents read them; service problems route
to the human.

## Anti-patterns

| Don't | Do |
|---|---|
| `submit <url>` then immediately `search` for it | note the `job_id`; extraction is asynchronous |
| Treat `duplicate` as a failure and resubmit | it is success with the same `job_id` |
| Reach for a web search first | brain first; escalate to the `search` skill only when brain is silent |
| Declare absence after one zero-hit query | alternate terms → drop filters → `stats`/`tags` → then infer |
| Start with `--mode all` | `any` first, narrow with `all` or filters after |
| Bulk-submit a whole directory of unvetted material | submit deliberately, with `--tag`/`--collection` |
| Pass `--reveal-content` casually | ordinary `jobs show`; reveal writes an audit record |
| `jobs retry/cancel/exclude` unprompted | propose it — disposition is an operator decision |
| Run your own `agentbrain worker` alongside the installed one | report that the resident worker is down |
| Open `research.db` or write SQL directly | the CLI; reads are read-only by construction |
| Paraphrase index content with no ids | cite `document_id`, `chunk_id`, `title`, `source_uri` |
| `delete` or `retag` to "tidy up" | `delete` purges a Resource, `retag` rewrites tags index-wide; ask first |

## Discovery and drift

The CLI teaches itself; prefer asking it over trusting this file:

```bash
agentbrain guide --json          # the machine card: commands, contracts, exit codes
agentbrain --agent-help          # the in-binary runbook (this skill is the deep version)
agentbrain --help                # every command and global flag
agentbrain help <command>        # per-command options and semantics
agentbrain --agent-teaser        # one-line capability summary
```

`guide --json` is the authority on the output contract, the read-only vs
mutation command split, the submission statuses, the citation fields, and the
exit codes. After an agentbrain upgrade, that one call is the re-sync — and
this skill's claims should be re-verified against the live CLI before they are
repeated.

## Sibling skills

| Skill | Reach for it when |
|---|---|
| `search` | brain is silent and you need the open web, with citations — a paid call, so brain first |
| `scrape` | you need a URL's content *now*; `submit` is for durable indexing instead of, or in addition to, reading it |
| `wiki` | the target is an authored document or artifact, not ingested research |
| `chats` | the answer lives in a past coding-agent session rather than in saved reading |

## For the human

Saving is a one-tap act, not a CLI act: the Chrome extension (toolbar button,
right-click, or `Ctrl+Shift+S`) and the Android share sheet both post into this
same index. If links stop showing up, `agentbrain doctor` names the failing
check, and the installed `agentbrain.doctor` LaunchAgent notifies when the
stranded count rises.
