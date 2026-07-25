import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceDiscoveryProvider } from "../src/agentscrape";
import { SourceRegistry } from "../src/sources";
import { ResearchStore } from "../src/store";
import type { SourceDefinition } from "../src/types";
import { runWorker } from "../src/worker";

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

test("per-source due sync is an idempotent scheduler trigger", () => {
  const value = fixture();
  let store = new ResearchStore(value.dbPath);
  store.db
    .query("UPDATE sources SET next_due_at='2100-01-01T00:00:00.000Z'")
    .run();
  store.close();

  const notDue = run(value, [
    "sources",
    "sync",
    "blog-one",
    "--due",
    "--wait",
    "--wait-timeout-seconds",
    "0.1",
    "--json",
  ]);
  expect(notDue.exitCode).toBe(0);
  expect(json(notDue)).toMatchObject({
    data: [
      {
        admission: { source_id: "blog-one", status: "not_due", run_id: null },
        execution: null,
        timed_out: false,
      },
    ],
  });

  store = new ResearchStore(value.dbPath);
  store.db
    .query("UPDATE sources SET next_due_at='2000-01-01T00:00:00.000Z'")
    .run();
  store.close();
  const admitted = run(value, [
    "sources",
    "sync",
    "blog-one",
    "--due",
    "--json",
  ]);
  expect(admitted.exitCode).toBe(0);
  expect(json(admitted)).toMatchObject({
    data: [{ source_id: "blog-one", status: "queued", run_id: 1, job_id: 1 }],
  });
  const duplicate = run(value, [
    "sources",
    "sync",
    "blog-one",
    "--due",
    "--json",
  ]);
  expect(duplicate.exitCode).toBe(0);
  expect(json(duplicate)).toMatchObject({
    data: [
      { source_id: "blog-one", status: "duplicate", run_id: 1, job_id: 1 },
    ],
  });

  store = new ResearchStore(value.dbPath);
  store.db
    .query(
      "UPDATE runs SET state='failed', terminal_outcome='failed', finished_at='2026-07-25T00:00:00.000Z' WHERE id=1",
    )
    .run();
  store.db
    .query(
      "UPDATE jobs SET state='failed', failure_class='permanent', failure_summary='terminal source failure' WHERE id=1",
    )
    .run();
  store.close();
  const observedFailure = run(value, [
    "sources",
    "sync",
    "blog-one",
    "--due",
    "--wait",
    "--wait-timeout-ok",
    "--json",
  ]);
  expect(observedFailure.exitCode).toBe(1);
  expect(json(observedFailure)).toMatchObject({
    data: [
      {
        admission: { source_id: "blog-one", status: "not_due", run_id: null },
        execution: {
          run_id: 1,
          run_state: "failed",
          outcome: "failed",
          job: { id: 1, state: "failed" },
        },
        timed_out: false,
      },
    ],
  });
});

test("source sync --wait returns a terminal scheduler receipt", async () => {
  const value = fixture();
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "run",
      "src/cli.ts",
      "sources",
      "sync",
      "blog-one",
      "--wait",
      "--wait-timeout-seconds",
      "5",
      "--wait-poll-ms",
      "25",
      "--json",
      "--db",
      value.dbPath,
    ],
    cwd: REPO,
    env: { ...process.env, XDG_DATA_HOME: join(value.root, "data") },
    stdout: "pipe",
    stderr: "pipe",
  });

  let store: ResearchStore | null = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = new ResearchStore(value.dbPath);
    const count = candidate.db
      .query("SELECT COUNT(*) AS count FROM jobs WHERE kind='source_sync'")
      .get() as { count: number };
    if (count.count > 0) {
      store = candidate;
      break;
    }
    candidate.close();
    await Bun.sleep(10);
  }
  if (store === null) throw new Error("source sync job was not admitted");
  const discovery: SourceDiscoveryProvider = {
    async discoverFeed(request) {
      return {
        schema_version: "1",
        status: "success",
        source_url: request.sourceUrl,
        source_format: "rss",
        validators: { etag: '"v1"', last_modified: null },
        cursor: {
          validators: { etag: '"v1"', last_modified: null },
          newest_seen_at: null,
          next_url: null,
        },
        items: [],
        pagination: {
          pages: [],
          complete: true,
          stop_reason: "exhausted",
          next_url: null,
        },
        warnings: [],
        absence_implies_deletion: false,
        failure: null,
      };
    },
    async discoverXTimeline() {
      throw new Error("unexpected X discovery");
    },
  };
  await runWorker(store, {
    once: true,
    workerId: "sources-cli-wait-test",
    sourceDiscovery: discovery,
  });
  store.close();

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toMatchObject({
    command: "sources sync",
    meta: { read_only: false },
    data: [
      {
        admission: {
          source_id: "blog-one",
          status: "queued",
          run_id: 1,
          job_id: 1,
        },
        execution: {
          source_id: "blog-one",
          run_id: 1,
          run_state: "completed",
          outcome: "success",
          terminal: true,
          checkpoint_committed: true,
          job: { id: 1, state: "completed" },
        },
        timed_out: false,
      },
    ],
  });
});

test("source sync --wait exposes timeout and invalid option semantics", () => {
  const value = fixture();
  const timedOut = run(value, [
    "sources",
    "sync",
    "blog-one",
    "--wait",
    "--wait-timeout-seconds",
    "0.03",
    "--wait-poll-ms",
    "25",
    "--json",
  ]);
  expect(timedOut.exitCode).toBe(124);
  expect(json(timedOut)).toMatchObject({
    data: [
      {
        admission: { source_id: "blog-one", status: "queued" },
        execution: { terminal: false, run_state: "pending" },
        timed_out: true,
      },
    ],
  });

  const supervisorTimeout = run(value, [
    "sources",
    "sync",
    "blog-one",
    "--due",
    "--wait",
    "--wait-timeout-seconds",
    "0.03",
    "--wait-timeout-ok",
    "--json",
  ]);
  expect(supervisorTimeout.exitCode).toBe(0);
  expect(json(supervisorTimeout)).toMatchObject({
    data: [
      {
        admission: { source_id: "blog-one", status: "duplicate" },
        execution: { terminal: false },
        timed_out: true,
      },
    ],
  });

  const store = new ResearchStore(value.dbPath);
  store.db
    .query(
      "UPDATE jobs SET state='blocked', block_reason='item_retry_exhausted' WHERE kind='source_sync'",
    )
    .run();
  store.close();
  const blocked = run(value, [
    "sources",
    "sync",
    "blog-one",
    "--due",
    "--wait",
    "--wait-timeout-seconds",
    "0.1",
    "--wait-timeout-ok",
    "--json",
  ]);
  expect(blocked.exitCode).toBe(1);
  expect(json(blocked)).toMatchObject({
    data: [
      {
        admission: { source_id: "blog-one", status: "duplicate" },
        execution: {
          terminal: false,
          outcome: null,
          job: { state: "blocked" },
        },
        timed_out: false,
      },
    ],
  });

  const invalid = run(value, [
    "sources",
    "sync",
    "blog-one",
    "--wait",
    "--dry-run",
    "--json",
  ]);
  expect(invalid.exitCode).toBe(2);
  expect(invalid.stderr).toBe("");
  expect(JSON.parse(invalid.stdout)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("cannot be combined") },
  });

  const timeoutOkWithoutWait = run(value, [
    "sources",
    "sync",
    "blog-one",
    "--wait-timeout-ok",
    "--json",
  ]);
  expect(timeoutOkWithoutWait.exitCode).toBe(2);
  expect(JSON.parse(timeoutOkWithoutWait.stdout)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("requires --wait") },
  });
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
