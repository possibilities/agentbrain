import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SOURCE_MANIFEST_PATH,
  isExecutableSourceKind,
  readSourceManifest,
  SourceRegistry,
} from "../src/sources";
import { ResearchStore } from "../src/store";
import type { SourceDefinition } from "../src/types";

const REPO = join(import.meta.dir, "..");
const roots: string[] = [];

function tempDb(): string {
  const root = mkdtempSync(join(tmpdir(), "agentbrain-source-config-"));
  roots.push(root);
  return join(root, "research.db");
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function loadManifest() {
  return readSourceManifest(DEFAULT_SOURCE_MANIFEST_PATH);
}

test("bundled config/sources.json exemplifies every supported kind, disabled", () => {
  const manifest = loadManifest();
  expect(manifest.schema_version).toBe(1);

  const byKind = new Map<string, SourceDefinition[]>();
  for (const source of manifest.sources) {
    const bucket = byKind.get(source.kind) ?? [];
    bucket.push(source);
    byKind.set(source.kind, bucket);
  }
  // One example per kind: the manifest is documentation of the shape, not a
  // reading list. Anything larger belongs in an operator's own manifest.
  expect([...byKind.keys()].sort()).toEqual([
    "blog_source",
    "x_account",
    "x_account_candidate",
  ]);

  const ids = manifest.sources.map((source) => source.id);
  expect(new Set(ids).size).toBe(ids.length);

  // Every definition lands disabled. Installing the manifest must never start
  // fetching anything; activation is a separate, explicit operator act.
  for (const source of manifest.sources) {
    expect(source.enabled).toBe(false);
  }

  // Confirmed kinds are executable; the candidate kind is deliberately not.
  expect(isExecutableSourceKind("blog_source")).toBe(true);
  expect(isExecutableSourceKind("x_account")).toBe(true);
  expect(isExecutableSourceKind("x_account_candidate")).toBe(false);
});

test("confirmed sources carry locked default cadences and bounded first-activation caps", () => {
  const manifest = loadManifest();
  for (const source of manifest.sources) {
    if (source.kind === "blog_source") {
      expect(source.schedule.cadence_seconds).toBe(24 * 60 * 60);
      expect(source.limits.max_items_per_run).toBeGreaterThan(0);
      expect(source.limits.max_pages_per_run).toBeGreaterThan(0);
      expect(source.limits.max_pages_per_run).toBeLessThanOrEqual(2);
    } else {
      expect(source.schedule.cadence_seconds).toBe(60 * 60);
      // A single page per run forbids deep pagination; forward-only X
      // polling never claims resumable historical backfill (ADR 0009).
      expect(source.limits.max_pages_per_run).toBe(1);
      expect(source.limits.max_items_per_run).toBeGreaterThan(0);
      expect(source.limits.max_items_per_run).toBeLessThanOrEqual(100);
    }
  }
});

test("no duplicate blog homepage URLs or X handles across confirmed and candidate rows", () => {
  const manifest = loadManifest();
  const homepages = manifest.sources
    .filter((source) => source.kind === "blog_source")
    .map((source) =>
      String((source.payload as { homepage_url?: string }).homepage_url),
    );
  expect(new Set(homepages).size).toBe(homepages.length);

  const handles = manifest.sources
    .filter(
      (source) =>
        source.kind === "x_account" || source.kind === "x_account_candidate",
    )
    .map((source) =>
      String((source.payload as { handle?: string }).handle).toLowerCase(),
    );
  expect(new Set(handles).size).toBe(handles.length);
});

test("applying the bundled manifest is a safe, idempotent install and a version-gated update", () => {
  const store = new ResearchStore(tempDb());
  try {
    const registry = new SourceRegistry(store);
    const manifest = loadManifest();

    const installed = registry.applySourceManifest(manifest, {
      actor: "test-install",
      now: new Date("2026-07-21T00:00:00.000Z"),
    });
    expect(installed).toHaveLength(manifest.sources.length);
    for (const result of installed) {
      expect(result.created).toBe(true);
      expect(result.changed).toBe(true);
    }
    expect(
      store.db.query("SELECT COUNT(*) AS count FROM sources").get(),
    ).toEqual({ count: manifest.sources.length });

    // Re-applying identical content changes nothing.
    const reapplied = registry.applySourceManifest(manifest, {
      actor: "test-reinstall",
      now: new Date("2026-07-21T01:00:00.000Z"),
    });
    for (const result of reapplied) {
      expect(result.created).toBe(false);
      expect(result.changed).toBe(false);
    }

    const target = manifest.sources.find(
      (source) => source.id === "blog.example",
    );
    if (target === undefined) throw new Error("fixture source missing");

    // Raising the version alongside a content change is an accepted update.
    const updated = registry.applySourceManifest(
      {
        schema_version: 1,
        sources: [
          {
            ...target,
            version: target.version + 1,
            limits: { ...target.limits, max_items_per_run: 5 },
          },
        ],
      },
      { actor: "test-update", now: new Date("2026-07-21T02:00:00.000Z") },
    );
    expect(updated[0]).toMatchObject({ created: false, changed: true });

    // Changing content without raising the version is refused.
    expect(() =>
      registry.applySourceManifest(
        {
          schema_version: 1,
          sources: [
            {
              ...target,
              version: target.version + 1,
              limits: { ...target.limits, max_items_per_run: 9 },
            },
          ],
        },
        { actor: "test-conflict", now: new Date("2026-07-21T03:00:00.000Z") },
      ),
    ).toThrow("changed without a higher definition version");
  } finally {
    store.close();
  }
});

test("a disabled candidate X account cannot schedule a Run even if force-enabled", () => {
  const store = new ResearchStore(tempDb());
  try {
    const registry = new SourceRegistry(store);
    const manifest = loadManifest();
    registry.applySourceManifest(manifest, {
      now: new Date("2026-07-21T00:00:00.000Z"),
    });

    const candidate = manifest.sources.find(
      (source) => source.kind === "x_account_candidate",
    );
    if (candidate === undefined) throw new Error("fixture candidate missing");

    // Simulate an operator mistake: force-enable a candidate row. It must
    // still refuse to schedule because its kind is not executable.
    registry.applySourceManifest(
      {
        schema_version: 1,
        sources: [
          { ...candidate, version: candidate.version + 1, enabled: true },
        ],
      },
      { now: new Date("2026-07-21T00:00:01.000Z") },
    );

    const admission = registry.syncSource({
      sourceId: candidate.id,
      now: new Date("2026-07-21T01:00:00.000Z"),
    });
    expect(admission).toMatchObject({
      status: "unsupported",
      run_id: null,
      job_id: null,
    });
    expect(store.db.query("SELECT COUNT(*) AS count FROM runs").get()).toEqual({
      count: 0,
    });
  } finally {
    store.close();
  }
});

test("worker due evaluation admits durable source-run jobs for confirmed sources without inline discovery", () => {
  const store = new ResearchStore(tempDb());
  try {
    const registry = new SourceRegistry(store);
    const manifest = loadManifest();
    registry.applySourceManifest(manifest, {
      now: new Date("2026-07-21T00:00:00.000Z"),
    });

    const blog = manifest.sources.find(
      (source) => source.id === "blog.example",
    );
    const account = manifest.sources.find(
      (source) => source.id === "x.example",
    );
    if (blog === undefined || account === undefined) {
      throw new Error("fixture confirmed sources missing");
    }

    registry.applySourceManifest(
      {
        schema_version: 1,
        sources: [
          { ...blog, version: blog.version + 1, enabled: true },
          { ...account, version: account.version + 1, enabled: true },
        ],
      },
      { now: new Date("2026-07-21T00:00:01.000Z") },
    );

    const due = registry.syncDueSources({
      now: new Date("2026-07-21T00:05:00.000Z"),
    });
    const queued = due.filter((admission) => admission.status === "queued");
    expect(queued.map((admission) => admission.source_id).sort()).toEqual([
      "blog.example",
      "x.example",
    ]);

    expect(
      store.db.query("SELECT run_type FROM runs ORDER BY id").all(),
    ).toEqual([{ run_type: "source_sync" }, { run_type: "source_sync" }]);
    // Schedule admission durably creates source_sync jobs only; it never
    // performs discovery or fans out a url/extraction job inline.
    expect(store.db.query("SELECT kind FROM jobs ORDER BY id").all()).toEqual([
      { kind: "source_sync" },
      { kind: "source_sync" },
    ]);
    expect(
      store.db.query("SELECT COUNT(*) AS count FROM documents").get(),
    ).toEqual({ count: 0 });
  } finally {
    store.close();
  }
});

function decode(value: Uint8Array | string): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function runCli(dbPath: string, args: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", "src/cli.ts", ...args, "--db", dbPath],
    cwd: REPO,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
  };
}

