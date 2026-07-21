import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DurableSubmissionIntent } from "../src/admission";
import type {
  FeedDiscoveryEnvelope,
  SourceDiscoveryProvider,
  XTimelineDiscoveryEnvelope,
  XTimelineDiscoveryRequest,
} from "../src/scrapectl";
import {
  DEFAULT_SOURCE_MANIFEST_PATH,
  isExecutableSourceKind,
  readSourceManifest,
  SourceRegistry,
} from "../src/sources";
import { ResearchStore } from "../src/store";
import type { SourceDefinition, SourceManifest } from "../src/types";
import { normalizedWebUrl, xStatusId } from "../src/url";
import { type JobMaterializer, runWorker } from "../src/worker";

const REPO = join(import.meta.dir, "..");
const ACTIVATION_OVERLAY_PATH = join(REPO, "config", "sources.activation.yaml");
const CONFIRMED_KINDS = new Set(["blog_source", "x_account"]);
const DAY_SECONDS = 24 * 60 * 60;
const HOUR_SECONDS = 60 * 60;
const T0 = new Date("2026-07-21T00:00:00.000Z");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempStore(): ResearchStore {
  const root = mkdtempSync(join(tmpdir(), "agentbrain-source-activation-"));
  roots.push(root);
  return new ResearchStore(join(root, "research.db"));
}

function baseManifest(): SourceManifest {
  return readSourceManifest(DEFAULT_SOURCE_MANIFEST_PATH);
}

/** The bundled disabled manifest merged with the committed activation overlay. */
function activatedManifest(): SourceManifest {
  return readSourceManifest(
    DEFAULT_SOURCE_MANIFEST_PATH,
    ACTIVATION_OVERLAY_PATH,
  );
}

function idsByKind(
  manifest: SourceManifest,
  predicate: (source: SourceDefinition) => boolean,
): string[] {
  return manifest.sources
    .filter(predicate)
    .map((source) => source.id)
    .sort();
}

test("the committed overlay enables exactly the confirmed cohort and no candidate", () => {
  const base = baseManifest();
  const activated = activatedManifest();

  const confirmedIds = idsByKind(base, (source) =>
    CONFIRMED_KINDS.has(source.kind),
  );
  const candidateIds = idsByKind(
    base,
    (source) => source.kind === "x_account_candidate",
  );
  expect(confirmedIds).toHaveLength(25);
  expect(candidateIds).toHaveLength(13);

  const enabledIds = idsByKind(activated, (source) => source.enabled);
  // Activation is precisely the confirmed set: every confirmed source enabled,
  // every one of the 13 recommendation candidates left disabled.
  expect(enabledIds).toEqual(confirmedIds);
  for (const source of activated.sources) {
    if (CONFIRMED_KINDS.has(source.kind)) {
      expect(source.enabled).toBe(true);
      // Flipping enabled is a definition change; it must ride a version bump so
      // `sources apply` accepts it over the disabled v1 baseline.
      expect(source.version).toBe(2);
    } else {
      expect(source.enabled).toBe(false);
    }
  }
});

test("activated confirmed sources keep bounded, forward-only schedules", () => {
  const activated = activatedManifest();
  for (const source of activated.sources) {
    if (source.kind === "blog_source") {
      expect(source.schedule.cadence_seconds).toBe(DAY_SECONDS);
      expect(source.limits.max_pages_per_run).toBeLessThanOrEqual(2);
    } else if (source.kind === "x_account") {
      expect(source.schedule.cadence_seconds).toBe(HOUR_SECONDS);
      // A single page per run forbids deep pagination: forward-only X polling
      // can never silently request complete historical backfill (ADR 0009).
      expect(source.limits.max_pages_per_run).toBe(1);
      expect(source.limits.max_items_per_run).toBeLessThanOrEqual(100);
    }
  }
  expect(isExecutableSourceKind("blog_source")).toBe(true);
  expect(isExecutableSourceKind("x_account")).toBe(true);
  expect(isExecutableSourceKind("x_account_candidate")).toBe(false);
});

