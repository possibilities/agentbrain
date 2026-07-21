import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../src/errors";
import {
  mergeSourceOverlay,
  SourceRegistry,
  showSource,
  sourceStatuses,
  validateSourceManifest,
} from "../src/sources";
import { ResearchStore } from "../src/store";
import type { SourceDefinition, SourceManifest } from "../src/types";

const roots: string[] = [];
const T0 = new Date("2026-07-20T00:00:00.000Z");

function tempDb(): string {
  const root = mkdtempSync(join(tmpdir(), "agentbrain-sources-"));
  roots.push(root);
  return join(root, "research.db");
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function blog(overrides: Partial<SourceDefinition> = {}): SourceDefinition {
  return {
    id: "blog-one",
    version: 1,
    kind: "blog_source",
    display_name: "Blog One",
    enabled: true,
    payload: { homepage_url: "https://blog.example/" },
    schedule: { cadence_seconds: 86_400 },
    limits: { max_items_per_run: 25, max_pages_per_run: 3 },
    collections: ["blogs"],
    sensitivity: "normal",
    credential_refs: [],
    ...overrides,
  };
}

function manifest(...sources: SourceDefinition[]): SourceManifest {
  return { schema_version: 1, sources };
}

test("source manifests validate versions, stable IDs, payloads, overlays, and credential references", () => {
  expect(() =>
    validateSourceManifest({ schema_version: 2, sources: [] }),
  ).toThrow("schema_version must be 1");
  expect(() => validateSourceManifest(manifest(blog(), blog()))).toThrow(
    "duplicate stable source id 'blog-one'",
  );
  expect(() =>
    validateSourceManifest(
      manifest(
        blog({
          payload: {
            homepage_url: "https://blog.example/?token=raw-secret",
          },
        }),
      ),
    ),
  ).toThrow("credential-shaped URL query");

  const merged = mergeSourceOverlay(manifest(blog()), {
    schema_version: 1,
    sources: [
      {
        id: "blog-one",
        version: 2,
        sensitivity: "private",
        credential_refs: ["keychain:agentbrain/blog-one"],
        limits: { max_items_per_run: 10 },
      },
    ],
  });
  expect(merged.sources[0]).toMatchObject({
    id: "blog-one",
    version: 2,
    kind: "blog_source",
    sensitivity: "private",
    credential_refs: ["keychain:agentbrain/blog-one"],
    limits: { max_items_per_run: 10, max_pages_per_run: 3 },
  });

  const future = validateSourceManifest(
    manifest(
      blog({
        id: "future-one",
        kind: "future_connector",
        payload: { locator: "opaque:item" },
      }),
    ),
  );
  expect(future.sources[0].kind).toBe("future_connector");
});

test("schedule evaluation admits one catch-up Run and never executes discovery inline", () => {
  const store = new ResearchStore(tempDb());
  const registry = new SourceRegistry(store);
  registry.applySourceManifest(manifest(blog()), { now: T0 });

  const dryRun = registry.syncDueSources({
    now: new Date("2026-07-22T12:00:00.000Z"),
    dryRun: true,
  });
  expect(dryRun).toEqual([
    {
      source_id: "blog-one",
      source_database_id: 1,
      status: "would_queue",
      run_id: null,
      job_id: null,
      scheduled_for: "2026-07-20T00:00:00.000Z",
      dry_run: true,
    },
  ]);
  expect(store.db.query("SELECT COUNT(*) AS count FROM runs").get()).toEqual({
    count: 0,
  });

  const admitted = registry.syncDueSources({
    now: new Date("2026-07-22T12:00:00.000Z"),
  });
  expect(admitted[0]).toMatchObject({
    status: "queued",
    run_id: 1,
    job_id: 1,
  });
  expect(
    registry.syncDueSources({ now: new Date("2026-07-22T12:00:01.000Z") }),
  ).toEqual([]);
  expect(
    store.db
      .query("SELECT next_due_at FROM sources WHERE identifier='blog-one'")
      .get(),
  ).toEqual({ next_due_at: "2026-07-23T12:00:00.000Z" });
  expect(store.db.query("SELECT COUNT(*) AS count FROM runs").get()).toEqual({
    count: 1,
  });
  expect(store.db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
    count: 1,
  });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM documents").get(),
  ).toEqual({ count: 0 });
  expect(
    store.db.query("SELECT kind, source_id, run_id, state FROM jobs").get(),
  ).toEqual({ kind: "source_sync", source_id: 1, run_id: 1, state: "queued" });
  store.close();
});

