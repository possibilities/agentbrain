# External scheduling for recurring Sources

Agentbrain stores recurring Source policy and ingestion state; an external scheduling service only invokes commands. Agentscrape owns live X and feed transport. Keep the installed Agentbrain Worker running so admitted source jobs are executed.

## Register Sources

Registration is declarative and versioned. Keep manifests private when their URLs are private; never put credentials in payload URLs or manifest fields. `credential_refs` are opaque names, not secret values.

### X account

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

X polling is forward-only from a stable status-ID checkpoint with bounded overlap. It does not claim complete historical pagination. The configured Agentscrape/browser session must already be able to view the timeline.

### Direct RSS or Atom feed

```json
{
  "schema_version": 1,
  "sources": [
    {
      "id": "feed.example",
      "version": 1,
      "kind": "blog_feed",
      "display_name": "Example feed",
      "enabled": true,
      "payload": {
        "feed_url": "https://example.com/feed.xml",
        "source_kind": "feed"
      },
      "schedule": { "cadence_seconds": 21600 },
      "limits": { "max_items_per_run": 50, "max_pages_per_run": 2 },
      "collections": ["blogs"],
      "sensitivity": "public",
      "credential_refs": []
    }
  ]
}
```

A configured `feed_url` is treated as a direct feed even when `source_kind` is omitted. Conditional validators are reused only when the checkpoint is bound to the same configured retrieval URL, exact redirect-effective validator URL, and Source definition version; a changed URL, redirect target, or definition performs a full request first. Homepage autodiscovery deliberately does not reuse feed validators because the advertised target may change between polls.

### Blog homepage with feed autodiscovery

Use `homepage_url` when the site advertises RSS or Atom through an explicit HTML alternate link:

```json
{
  "schema_version": 1,
  "sources": [
    {
      "id": "blog.example",
      "version": 1,
      "kind": "blog_source",
      "display_name": "Example blog",
      "enabled": true,
      "payload": {
        "homepage_url": "https://example.com/",
        "source_kind": "auto"
      },
      "schedule": { "cadence_seconds": 86400 },
      "limits": { "max_items_per_run": 50, "max_pages_per_run": 2 },
      "collections": ["blogs"],
      "sensitivity": "public",
      "credential_refs": []
    }
  ]
}
```

Autodiscovery does not scrape arbitrary homepage links. It follows only an explicit RSS/Atom/XML `<link rel="alternate">`; configure `feed_url` directly when known.

Apply and inspect:

```bash
agentbrain sources apply --manifest /absolute/path/to/sources.json \
  --actor operator --reason "register recurring sources" --json
agentbrain sources show x.example --json
agentbrain sources status x.example --json
```

Changing a definition requires a higher `version`. A higher version may enable or disable it. Omitting an existing Source does not delete it.

## Command to register with the scheduler

Prefer one idempotent command per Source:

```bash
/absolute/path/to/agentbrain sources sync x.example \
  --due \
  --wait \
  --wait-timeout-seconds 300 \
  --wait-timeout-ok \
  --json
```

The scheduler may fire more frequently than the Source cadence. The exact version-1 receipt is documented in [`docs/contracts/source-sync-trigger-v1.md`](../contracts/source-sync-trigger-v1.md). Agentbrain returns:

- `queued`: a new durable source Run was admitted;
- `duplicate`: an already pending/active Run was rejoined;
- `not_due`: no new Run; with `--wait`, the latest terminal Run is returned when present, so an earlier observer timeout cannot hide a later failure. No prior Run or a latest success exits 0; a latest non-success exits 1;
- `disabled`, `paused`, or `unsupported`: no Run, exit 1 with `--wait`;
- terminal `success`: discovery/checkpoint completed, exit 0;
- terminal `partial`, `failed`, or `cancelled`: exit 1;
- wait timeout: `timed_out:true`; default exit 124, or exit 0 with scheduler-oriented `--wait-timeout-ok`. The Run remains durable and retrying the command rejoins it.

`--wait` waits through source discovery and durable fanout. It intentionally does **not** wait for every discovered URL extraction to finish. Those child jobs retain independent retry and failure state.

For manual catch-up across all overdue Sources:

```bash
agentbrain sources sync --due --wait --limit 1000 --json
```

Per-Source commands are preferable for a scheduler because each invocation yields one stable Source outcome. Register direct argv—not a shell command string—with an absolute Agentbrain executable, stable absolute working directory (or none), stdin closed, a bounded runtime longer than Agentbrain's own wait timeout, and only the required environment (`HOME`, locale, any explicit Agentbrain database setting, and a `PATH` that resolves the installed launcher's pinned Bun runtime). `--wait-timeout-ok` is appropriate when the supervisor treats all nonzero exits as execution failures: JSON still records the observation timeout while the independently durable Run continues.

## Observe and operate

```bash
agentbrain sources status x.example --json
agentbrain jobs stats --json
agentbrain jobs run RUN_ID --json
agentbrain sources pause x.example --reason "provider maintenance" --json
agentbrain sources resume x.example --json
agentbrain doctor --json
```

A successful Source Run proves that discovery observations, suppressions, child admissions, and checkpoint advancement were committed consistently. Inspect the general job queue for child extraction failures. If a source-sync job is blocked, failed, cancelled, or excluded, fix/resume the Source as needed and admit a new Source Run with `sources sync`; terminal source-sync jobs are not reopened in place.

## Feed correctness and safety

Live feed fetching occurs only in Agentscrape. It applies URL and destination policy on initial requests, redirects, discovered feed URLs, and pagination; bounds redirects, time (maximum 300 seconds), live pages (10), items, total response bytes (20 MB), and per-response bytes; rejects unsafe local/private destinations; disables XML entities/DTDs; and treats feed absence as non-deletion. Conditional ETag/Last-Modified values come from an Agentbrain checkpoint bound to the same configured retrieval URL, exact effective validator URL, and definition version. A matching `304 Not Modified` is a successful empty window. If a Source definition changes while discovery is running, observations remain durable but the stale Run becomes partial and cannot publish its checkpoint or mutate the newer Source's pause/health policy.

Before activating live feeds, verify that the PATH-resolved producer advertises `Usage: agentscrape discover-feed [FILE] --source-url URL`. Agentbrain performs the same capability preflight and classifies a recorded-only producer as configuration failure rather than retrying forever. Deploy the Agentbrain consumer first, then the live-feed-capable Agentscrape producer, and only then enable Sources.

Recorded-response mode remains available for deterministic replay:

```bash
agentscrape discover-feed response.xml \
  --source-url https://example.com/feed.xml \
  --source-kind feed --format json
```