test("applying the overlay schedules durable runs for confirmed sources only", () => {
  const store = tempStore();
  try {
    const registry = new SourceRegistry(store);
    const base = baseManifest();
    // First install the bundled disabled manifest, then apply the activation
    // overlay as a version-gated update — the real operator rollout sequence.
    registry.applySourceManifest(base, { now: T0 });
    const applied = registry.applySourceManifest(activatedManifest(), {
      now: new Date("2026-07-21T00:00:01.000Z"),
    });
    const changed = applied
      .filter((result) => result.changed)
      .map((result) => result.source_id)
      .sort();
    expect(changed).toEqual(
      idsByKind(base, (source) => CONFIRMED_KINDS.has(source.kind)),
    );

    const due = registry.syncDueSources({
      now: new Date("2026-07-21T00:05:00.000Z"),
    });
    const queued = due
      .filter((admission) => admission.status === "queued")
      .map((admission) => admission.source_id)
      .sort();
    expect(queued).toEqual(
      idsByKind(base, (source) => CONFIRMED_KINDS.has(source.kind)),
    );

    // Schedule admission only creates durable source_sync jobs; it never runs
    // discovery or materializes a document inline.
    expect(
      store.db
        .query(
          "SELECT COUNT(*) AS count FROM runs WHERE run_type='source_sync'",
        )
        .get(),
    ).toEqual({ count: 25 });
    expect(
      store.db.query("SELECT COUNT(*) AS count FROM documents").get(),
    ).toEqual({ count: 0 });
  } finally {
    store.close();
  }
});

const materialize: JobMaterializer = (
  _job,
  intent: DurableSubmissionIntent,
) => {
  if (intent.kind !== "url" || !("url" in intent.payload)) {
    throw new Error("source activation fixture expected a URL intent");
  }
  const url = intent.payload.url.url;
  const statusId = xStatusId(url);
  return [
    {
      sourceType: statusId === null ? "url" : "x",
      sourceUri: url,
      title: url,
      content: `indexed ${url}`,
      resourceKey:
        statusId === null
          ? { type: "url", value: normalizedWebUrl(url) }
          : { type: "x:status", value: statusId },
    },
  ];
};

async function drain(
  store: ResearchStore,
  discovery: SourceDiscoveryProvider,
  now: Date,
): Promise<void> {
  await runWorker(store, {
    once: true,
    workerId: "activation-test-worker",
    now: () => now,
    sourceDiscovery: discovery,
    materialize,
    installSignalHandlers: false,
    policy: { infraBaseMs: 1, infraCapMs: 1, jitterRatio: 0 },
  });
}

function count(store: ResearchStore, table: string, where = "1=1"): number {
  return (
    store.db
      .query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
      .get() as { count: number }
  ).count;
}

function feedItem(
  stableId: string,
  url: string,
): FeedDiscoveryEnvelope["items"][number] {
  return {
    stable_id: stableId,
    upstream_id: stableId,
    identity_source: "upstream_id",
    url,
    candidate_urls: [url],
    title: stableId,
    published_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
    tombstone: false,
  };
}

function feedEnvelope(
  sourceUrl: string,
  items: FeedDiscoveryEnvelope["items"],
  etag: string,
): FeedDiscoveryEnvelope {
  const newest = items[0]?.updated_at ?? null;
  return {
    schema_version: "1",
    status: "success",
    source_url: sourceUrl,
    source_format: "rss",
    validators: { etag, last_modified: null },
    cursor: {
      validators: { etag, last_modified: null },
      newest_seen_at: newest,
      next_url: null,
    },
    items,
    pagination: {
      pages: [
        {
          url: sourceUrl,
          page_format: "rss",
          validators: { etag, last_modified: null },
          item_count: items.length,
          next_url: null,
        },
      ],
      complete: true,
      stop_reason: "exhausted",
      next_url: null,
    },
    warnings: [],
    absence_implies_deletion: false,
    failure: null,
  };
}