test("pause, config history, attempted cursors, and committed checkpoints remain distinct and durable", () => {
  const store = new ResearchStore(tempDb());
  const registry = new SourceRegistry(store);
  registry.applySourceDefinitions([blog()], { actor: "test", now: T0 });
  const admitted = registry.syncSource({
    sourceId: "blog-one",
    now: new Date("2026-07-20T00:01:00.000Z"),
  });
  const runId = admitted.run_id as number;

  registry.startSourceRun({
    runId,
    attemptedCursor: { page: "volatile-2" },
    now: new Date("2026-07-20T00:02:00.000Z"),
  });
  registry.recordSourceRunProgress({
    runId,
    attemptedCursor: { page: "volatile-3" },
    warnings: ["partial_window"],
    counts: { discovered: 2, admitted: 1, suppressed: 0 },
    now: new Date("2026-07-20T00:03:00.000Z"),
  });
  expect(() =>
    registry.finishSourceRun({
      runId,
      outcome: "partial",
      checkpoint: { entry_id: "unsafe" },
      now: new Date("2026-07-20T00:04:00.000Z"),
    }),
  ).toThrow("checkpoint requires a complete successful discovery window");
  registry.finishSourceRun({
    runId,
    outcome: "partial",
    now: new Date("2026-07-20T00:04:00.000Z"),
  });
  expect(registry.sourceCheckpoints("blog-one")).toEqual([]);
  expect(
    store.db
      .query(
        `SELECT attempted_cursor, committed_checkpoint, warnings,
                discovered_count, admitted_count, suppressed_count,
                terminal_outcome
         FROM runs WHERE id=?`,
      )
      .get(runId),
  ).toEqual({
    attempted_cursor: JSON.stringify({ page: "volatile-3" }),
    committed_checkpoint: null,
    warnings: JSON.stringify(["partial_window"]),
    discovered_count: 2,
    admitted_count: 1,
    suppressed_count: 0,
    terminal_outcome: "partial",
  });

  const second = registry.syncSource({
    sourceId: "blog-one",
    now: new Date("2026-07-20T01:00:00.000Z"),
  });
  expect(() =>
    registry.commitSourceCheckpoint({
      runId: second.run_id as number,
      checkpoint: { entry_id: "unsafe-fabricated-counts" },
      attemptedCursor: { page: "done" },
      counts: { discovered: 2, admitted: 1, suppressed: 1 },
      now: new Date("2026-07-20T01:04:00.000Z"),
    }),
  ).toThrow("checkpoint requires a complete successful discovery window");
  registry.commitSourceCheckpoint({
    runId: second.run_id as number,
    checkpoint: { entry_id: "stable-42" },
    attemptedCursor: { page: "done" },
    warnings: ["benign_item_warning"],
    counts: { discovered: 0, admitted: 0, suppressed: 0 },
    now: new Date("2026-07-20T01:05:00.000Z"),
  });
  expect(registry.sourceCheckpoints("blog-one")).toHaveLength(1);
  expect(
    store.db
      .query(
        `SELECT attempted_cursor, committed_checkpoint, terminal_outcome
         FROM runs WHERE id=?`,
      )
      .get(second.run_id),
  ).toEqual({
    attempted_cursor: JSON.stringify({ page: "done" }),
    committed_checkpoint: JSON.stringify({ entry_id: "stable-42" }),
    terminal_outcome: "success",
  });

  registry.pauseSource({
    sourceId: "blog-one",
    actor: "human",
    reason: "maintenance",
    now: new Date("2026-07-20T02:00:00.000Z"),
  });
  expect(
    registry.syncSource({
      sourceId: "blog-one",
      now: new Date("2026-07-21T02:00:00.000Z"),
    }).status,
  ).toBe("paused");
  registry.resumeSource({
    sourceId: "blog-one",
    actor: "human",
    now: new Date("2026-07-20T03:00:00.000Z"),
  });
  registry.applySourceDefinitions(
    [blog({ version: 2, display_name: "Renamed Blog" })],
    { actor: "test", now: new Date("2026-07-20T04:00:00.000Z") },
  );

  expect(
    registry.sourceAuditEvents("blog-one").map((event) => event.action),
  ).toEqual(["config_applied", "paused", "resumed", "config_applied"]);
  expect(registry.sourceCheckpoints("blog-one")).toHaveLength(1);
  expect(store.db.query("SELECT COUNT(*) AS count FROM runs").get()).toEqual({
    count: 2,
  });
  expect(
    store.db
      .query("SELECT COUNT(*) AS count FROM source_definition_versions")
      .get(),
  ).toEqual({ count: 2 });
  const shown = showSource(store.db, "blog-one");
  expect(shown).toMatchObject({
    version: 2,
    display_name: "Renamed Blog",
    paused: false,
    checkpoint: { present: true, run_id: second.run_id },
    health: { state: "warning", detail: "benign_item_warning" },
  });
  store.close();
});

test("disabled and unknown source kinds remain inspectable but cannot admit work", () => {
  const store = new ResearchStore(tempDb());
  const registry = new SourceRegistry(store);
  registry.applySourceDefinitions(
    [
      blog({ id: "disabled-blog", enabled: false }),
      blog({
        id: "future-one",
        kind: "future_connector",
        payload: { locator: "opaque:item" },
      }),
    ],
    { now: T0 },
  );

  expect(
    registry.syncSource({ sourceId: "disabled-blog", now: T0 }).status,
  ).toBe("disabled");
  expect(registry.syncSource({ sourceId: "future-one", now: T0 }).status).toBe(
    "unsupported",
  );
  expect(showSource(store.db, "future-one")).toMatchObject({
    id: "future-one",
    kind: "future_connector",
    executable: false,
    payload: { locator: "opaque:item" },
  });
  expect(sourceStatuses(store.db, { now: T0 })).toHaveLength(2);
  expect(store.db.query("SELECT COUNT(*) AS count FROM runs").get()).toEqual({
    count: 0,
  });
  expect(store.db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
    count: 0,
  });
  expect(() =>
    registry.applySourceDefinitions([
      blog({
        id: "disabled-blog",
        version: 1,
        display_name: "Changed",
        enabled: false,
      }),
    ]),
  ).toThrow(CliError);
  store.close();
});
