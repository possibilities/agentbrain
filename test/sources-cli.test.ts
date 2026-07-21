import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceRegistry } from "../src/sources";
import { ResearchStore } from "../src/store";
import type { SourceDefinition } from "../src/types";

const REPO = join(import.meta.dir, "..");
const roots: string[] = [];

interface Fixture {
  root: string;
  dbPath: string;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "agentbrain-sources-cli-"));
  roots.push(root);
  const dbPath = join(root, "research.db");
  const definitions: SourceDefinition[] = [
    {
      id: "blog-one",
      version: 1,
      kind: "blog_source",
      display_name: "Blog One",
      enabled: true,
      payload: { homepage_url: "https://blog.example/" },
      schedule: { cadence_seconds: 86_400 },
      limits: { max_items_per_run: 20, max_pages_per_run: 2 },
      collections: ["blogs"],
      sensitivity: "normal",
      credential_refs: ["keychain:agentbrain/blog-one"],
    },
    {
      id: "future-one",
      version: 1,
      kind: "future_connector",
      display_name: "Future One",
      enabled: true,
      payload: { locator: "opaque:item" },
      schedule: { cadence_seconds: 3_600 },
      limits: { max_items_per_run: 5, max_pages_per_run: 1 },
      collections: [],
      sensitivity: "normal",
      credential_refs: [],
    },
  ];
  const store = new ResearchStore(dbPath);
  new SourceRegistry(store).applySourceDefinitions(definitions, {
    now: new Date("2026-07-20T00:00:00.000Z"),
  });
  store.close();
  return { root, dbPath };
}

function decode(value: Uint8Array | string): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function run(value: Fixture, args: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", "src/cli.ts", ...args, "--db", value.dbPath],
    cwd: REPO,
    env: { ...process.env, XDG_DATA_HOME: join(value.root, "data") },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
  };
}

function json(result: ReturnType<typeof run>): unknown {
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as unknown;
}

test("source list, show, and status are read-only safe envelopes", () => {
  const value = fixture();
  const listed = run(value, ["sources", "list", "--json"]);
  expect(listed.exitCode).toBe(0);
  expect(listed.stdout).not.toContain("keychain:agentbrain/blog-one");
  expect(json(listed)).toMatchObject({
    command: "sources list",
    meta: { read_only: true },
    data: [
      { id: "blog-one", executable: true, credential_reference_count: 1 },
      { id: "future-one", executable: false },
    ],
  });

  const shown = run(value, ["sources", "show", "future-one", "--json"]);
  expect(shown.exitCode).toBe(0);
  expect(json(shown)).toMatchObject({
    command: "sources show",
    meta: { read_only: true },
    data: {
      id: "future-one",
      kind: "future_connector",
      executable: false,
      payload: { locator: "opaque:item" },
    },
  });

  const status = run(value, ["sources", "status", "blog-one", "--json"]);
  expect(status.exitCode).toBe(0);
  expect(json(status)).toMatchObject({
    command: "sources status",
    meta: { read_only: true },
    data: [{ id: "blog-one", due: true, latest_run: null }],
  });
});

test("source sync dry-run writes nothing and admission only creates a durable Run and job", () => {
  const value = fixture();
  const dryRun = run(value, [
    "sources",
    "sync",
    "--due",
    "--dry-run",
    "--json",
  ]);
  expect(dryRun.exitCode).toBe(0);
  expect(json(dryRun)).toMatchObject({
    command: "sources sync",
    meta: { read_only: true },
    data: [
      { source_id: "blog-one", status: "would_queue", dry_run: true },
      { source_id: "future-one", status: "unsupported", dry_run: true },
    ],
  });
  let store = new ResearchStore(value.dbPath);
  expect(store.db.query("SELECT COUNT(*) AS count FROM runs").get()).toEqual({
    count: 0,
  });
  expect(store.db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
    count: 0,
  });
  store.close();

  const synced = run(value, ["sources", "sync", "--due", "--json"]);
  expect(synced.exitCode).toBe(0);
  expect(json(synced)).toMatchObject({
    command: "sources sync",
    meta: { read_only: false },
    data: [
      { source_id: "blog-one", status: "queued", run_id: 1, job_id: 1 },
      { source_id: "future-one", status: "unsupported" },
    ],
  });
  store = new ResearchStore(value.dbPath);
  expect(
    store.db.query("SELECT run_type, state FROM runs ORDER BY id").all(),
  ).toEqual([{ run_type: "source_sync", state: "pending" }]);
  expect(
    store.db.query("SELECT kind, state FROM jobs ORDER BY id").all(),
  ).toEqual([{ kind: "source_sync", state: "queued" }]);
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM documents").get(),
  ).toEqual({ count: 0 });
  store.close();
});

test("pause and resume append mutation envelopes and prevent admission", () => {
  const value = fixture();
  const paused = run(value, [
    "sources",
    "pause",
    "blog-one",
    "--reason",
    "maintenance",
    "--actor",
    "cli-test",
    "--json",
  ]);
  expect(paused.exitCode).toBe(0);
  expect(json(paused)).toMatchObject({
    command: "sources pause",
    meta: { read_only: false },
    data: { id: "blog-one", paused: true, audit_action: "paused" },
  });

  const refused = run(value, ["sources", "sync", "blog-one", "--json"]);
  expect(refused.exitCode).toBe(0);
  expect(json(refused)).toMatchObject({
    data: [{ source_id: "blog-one", status: "paused", run_id: null }],
  });

  const resumed = run(value, ["sources", "resume", "blog-one", "--json"]);
  expect(resumed.exitCode).toBe(0);
  expect(json(resumed)).toMatchObject({
    command: "sources resume",
    data: { id: "blog-one", paused: false, audit_action: "resumed" },
  });

  const future = run(value, ["sources", "sync", "future-one", "--json"]);
  expect(future.exitCode).toBe(0);
  expect(json(future)).toMatchObject({
    data: [{ source_id: "future-one", status: "unsupported", run_id: null }],
  });

  const store = new ResearchStore(value.dbPath);
  expect(
    new SourceRegistry(store)
      .sourceAuditEvents("blog-one")
      .map((event) => event.action),
  ).toEqual(["config_applied", "paused", "resumed"]);
  expect(store.db.query("SELECT COUNT(*) AS count FROM runs").get()).toEqual({
    count: 0,
  });
  store.close();
});