test("agentbrain sources apply installs the bundled manifest and is idempotent on replay", () => {
  const bundled = loadManifest().sources.length;
  const dbPath = tempDb();
  const first = runCli(dbPath, ["sources", "apply", "--json"]);
  expect(first.exitCode).toBe(0);
  const firstBody = JSON.parse(first.stdout) as {
    command: string;
    meta: { read_only: boolean };
    data: Array<{ created: boolean; changed: boolean }>;
  };
  expect(firstBody.command).toBe("sources apply");
  expect(firstBody.meta.read_only).toBe(false);
  expect(firstBody.data).toHaveLength(bundled);
  expect(
    firstBody.data.every((result) => result.created && result.changed),
  ).toBe(true);

  const second = runCli(dbPath, ["sources", "apply", "--json"]);
  expect(second.exitCode).toBe(0);
  const secondBody = JSON.parse(second.stdout) as {
    data: Array<{ created: boolean; changed: boolean }>;
  };
  expect(
    secondBody.data.every((result) => !result.created && !result.changed),
  ).toBe(true);

  const listed = runCli(dbPath, ["sources", "list", "--json"]);
  expect(listed.exitCode).toBe(0);
  const listedBody = JSON.parse(listed.stdout) as { data: unknown[] };
  expect(listedBody.data).toHaveLength(bundled);
});