test("a confirmed blog run is durable and repeated overlap adds no index effects", async () => {
  const store = tempStore();
  try {
    const registry = new SourceRegistry(store);
    registry.applySourceManifest(activatedManifest(), { now: T0 });

    // Confirmed blogs carry only a homepage_url; discovery still routes through
    // the feed path. The stub returns the discovered items a live Scrapectl run
    // would, so the durable ledger behaviour is exercised offline.
    const sourceUrl = "https://simonwillison.net/";
    const items = [
      feedItem("post-b", "https://simonwillison.net/2026/two"),
      feedItem("post-a", "https://simonwillison.net/2026/one"),
    ];
    let feedPolls = 0;
    const discovery: SourceDiscoveryProvider = {
      discoverFeed: () => {
        feedPolls += 1;
        // Poll 1 and 2 observe the same window (overlap); poll 3 is an empty
        // window that must never delete anything already indexed.
        if (feedPolls >= 3) {
          return Promise.resolve(feedEnvelope(sourceUrl, [], '"v3"'));
        }
        return Promise.resolve(
          feedEnvelope(sourceUrl, items, `"v${feedPolls}"`),
        );
      },
      discoverXTimeline: () => {
        throw new Error("blog activation fixture never polls X");
      },
    };

    const firstRun = registry.syncSource({
      sourceId: "blog.simon-willison",
      now: T0,
    });
    expect(firstRun.status).toBe("queued");
    await drain(store, discovery, T0);

    expect(registry.sourceCheckpoints("blog.simon-willison")).toHaveLength(1);
    expect(
      store.db
        .query(
          "SELECT terminal_outcome, discovered_count, admitted_count FROM runs WHERE id=?",
        )
        .get(firstRun.run_id),
    ).toMatchObject({
      terminal_outcome: "success",
      discovered_count: 2,
      admitted_count: 2,
    });
    expect(count(store, "jobs", "kind='url'")).toBe(2);
    expect(count(store, "documents")).toBe(2);

    // Overlap: the same window is re-observed. Idempotency must keep the index
    // exactly as it was — no duplicate jobs, resources, or documents.
    const t1 = new Date("2026-07-22T00:00:00.000Z");
    const overlapRun = registry.syncSource({
      sourceId: "blog.simon-willison",
      now: t1,
    });
    expect(overlapRun.status).toBe("queued");
    await drain(store, discovery, t1);
    expect(count(store, "jobs", "kind='url'")).toBe(2);
    expect(count(store, "documents")).toBe(2);

    // Absence: an empty window is not deletion. Nothing already indexed is lost.
    const t2 = new Date("2026-07-23T00:00:00.000Z");
    registry.syncSource({ sourceId: "blog.simon-willison", now: t2 });
    await drain(store, discovery, t2);
    expect(count(store, "documents")).toBe(2);
    expect(count(store, "resources", "kind='url'")).toBe(2);
  } finally {
    store.close();
  }
});

test("a confirmed X account polls forward within bounded, overlap-safe limits", async () => {
  const store = tempStore();
  try {
    const registry = new SourceRegistry(store);
    registry.applySourceManifest(activatedManifest(), { now: T0 });

    const tweets = [
      {
        id: "1002",
        url: "https://x.com/simonw/status/1002",
        text: "post 1002",
        created_at: "2026-07-20T00:00:00.000Z",
        is_reply: false,
        is_repost: false,
        is_quote: false,
        is_pinned: false,
        article_urls: [],
      },
      {
        id: "1001",
        url: "https://x.com/simonw/status/1001",
        text: "post 1001",
        created_at: "2026-07-19T00:00:00.000Z",
        is_reply: false,
        is_repost: false,
        is_quote: false,
        is_pinned: false,
        article_urls: [],
      },
    ];
    const xRequests: XTimelineDiscoveryRequest[] = [];
    const xEnvelope: XTimelineDiscoveryEnvelope = {
      handle: "simonw",
      next_cursor: null,
      scraped_at: T0.toISOString(),
      tweets,
      warnings: [],
    };
    const discovery: SourceDiscoveryProvider = {
      discoverFeed: () => {
        throw new Error("X activation fixture never polls a feed");
      },
      discoverXTimeline: (request: XTimelineDiscoveryRequest) => {
        xRequests.push(request);
        return Promise.resolve(xEnvelope);
      },
    };

    const run = registry.syncSource({ sourceId: "x.simonw", now: T0 });
    expect(run.status).toBe("queued");
    await drain(store, discovery, T0);

    // A single scroll per run is the bounded, forward-only contract: the source
    // limit flows into discovery and forbids deep historical pagination.
    expect(xRequests).toHaveLength(1);
    expect(xRequests[0]?.maxScrolls).toBe(1);
    expect(
      store.db
        .query("SELECT terminal_outcome FROM runs WHERE id=?")
        .get(run.run_id),
    ).toMatchObject({ terminal_outcome: "success" });
    expect(count(store, "jobs", "kind='url'")).toBe(2);
    expect(count(store, "documents")).toBe(2);

    // Overlap: re-polling the same timeline window indexes nothing new.
    const t1 = new Date("2026-07-21T01:00:00.000Z");
    registry.syncSource({ sourceId: "x.simonw", now: t1 });
    await drain(store, discovery, t1);
    expect(count(store, "jobs", "kind='url'")).toBe(2);
    expect(count(store, "documents")).toBe(2);
  } finally {
    store.close();
  }
});
