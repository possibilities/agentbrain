import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DurableSubmissionIntent } from "../src/admission";
import {
  type FeedDiscoveryEnvelope,
  ScrapectlDiscoveryError,
  type SourceDiscoveryProvider,
  type XTimelineDiscoveryEnvelope,
} from "../src/scrapectl";
import { SourceRegistry, showSource } from "../src/sources";
import { ResearchStore } from "../src/store";
import type { SourceDefinition } from "../src/types";
import { normalizedWebUrl, xStatusId } from "../src/url";
import { type JobMaterializer, runWorker } from "../src/worker";

const roots: string[] = [];
const T0 = new Date("2026-07-20T00:00:00.000Z");

function fixture(): { store: ResearchStore; registry: SourceRegistry } {
  const root = mkdtempSync(join(tmpdir(), "agentbrain-source-worker-"));
  roots.push(root);
  const store = new ResearchStore(join(root, "research.db"));
  return { store, registry: new SourceRegistry(store) };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function blog(id = "blog-one"): SourceDefinition {
  return {
    id,
    version: 1,
    kind: "blog_feed",
    display_name: id,
    enabled: true,
    payload: { feed_url: `https://${id}.example/feed.xml` },
    schedule: { cadence_seconds: 86_400 },
    limits: { max_items_per_run: 10, max_pages_per_run: 3 },
    collections: ["blogs"],
    sensitivity: "normal",
    credential_refs: [],
  };
}

function xSource(id = "x-one"): SourceDefinition {
  return {
    id,
    version: 1,
    kind: "x_account",
    display_name: id,
    enabled: true,
    payload: { handle: "person", profile_url: "https://x.com/person" },
    schedule: { cadence_seconds: 3_600 },
    limits: { max_items_per_run: 10, max_pages_per_run: 4 },
    collections: ["x-posts"],
    sensitivity: "normal",
    credential_refs: [],
  };
}

function feedEnvelope(
  sourceUrl: string,
  items: FeedDiscoveryEnvelope["items"],
  overrides: Partial<FeedDiscoveryEnvelope> = {},
): FeedDiscoveryEnvelope {
  return {
    schema_version: "1",
    status: "success",
    source_url: sourceUrl,
    source_format: "rss",
    validators: { etag: '"v1"', last_modified: null },
    cursor: {
      validators: { etag: '"v1"', last_modified: null },
      newest_seen_at: items[0]?.updated_at ?? items[0]?.published_at ?? null,
      next_url: null,
    },
    items,
    pagination: {
      pages: [
        {
          url: sourceUrl,
          page_format: "rss",
          validators: { etag: '"v1"', last_modified: null },
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
    ...overrides,
  };
}

function feedItem(
  stableId: string,
  url: string,
  overrides: Partial<FeedDiscoveryEnvelope["items"][number]> = {},
): FeedDiscoveryEnvelope["items"][number] {
  return {
    stable_id: stableId,
    upstream_id: stableId,
    identity_source: "upstream_id",
    url,
    candidate_urls: [url],
    title: stableId,
    published_at: "2026-07-19T00:00:00.000Z",
    updated_at: "2026-07-19T00:00:00.000Z",
    tombstone: false,
    ...overrides,
  };
}

function xEnvelope(
  tweets: XTimelineDiscoveryEnvelope["tweets"],
  overrides: Partial<XTimelineDiscoveryEnvelope> = {},
): XTimelineDiscoveryEnvelope {
  return {
    handle: "person",
    next_cursor: null,
    scraped_at: T0.toISOString(),
    tweets,
    warnings: [],
    ...overrides,
  };
}

function tweet(
  id: string,
  text = `post ${id}`,
): XTimelineDiscoveryEnvelope["tweets"][number] {
  return {
    id,
    url: `https://x.com/person/status/${id}`,
    text,
    created_at: "2026-07-19T00:00:00.000Z",
    is_reply: false,
    is_repost: false,
    is_quote: false,
    is_pinned: false,
    article_urls: [],
  };
}

function provider(input: {
  feed?: SourceDiscoveryProvider["discoverFeed"];
  x?: SourceDiscoveryProvider["discoverXTimeline"];
}): SourceDiscoveryProvider {
  return {
    discoverFeed:
      input.feed ??
      (() => {
        throw new Error("unexpected feed discovery");
      }),
    discoverXTimeline:
      input.x ??
      (() => {
        throw new Error("unexpected X discovery");
      }),
  };
}

const materialize: JobMaterializer = (
  _job,
  intent: DurableSubmissionIntent,
) => {
  if (intent.kind !== "url" || !("url" in intent.payload)) {
    throw new Error("source fixture expected URL intent");
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
  options: {
    now?: Date;
    beforeCheckpointCommit?: () => void;
  } = {},
): Promise<void> {
  const now = options.now ?? T0;
  await runWorker(store, {
    once: true,
    workerId: "source-test-worker",
    now: () => now,
    sourceDiscovery: discovery,
    materialize,
    beforeSourceCheckpointCommit: options.beforeCheckpointCommit,
    installSignalHandlers: false,
    policy: { infraBaseMs: 1, infraCapMs: 1, jitterRatio: 0 },
  });
}

function sync(registry: SourceRegistry, sourceId: string, now = T0): number {
  const admission = registry.syncSource({ sourceId, now });
  expect(admission.status).toBe("queued");
  return admission.run_id as number;
}

function count(store: ResearchStore, table: string, where = "1=1"): number {
  return (
    store.db
      .query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
      .get() as {
      count: number;
    }
  ).count;
}

test("blog windows preserve benign warnings, dedupe, edits, and no-new health", async () => {
  const { store, registry } = fixture();
  registry.applySourceDefinitions([blog()], { now: T0 });
  const sourceUrl = "https://blog-one.example/feed.xml";
  const firstItems = [
    feedItem("entry-2", "https://shared.example/two"),
    feedItem("entry-1", "https://shared.example/one"),
    feedItem("gone", "https://shared.example/gone", { tombstone: true }),
    feedItem("entry-1", "https://shared.example/one"),
  ];
  let poll = 0;
  const discovery = provider({
    feed: () => {
      poll += 1;
      if (poll === 1) {
        return feedEnvelope(sourceUrl, firstItems, {
          warnings: [
            {
              code: "naive_date_assumed_utc",
              message: "one optional date was interpreted as UTC",
              page_url: sourceUrl,
            },
          ],
        });
      }
      if (poll === 2) {
        return feedEnvelope(
          sourceUrl,
          [
            feedItem("entry-2", "https://shared.example/two", {
              title: "edited title",
              updated_at: "2026-07-20T01:00:00.000Z",
            }),
          ],
          {
            validators: { etag: '"v2"', last_modified: null },
            cursor: {
              validators: { etag: '"v2"', last_modified: null },
              newest_seen_at: "2026-07-20T01:00:00.000Z",
              next_url: null,
            },
          },
        );
      }
      return feedEnvelope(sourceUrl, [], {
        validators: { etag: '"v3"', last_modified: null },
        cursor: {
          validators: { etag: '"v3"', last_modified: null },
          newest_seen_at: null,
          next_url: null,
        },
      });
    },
  });

  const firstRun = sync(registry, "blog-one");
  await drain(store, discovery);
  expect(registry.sourceCheckpoints("blog-one")).toHaveLength(1);
  expect(
    store.db
      .query(
        "SELECT terminal_outcome, discovered_count, admitted_count, suppressed_count, warnings FROM runs WHERE id=?",
      )
      .get(firstRun),
  ).toMatchObject({
    terminal_outcome: "success",
    discovered_count: 4,
    admitted_count: 2,
    suppressed_count: 2,
  });
  expect(count(store, "jobs", "kind='url'")).toBe(2);
  expect(count(store, "resources", "kind='url'")).toBe(3);

  const editedRun = sync(
    registry,
    "blog-one",
    new Date("2026-07-20T01:00:00.000Z"),
  );
  await drain(store, discovery, { now: new Date("2026-07-20T01:00:01.000Z") });
  expect(count(store, "jobs", "kind='url'")).toBe(3);
  expect(count(store, "jobs", `kind='url' AND run_id=${editedRun}`)).toBe(1);
  expect(count(store, "resources", "kind='url'")).toBe(3);
  const versions = store.db
    .query(
      `SELECT d.observed_version FROM source_observation_details d
       WHERE d.stable_id='entry-2' ORDER BY d.run_id`,
    )
    .all() as Array<{ observed_version: string }>;
  expect(versions).toHaveLength(2);
  expect(versions[0]?.observed_version).not.toBe(versions[1]?.observed_version);

  const jobsBeforeNoNew = count(store, "jobs", "kind='url'");
  sync(registry, "blog-one", new Date("2026-07-20T02:00:00.000Z"));
  await drain(store, discovery, { now: new Date("2026-07-20T02:00:01.000Z") });
  expect(count(store, "jobs", "kind='url'")).toBe(jobsBeforeNoNew);
  expect(registry.sourceCheckpoints("blog-one")).toHaveLength(3);
  expect(showSource(store.db, "blog-one").health).toMatchObject({
    state: "healthy",
    last_success_at: "2026-07-20T02:00:01.000Z",
  });
  store.close();
});

test("partial blog warnings persist admitted evidence without advancing the checkpoint", async () => {
  const { store, registry } = fixture();
  registry.applySourceDefinitions([blog()], { now: T0 });
  const sourceUrl = "https://blog-one.example/feed.xml";
  const runId = sync(registry, "blog-one");
  const discovery = provider({
    feed: () =>
      feedEnvelope(
        sourceUrl,
        [feedItem("entry-1", "https://partial.example/one")],
        {
          status: "partial",
          cursor: {
            validators: { etag: '"v1"', last_modified: null },
            newest_seen_at: "2026-07-19T00:00:00.000Z",
            next_url: "https://blog-one.example/archive/page-2",
          },
          pagination: {
            pages: [
              {
                url: sourceUrl,
                page_format: "rss",
                validators: { etag: '"v1"', last_modified: null },
                item_count: 1,
                next_url: "https://blog-one.example/archive/page-2",
              },
            ],
            complete: false,
            stop_reason: "page_limit",
            next_url: "https://blog-one.example/archive/page-2",
          },
          warnings: [
            {
              code: "page_limit_reached",
              message: "another page remains",
              page_url: sourceUrl,
            },
          ],
        },
      ),
  });

  await drain(store, discovery);

  expect(registry.sourceCheckpoints("blog-one")).toEqual([]);
  expect(count(store, "jobs", "kind='url'")).toBe(1);
  expect(
    store.db
      .query(
        `SELECT terminal_outcome, attempted_cursor, warnings,
                discovered_count, admitted_count, suppressed_count
         FROM runs WHERE id=?`,
      )
      .get(runId),
  ).toEqual({
    terminal_outcome: "partial",
    attempted_cursor: JSON.stringify({
      kind: "blog_feed",
      status: "partial",
      validators: { etag: '"v1"', last_modified: null },
      pagination: {
        complete: false,
        stop_reason: "page_limit",
        next_boundary_url: "https://blog-one.example/archive/page-2",
      },
    }),
    warnings: JSON.stringify(["page_limit_reached: another page remains"]),
    discovered_count: 1,
    admitted_count: 1,
    suppressed_count: 0,
  });
  expect(showSource(store.db, "blog-one")).toMatchObject({
    health: { state: "warning", last_success_at: null },
  });
  store.close();
});

test("shared blog discoveries reuse one Resource and ingestion job", async () => {
  const { store, registry } = fixture();
  registry.applySourceDefinitions([blog("blog-a"), blog("blog-b")], {
    now: T0,
  });
  const shared = "https://shared.example/article";
  const discovery = provider({
    feed: (request) =>
      feedEnvelope(request.sourceUrl, [feedItem("shared-entry", shared)]),
  });

  sync(registry, "blog-a");
  await drain(store, discovery);
  sync(registry, "blog-b", new Date("2026-07-20T00:10:00.000Z"));
  await drain(store, discovery, { now: new Date("2026-07-20T00:10:01.000Z") });

  expect(count(store, "jobs", "kind='url'")).toBe(1);
  expect(count(store, "resources", "key_type='url'")).toBe(1);
  expect(count(store, "source_observation_details")).toBe(2);
  store.close();
});

test("X uses bounded since_id overlap without treating diagnostic oldest IDs as cursors", async () => {
  const { store, registry } = fixture();
  registry.applySourceDefinitions([xSource()], { now: T0 });
  const requests: Array<string | undefined> = [];
  let poll = 0;
  const discovery = provider({
    x: (request) => {
      requests.push(request.sinceId);
      poll += 1;
      if (poll === 1) {
        return xEnvelope([tweet("105"), tweet("104"), tweet("103")], {
          next_cursor: "103",
        });
      }
      if (poll === 2) {
        return xEnvelope([
          tweet("106", "delayed new post"),
          tweet("105", "edited post 105"),
          tweet("104"),
        ]);
      }
      return xEnvelope([tweet("107")], { next_cursor: "106" });
    },
  });

  sync(registry, "x-one");
  await drain(store, discovery);
  expect(requests).toEqual([undefined]);
  const firstCheckpoint = JSON.parse(
    registry.sourceCheckpoints("x-one")[0]?.value ?? "null",
  ) as Record<string, unknown>;
  expect(firstCheckpoint).toMatchObject({ since_id: "105" });
  expect(firstCheckpoint).not.toHaveProperty("next_cursor");
  expect(firstCheckpoint).not.toHaveProperty("diagnostic_oldest_item_id");

  const overlapRun = sync(
    registry,
    "x-one",
    new Date("2026-07-20T01:00:00.000Z"),
  );
  await drain(store, discovery, { now: new Date("2026-07-20T01:00:01.000Z") });
  expect(requests[1]).toBe("102");
  expect(count(store, "jobs", "kind='url'")).toBe(5);
  expect(count(store, "jobs", `kind='url' AND run_id=${overlapRun}`)).toBe(2);
  expect(count(store, "resources", "key_type='x:status'")).toBe(4);
  expect(count(store, "source_observation_details", "stable_id='105'")).toBe(2);

  const checkpointsBeforePartial = registry.sourceCheckpoints("x-one").length;
  const partialRun = sync(
    registry,
    "x-one",
    new Date("2026-07-20T02:00:00.000Z"),
  );
  await drain(store, discovery, { now: new Date("2026-07-20T02:00:01.000Z") });
  expect(registry.sourceCheckpoints("x-one")).toHaveLength(
    checkpointsBeforePartial,
  );
  const partial = store.db
    .query("SELECT terminal_outcome, attempted_cursor FROM runs WHERE id=?")
    .get(partialRun) as { terminal_outcome: string; attempted_cursor: string };
  expect(partial.terminal_outcome).toBe("partial");
  expect(JSON.parse(partial.attempted_cursor)).toMatchObject({
    diagnostic_oldest_item_id: "106",
    boundary_complete: false,
  });
  store.close();
});

test("X overlap-only polls update health without manufacturing resource jobs", async () => {
  const { store, registry } = fixture();
  registry.applySourceDefinitions([xSource()], { now: T0 });
  const requests: Array<string | undefined> = [];
  const discovery = provider({
    x: (request) => {
      requests.push(request.sinceId);
      return xEnvelope([tweet("201")]);
    },
  });

  sync(registry, "x-one");
  await drain(store, discovery);
  const jobsAfterFirstPoll = count(store, "jobs", "kind='url'");

  sync(registry, "x-one", new Date("2026-07-20T01:00:00.000Z"));
  await drain(store, discovery, { now: new Date("2026-07-20T01:00:01.000Z") });

  expect(requests).toEqual([undefined, "200"]);
  expect(jobsAfterFirstPoll).toBe(1);
  expect(count(store, "jobs", "kind='url'")).toBe(1);
  expect(count(store, "resources", "key_type='x:status'")).toBe(1);
  expect(count(store, "source_observation_details", "stable_id='201'")).toBe(2);
  expect(registry.sourceCheckpoints("x-one")).toHaveLength(2);
  expect(showSource(store.db, "x-one").health).toMatchObject({
    state: "healthy",
    last_success_at: "2026-07-20T01:00:01.000Z",
  });
  store.close();
});

test("X policy exclusions are durable suppressions and all candidate types are requested", async () => {
  const { store, registry } = fixture();
  registry.applySourceDefinitions([xSource()], { now: T0 });
  const requests: Array<{
    replies: boolean | undefined;
    reposts: boolean | undefined;
  }> = [];
  const reply = { ...tweet("303"), is_reply: true };
  const repost = { ...tweet("302"), is_repost: true };
  const runId = sync(registry, "x-one");

  await drain(
    store,
    provider({
      x: (request) => {
        requests.push({
          replies: request.includeReplies,
          reposts: request.includeReposts,
        });
        return xEnvelope([reply, repost, tweet("301")]);
      },
    }),
  );

  expect(requests).toEqual([{ replies: true, reposts: true }]);
  expect(
    store.db
      .query(
        `SELECT terminal_outcome, discovered_count, admitted_count, suppressed_count
         FROM runs WHERE id=?`,
      )
      .get(runId),
  ).toEqual({
    terminal_outcome: "success",
    discovered_count: 3,
    admitted_count: 1,
    suppressed_count: 2,
  });
  expect(
    store.db
      .query(
        `SELECT suppressed_reason FROM observations
         WHERE run_id=? AND suppressed=1 ORDER BY suppressed_reason`,
      )
      .all(runId),
  ).toEqual([
    { suppressed_reason: "excluded_reply" },
    { suppressed_reason: "excluded_repost" },
  ]);
  expect(count(store, "jobs", "kind='url'")).toBe(1);
  expect(registry.sourceCheckpoints("x-one")).toHaveLength(1);
  store.close();
});

test("uncertain X warnings and contradictory feed boundaries never advance checkpoints", async () => {
  const x = fixture();
  x.registry.applySourceDefinitions([xSource()], { now: T0 });
  const xRun = sync(x.registry, "x-one");
  await drain(
    x.store,
    provider({
      x: () =>
        xEnvelope([tweet("401")], {
          warnings: [
            {
              code: "future_partial_boundary",
              message: "provider could not prove the lower boundary",
            },
          ],
        }),
    }),
  );
  expect(x.registry.sourceCheckpoints("x-one")).toEqual([]);
  expect(
    x.store.db
      .query("SELECT terminal_outcome, warnings FROM runs WHERE id=?")
      .get(xRun),
  ).toEqual({
    terminal_outcome: "partial",
    warnings: JSON.stringify([
      "future_partial_boundary: provider could not prove the lower boundary",
    ]),
  });
  expect(count(x.store, "jobs", "kind='url'")).toBe(1);
  x.store.close();

  const feed = fixture();
  feed.registry.applySourceDefinitions([blog()], { now: T0 });
  const feedRun = sync(feed.registry, "blog-one");
  const sourceUrl = "https://blog-one.example/feed.xml";
  await drain(
    feed.store,
    provider({
      feed: () =>
        feedEnvelope(
          sourceUrl,
          [feedItem("entry-1", "https://boundary.example/one")],
          {
            pagination: {
              pages: [
                {
                  url: sourceUrl,
                  page_format: "rss",
                  validators: { etag: '"v1"', last_modified: null },
                  item_count: 1,
                  next_url: null,
                },
              ],
              complete: true,
              stop_reason: "page_limit",
              next_url: null,
            },
          },
        ),
    }),
  );
  expect(feed.registry.sourceCheckpoints("blog-one")).toEqual([]);
  expect(count(feed.store, "jobs", "kind='url'")).toBe(0);
  expect(
    feed.store.db
      .query("SELECT state, terminal_outcome, warnings FROM runs WHERE id=?")
      .get(feedRun),
  ).toMatchObject({ state: "failed", terminal_outcome: "failed" });
  feed.store.close();
});

test("provider cancellation commits evidence, closes the Run, and allows a later sync", async () => {
  const { store, registry } = fixture();
  registry.applySourceDefinitions([blog()], { now: T0 });
  const sourceUrl = "https://blog-one.example/feed.xml";
  const runId = sync(registry, "blog-one");
  await drain(
    store,
    provider({
      feed: () =>
        feedEnvelope(
          sourceUrl,
          [feedItem("entry-1", "https://cancelled.example/one")],
          {
            status: "partial",
            pagination: {
              pages: [
                {
                  url: sourceUrl,
                  page_format: "rss",
                  validators: { etag: '"v1"', last_modified: null },
                  item_count: 1,
                  next_url: null,
                },
              ],
              complete: false,
              stop_reason: "cancelled",
              next_url: null,
            },
            failure: {
              code: "cancelled",
              retryable: false,
              message: "discovery was cancelled after one item",
            },
          },
        ),
    }),
  );

  expect(registry.sourceCheckpoints("blog-one")).toEqual([]);
  expect(
    store.db
      .query(
        `SELECT state, terminal_outcome, discovered_count, admitted_count
         FROM runs WHERE id=?`,
      )
      .get(runId),
  ).toEqual({
    state: "cancelled",
    terminal_outcome: "cancelled",
    discovered_count: 1,
    admitted_count: 1,
  });
  expect(
    store.db.query("SELECT state FROM jobs WHERE kind='source_sync'").get(),
  ).toEqual({ state: "cancelled" });
  expect(count(store, "source_observation_details")).toBe(1);
  expect(count(store, "jobs", "kind='url'")).toBe(1);
  expect(
    registry.syncSource({
      sourceId: "blog-one",
      now: new Date("2026-07-20T01:00:00.000Z"),
    }).status,
  ).toBe("queued");
  store.close();
});

test("invalid durable checkpoints fail closed before provider execution", async () => {
  const { store, registry } = fixture();
  registry.applySourceDefinitions([xSource()], { now: T0 });
  sync(registry, "x-one");
  await drain(store, provider({ x: () => xEnvelope([tweet("501")]) }));
  store.db
    .query("UPDATE sources SET checkpoint=? WHERE identifier='x-one'")
    .run(
      JSON.stringify({
        version: 1,
        kind: "x_account",
        since_id: "not-numeric",
        recent_ids: ["501"],
        newest_seen_at: T0.toISOString(),
      }),
    );
  const invalidRun = sync(
    registry,
    "x-one",
    new Date("2026-07-20T01:00:00.000Z"),
  );
  let calls = 0;
  await drain(
    store,
    provider({
      x: () => {
        calls += 1;
        return xEnvelope([]);
      },
    }),
    { now: new Date("2026-07-20T01:00:01.000Z") },
  );

  expect(calls).toBe(0);
  expect(registry.sourceCheckpoints("x-one")).toHaveLength(1);
  expect(
    store.db
      .query("SELECT state, terminal_outcome FROM runs WHERE id=?")
      .get(invalidRun),
  ).toEqual({ state: "failed", terminal_outcome: "failed" });
  expect(showSource(store.db, "x-one")).toMatchObject({
    paused: true,
    pause_reason: "auth_config",
    health: { state: "unhealthy" },
  });
  store.close();
});

test("rate limits retry the active Run while auth failures pause it without Checkpoint advancement", async () => {
  const rate = fixture();
  rate.registry.applySourceDefinitions([xSource()], { now: T0 });
  const rateRun = sync(rate.registry, "x-one");
  await drain(
    rate.store,
    provider({
      x: () => {
        throw new ScrapectlDiscoveryError(
          "provider rate limited",
          "item_transient",
          "rate_limit",
        );
      },
    }),
  );
  expect(
    rate.store.db
      .query("SELECT state, terminal_outcome, warnings FROM runs WHERE id=?")
      .get(rateRun),
  ).toMatchObject({ state: "active", terminal_outcome: null });
  expect(
    rate.store.db
      .query("SELECT state, failure_class FROM jobs WHERE kind='source_sync'")
      .get(),
  ).toEqual({ state: "retry_wait", failure_class: "item_transient" });
  expect(rate.registry.sourceCheckpoints("x-one")).toEqual([]);
  rate.store.close();

  const auth = fixture();
  auth.registry.applySourceDefinitions([xSource()], { now: T0 });
  const authRun = sync(auth.registry, "x-one");
  await drain(
    auth.store,
    provider({
      x: () => {
        throw new ScrapectlDiscoveryError(
          "authentication required",
          "auth_config",
          "auth_config",
        );
      },
    }),
  );
  expect(
    auth.store.db
      .query("SELECT state, terminal_outcome FROM runs WHERE id=?")
      .get(authRun),
  ).toEqual({ state: "failed", terminal_outcome: "failed" });
  expect(
    auth.store.db
      .query("SELECT state, failure_class FROM jobs WHERE kind='source_sync'")
      .get(),
  ).toEqual({ state: "blocked", failure_class: "auth_config" });
  expect(showSource(auth.store.db, "x-one")).toMatchObject({
    paused: true,
    pause_reason: "auth_config",
    health: { state: "unhealthy" },
  });
  expect(auth.registry.sourceCheckpoints("x-one")).toEqual([]);
  auth.store.close();
});

test("a crash before Checkpoint commit rolls back fanout and restart recovers without duplicates", async () => {
  const { store, registry } = fixture();
  registry.applySourceDefinitions([blog()], { now: T0 });
  const runId = sync(registry, "blog-one");
  const sourceUrl = "https://blog-one.example/feed.xml";
  const discovery = provider({
    feed: () =>
      feedEnvelope(sourceUrl, [
        feedItem("entry-1", "https://crash.example/one"),
      ]),
  });

  let crashes = 0;
  await drain(store, discovery, {
    beforeCheckpointCommit: () => {
      crashes += 1;
      throw new Error("simulated crash before checkpoint");
    },
  });
  expect(crashes).toBe(1);
  expect(registry.sourceCheckpoints("blog-one")).toEqual([]);
  expect(count(store, "source_observation_details")).toBe(0);
  expect(count(store, "jobs", "kind='url'")).toBe(0);
  expect(
    store.db.query("SELECT state FROM jobs WHERE kind='source_sync'").get(),
  ).toEqual({ state: "retry_wait" });
  expect(
    store.db
      .query("SELECT state, terminal_outcome FROM runs WHERE id=?")
      .get(runId),
  ).toEqual({ state: "active", terminal_outcome: null });

  await drain(store, discovery, { now: new Date(T0.getTime() + 10_000) });
  expect(registry.sourceCheckpoints("blog-one")).toHaveLength(1);
  expect(count(store, "source_observation_details")).toBe(1);
  expect(count(store, "jobs", "kind='url'")).toBe(1);
  expect(count(store, "resources", "key_type='url'")).toBe(1);
  expect(
    store.db
      .query("SELECT state, terminal_outcome FROM runs WHERE id=?")
      .get(runId),
  ).toEqual({ state: "completed", terminal_outcome: "success" });
  store.close();
});
