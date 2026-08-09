# External scheduling for recurring Sources

Agentbrain stores recurring Source policy and ingestion state; an external scheduling service only invokes commands. Agentscrape owns live X and feed transport. Keep the installed Agentbrain Worker running so admitted source jobs are executed.

## Register Sources

Registration is declarative and versioned. Keep manifests private when their URLs are private; never put credentials in payload URLs or manifest fields. `credential_refs` are opaque names, not secret values.

```json
{
  "schema_version": 1,
  "sources": [
    {
      "id": "x.example",
      "version": 1,
      "kind": "x_account",
      "display_name": "Example on X",
      "enabled": true,
      "payload": {
        "handle": "example",
        "profile_url": "https://x.com/example",
        "include_replies": false,
        "include_reposts": false
      },
      "schedule": { "cadence_seconds": 3600 },
      "limits": { "max_items_per_run": 25, "max_pages_per_run": 1 },
      "collections": ["x-accounts"],
      "sensitivity": "public",
      "credential_refs": []
    }
  ]
}
```

`config/sources.json` carries one disabled example per kind, and names `config/sources.schema.json` in its `$schema` key so an editor can validate a manifest as it is written — the loader tolerates and strips that one key, and rejects any other key it does not know by name (the schema file itself is generated from `src/source-manifest-schema.ts` by `bun run generate:schema`). Only `payload` differs between them:

| `kind` | Identity payload | Constraint |
|---|---|---|
| `x_account` | `handle`, `profile_url`, optional `include_replies` / `include_reposts` | Forward-only from a stable status-ID checkpoint with bounded overlap; never complete historical pagination. The configured Agentscrape/browser session must already be able to view the timeline. |
| `blog_feed` | `feed_url`, optional `source_kind` | A configured `feed_url` is a direct feed even when `source_kind` is omitted. |
| `blog_source` | `homepage_url`, optional `source_kind` | Autodiscovery follows only an explicit RSS/Atom/XML `<link rel="alternate">` — never arbitrary homepage links. Configure `feed_url` directly when known. |

Conditional validators are reused only when the checkpoint is bound to the same configured retrieval URL, exact redirect-effective validator URL, and Source definition version; a changed URL, redirect target, or definition performs a full request first. Homepage autodiscovery deliberately does not reuse feed validators, because the advertised target may change between polls.

```bash
agentbrain sources apply --manifest /absolute/path/to/sources.json \
  --actor operator --reason "register recurring sources" --json
agentbrain sources show x.example --json
```

Changing a definition requires a higher `version`. A higher version may enable or disable it. Omitting an existing Source does not delete it.

## Command to register with the scheduler

Prefer one idempotent command per Source. The scheduler may fire more frequently than the Source cadence.

```bash
/absolute/path/to/agentbrain sources sync x.example \
  --due --wait --wait-timeout-seconds 300 --wait-timeout-ok --json
```

[`docs/contracts/source-sync-trigger-v1.md`](../contracts/source-sync-trigger-v1.md) documents the receipt and every status/exit-code pair. `--wait` waits through source discovery and durable fanout; it intentionally does **not** wait for every discovered URL extraction to finish, because those child jobs retain independent retry and failure state.

Register direct argv — not a shell command string — with an absolute Agentbrain executable, stable absolute working directory (or none), stdin closed, a bounded runtime longer than Agentbrain's own wait timeout, and only the required environment (`HOME`, locale, any explicit database setting, and a `PATH` that resolves the installed launcher's Bun runtime). `--wait-timeout-ok` suits a supervisor that treats every nonzero exit as an execution failure: the JSON still records the observation timeout while the independently durable Run continues.

## Observe and operate

`sources status`, `jobs stats`, `sources pause|resume`, and `doctor` are the inspection surface. A successful Source Run proves that discovery observations, suppressions, child admissions, and checkpoint advancement were committed consistently; child extraction failures show up in the general job queue instead. Terminal source-sync jobs are not reopened in place: fix or resume the Source, then admit a new Run.

## Feed correctness and safety

Live feed fetching occurs only in Agentscrape. It applies URL and destination policy on initial requests, redirects, discovered feed URLs, and pagination; bounds redirects, time (300 seconds), live pages (10), items, total response bytes (20 MB), and per-response bytes; rejects unsafe local/private destinations; disables XML entities/DTDs; and treats feed absence as non-deletion. A matching `304 Not Modified` is a successful empty window. If a Source definition changes mid-discovery, observations remain durable but the stale Run becomes partial and cannot publish its checkpoint or mutate the newer Source's pause/health policy.

Before activating live feeds, verify that the PATH-resolved producer advertises `Usage: agentscrape discover-feed [FILE] --source-url URL`. Agentbrain performs the same capability preflight and classifies a recorded-only producer as configuration failure rather than retrying forever. Deploy the Agentbrain consumer first, then the live-feed-capable Agentscrape producer, and only then enable Sources.
