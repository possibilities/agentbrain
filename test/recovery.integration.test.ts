import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUP_DATABASE_FILE } from "../src/backup";

const REPO = join(import.meta.dir, "..");
const roots: string[] = [];
const originalPath = process.env.PATH;

const DISPOSITIONS = [
  ["import_offline", 581],
  ["exclude_infrastructure", 25],
  ["exclude_probable_test", 12],
  ["review", 98],
  ["review_discord", 356],
  ["review_fetch", 4],
  ["review_retry", 5],
  ["approved_online_backfill_telegram_human", 2],
  ["review_telegram_bot_generated", 5],
] as const;

interface Fixture {
  root: string;
  artifactRoot: string;
  manifestsRoot: string;
  generationRoot: string;
  descriptor: string;
}

interface FixtureOptions {
  malformedArtifact?: boolean;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

function canonical(value: unknown): string {
  return `${JSON.stringify(stable(value))}\n`;
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function dispositionFor(index: number): string {
  let offset = 0;
  for (const [name, count] of DISPOSITIONS) {
    if (index < offset + count) return name;
    offset += count;
  }
  throw new Error("fixture disposition overflow");
}

// Builds one hash-bound synthetic frozen generation matching the locked
// 1,088-row contract, on disk, exactly as the real generation is shaped, so the
// installed CLI verifies and admits it without any special-casing.
function makeFixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "agentbrain-recovery-int-"));
  roots.push(root);
  const artifactRoot = join(root, "legacy-artifacts");
  const manifestsRoot = join(root, "manifests");
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  mkdirSync(manifestsRoot, { recursive: true, mode: 0o700 });

  const rows: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 1088; index += 1) {
    const sourceUri = `https://candidate.test/item/${index + 1}?v=${index + 1}`;
    const candidateId = digest(sourceUri).slice(0, 16);
    const disposition = dispositionFor(index);
    const catalogPosition = index < 584 ? index + 1 : null;
    const provenance: Record<string, unknown> = {
      botctl_messages: [],
      catalog_positions: catalogPosition === null ? [] : [catalogPosition],
      discord_cache_messages: [],
      historical_document_ids: [],
      save_link_pipelines: [],
    };
    const reconciliation: Record<string, unknown> = {
      in_catalog: catalogPosition !== null,
    };
    if (disposition === "import_offline") {
      const path = join(
        artifactRoot,
        `link-${String(index + 1).padStart(5, "0")}.md`,
      );
      const markdown =
        options.malformedArtifact && index === 0
          ? `url: ${JSON.stringify(sourceUri)}\nsummary: broken\nbody\n`
          : [
              "---",
              `url: ${JSON.stringify(sourceUri)}`,
              `summary: ${JSON.stringify(`Independent summary ${index + 1}`)}`,
              "---",
              `Searchable legacy body ${index + 1}`,
              "",
            ].join("\n");
      writeFileSync(path, markdown, { mode: 0o600 });
      reconciliation.artifact = {
        path,
        sha256: digest(markdown),
        size_bytes: Buffer.byteLength(markdown),
        status: "present",
      };
    }
    rows.push({
      candidate_id: candidateId,
      normalized_uri: index < 2 ? "https://comparison.test/shared" : sourceUri,
      provenance,
      reconciliation,
      recovery: {
        confidence: "synthetic_fixture",
        disposition,
        reasons: [`fixture_${disposition}`],
      },
      schema_version: 1,
      source_type: "url",
      source_uri: sourceUri,
    });
  }

  const secretaryIndexes = [
    ...Array.from({ length: 118 }, (_, index) => index),
    ...Array.from({ length: 6 }, (_, index) => 606 + index),
    1081,
    1082,
    1083,
    1084,
    1085,
    1086,
    1087,
  ];
  const privateRows: Array<Record<string, unknown>> = [];
  let observationSequence = 0;
  for (const [secretaryIndex, candidateIndex] of secretaryIndexes.entries()) {
    const row = rows[candidateIndex];
    const count = secretaryIndex < 32 ? 3 : 2;
    const observations = Array.from({ length: count }, () => {
      observationSequence += 1;
      return {
        fields: ["entity_url"],
        observation_id: digest(`observation:${observationSequence}`).slice(
          0,
          24,
        ),
        observed_in: ["agentbot_db"],
        sender_kind: candidateIndex >= 1081 ? "human" : "unknown",
        soft_deleted_provenance: false,
      };
    });
    (row.provenance as Record<string, unknown>).agentbot_secretary = {
      observation_count: observations.length,
      observation_ids: observations.map((item) => item.observation_id),
      private_reconciliation: "private-reconciliation.jsonl",
    };
    privateRows.push({
      candidate_disposition: (row.recovery as Record<string, unknown>)
        .disposition,
      candidate_evidence_row_id: row.candidate_id,
      comparison_candidate_evidence_row_ids: [],
      comparison_uri: row.normalized_uri,
      exact_uri: row.source_uri,
      observations,
      reconciliation_action:
        secretaryIndex < 118
          ? "merge_existing_provenance"
          : "append_exact_candidate",
      resource_sensitivity: "normal",
      schema_version: 1,
    });
  }
  expect(observationSequence).toBe(294);

  const manifest = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const privateReconciliation = `${privateRows
    .map((row) => JSON.stringify(row))
    .join("\n")}\n`;
  const summary = pretty({
    candidate_outcomes: {
      appended_exact_candidates: 13,
      baseline_candidate_ids_preserved: 1075,
      comparison_new_urls: 8,
      final_candidates: 1088,
    },
    controlled_online_backfill: {
      approved_human_candidate_evidence_rows: 2,
      network_fetches_performed: 0,
    },
    live_capture: {
      credential_session_copies_retained: 0,
      fixed_upper_cutoff: true,
      hard_cap_duration_ms: 600000,
      hard_cap_messages: 20000,
      history_exhausted: true,
      visible_messages: 119,
    },
    privacy: {
      exact_urls_in_summary: 0,
      private_locators_in_summary: 0,
      transport_privacy_alone_marks_resource_sensitive: false,
    },
    reconciliation: {
      exact_urls: 131,
      live_only_urls: 1,
      message_level_url_observations: 294,
      provenance_merges: 118,
    },
    schema_version: 1,
    secretary_additions: {
      approved_controlled_online_human_submissions: 2,
      bot_output_review_candidates: 5,
      probable_test_exclusions: 6,
    },
  });
  const onlineIds = rows
    .filter(
      (row) =>
        (row.recovery as Record<string, unknown>).disposition ===
        "approved_online_backfill_telegram_human",
    )
    .map((row) => row.candidate_id as string)
    .sort();
  const binding = {
    bound_checksum_inventory: {
      "candidate-manifest.jsonl": digest(manifest),
      "private-reconciliation.jsonl": digest(privateReconciliation),
      "public-summary.json": digest(summary),
    },
    candidate_counts: { baseline: 1075, final: 1088 },
    controlled_online_backfill_candidate_evidence_row_ids: onlineIds,
    cutoff_metadata: {
      completed_at: "2026-07-18T00:00:01.000Z",
      hard_caps: { duration_ms: 600000, messages: 20000 },
      message_count: 119,
      started_at: "2026-07-18T00:00:00.000Z",
      termination: "history_exhausted",
      upper_cutoff_message_id: "7215",
    },
    schema_versions: {
      candidate_manifest: 1,
      frozen_recovery_generation: 1,
      public_summary: 1,
    },
    tool_version: "synthetic-integration-1",
  };
  const generationId = `sha256-${digest(canonical(binding))}`;
  const generation = pretty({
    binding,
    generation_id: generationId,
    schema_version: 1,
  });
  const allowlist = pretty({
    candidate_evidence_row_ids: onlineIds,
    entry_count: 2,
    generation_digest: generationId.slice(7),
    generation_id: generationId,
    schema_version: 1,
  });
  const files: Record<string, string> = {
    "candidate-manifest.jsonl": manifest,
    "generation.json": generation,
    "online-allowlist.json": allowlist,
    "private-reconciliation.jsonl": privateReconciliation,
    "public-summary.json": summary,
  };
  const checksums = `${Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, content]) => `${digest(content)}  ${name}`)
    .join("\n")}\n`;
  const generationRoot = join(manifestsRoot, generationId);
  mkdirSync(generationRoot, { mode: 0o700 });
  for (const [name, content] of Object.entries({
    ...files,
    SHA256SUMS: checksums,
  })) {
    writeFileSync(join(generationRoot, name), content, { mode: 0o600 });
  }
  const descriptor = join(manifestsRoot, "current.json");
  writeFileSync(
    descriptor,
    pretty({ generation_id: generationId, schema_version: 1 }),
    { mode: 0o600 },
  );
  return { root, artifactRoot, manifestsRoot, generationRoot, descriptor };
}

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// A forbidden `scrapectl` shim: any invocation records a sentinel and exits
// non-zero, so a rehearsal that touched the network fails loudly.
function forbiddenScrapectl(root: string): {
  binDir: string;
  sentinel: string;
} {
  const binDir = join(root, "bin");
  const sentinel = join(root, "scrapectl-invoked");
  mkdirSync(binDir, { recursive: true });
  const shim = join(binDir, "scrapectl");
  writeFileSync(
    shim,
    `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\nexit 97\n`,
  );
  chmodSync(shim, 0o755);
  return { binDir, sentinel };
}

function runCli(args: string[], env: Record<string, string>): CliResult {
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", "src/cli.ts", ...args],
    cwd: REPO,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

function jsonData(result: CliResult): Record<string, unknown> {
  const parsed = JSON.parse(result.stdout) as { data: Record<string, unknown> };
  return parsed.data;
}

function count(db: Database, sql: string): number {
  return (db.query(sql).get() as { count: number }).count;
}

// The rehearsal must never leak exact candidate URLs, comparison locators,
// private bodies, or artifact filesystem paths through any CLI surface.
function assertSanitized(result: CliResult): void {
  const text = result.stdout + result.stderr;
  expect(text).not.toContain("https://candidate.test");
  expect(text).not.toContain("https://comparison.test");
  expect(text).not.toContain("Searchable legacy body");
  expect(text).not.toContain("legacy-artifacts");
}

afterEach(() => {
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("disposable rehearsal drives the frozen generation through the installed CLI", async () => {
  const fixture = makeFixture();
  const { binDir, sentinel } = forbiddenScrapectl(fixture.root);
  const dataHome = join(fixture.root, "data");
  const dbPath = join(fixture.root, "rehearsal.db");
  const env = {
    XDG_DATA_HOME: dataHome,
    PATH: `${binDir}:${originalPath}`,
  };
  const importArgs = [
    "recovery",
    "import",
    "--manifest-generation",
    fixture.descriptor,
    "--artifact-root",
    fixture.artifactRoot,
    "--db",
    dbPath,
    "--json",
  ];

  // Phase 1: dry-run proves accounting with no database, artifact store, or
  // network work.
  const dry = runCli([...importArgs, "--dry-run"], env);
  expect(dry.exitCode, dry.stderr).toBe(0);
  const dryData = jsonData(dry);
  expect(dryData).toMatchObject({
    status: "verified",
    dry_run: true,
    counts: {
      candidate_rows: 1088,
      baseline_candidate_rows: 1075,
      appended_candidate_rows: 13,
      telegram_candidate_rows: 131,
      telegram_observations: 294,
      telegram_provenance_merges: 118,
      catalog_memberships: 584,
      approved_offline_artifacts: 581,
      approved_online_jobs: 2,
    },
    dispositions: Object.fromEntries(DISPOSITIONS),
    jobs: { queued: 581, blocked: 11, excluded: 37, evidence_only: 459 },
    run: { id: null, state: "verified" },
  });
  const generationId = dryData.generation_id as string;
  expect(generationId.startsWith("sha256-")).toBe(true);
  expect(existsSync(dbPath)).toBe(false);
  expect(existsSync(join(dataHome, "agentbrain", "artifacts"))).toBe(false);
  expect(existsSync(sentinel)).toBe(false);
  assertSanitized(dry);

  // Materialize an empty, migrated database and capture the verified
  // pre-import snapshot for rollback.
  const migrate = runCli(["worker", "--once", "--db", dbPath, "--json"], env);
  expect(migrate.exitCode, migrate.stderr).toBe(0);
  const preSnapshot = join(fixture.root, "pre-import-snapshot");
  const preBackup = runCli(
    ["backup", "create", "--output", preSnapshot, "--db", dbPath, "--json"],
    env,
  );
  expect(preBackup.exitCode, preBackup.stderr).toBe(0);

  // Phase 2: real admission into the disposable database.
  const imported = runCli(importArgs, env);
  expect(imported.exitCode, imported.stderr).toBe(0);
  const importData = jsonData(imported);
  expect(importData).toMatchObject({
    status: "queued",
    dry_run: false,
    generation_id: generationId,
    counts: { candidate_rows: 1088, telegram_observations: 294 },
    jobs: { queued: 581, blocked: 11, excluded: 37, created: 629, existing: 0 },
    effects: { candidate_outcomes_created: 1088, observations_created: 294 },
  });
  expect((importData.run as { id: number }).id).toBeGreaterThan(0);
  assertSanitized(imported);

  // Phase 2: drain only the 581 offline jobs; approved-online jobs stay
  // non-runnable and no extractor is ever invoked.
  const drain = runCli(["worker", "--once", "--db", dbPath, "--json"], env);
  expect(drain.exitCode, drain.stderr).toBe(0);
  expect(jsonData(drain)).toMatchObject({
    claimed: 581,
    completed: 581,
    failed: 0,
  });
  expect(existsSync(sentinel)).toBe(false);

  const stats = runCli(["jobs", "stats", "--db", dbPath, "--json"], env);
  const statsData = jsonData(stats) as {
    by_state: Record<string, number>;
    runnable_due: number;
  };
  expect(statsData.by_state.completed).toBe(581);
  expect(statsData.by_state.blocked).toBe(11);
  expect(statsData.by_state.queued).toBe(0);
  expect(statsData.runnable_due).toBe(0);

  // Phase 3: FTS retrieval, collection filtering, and citations after import.
  const search = runCli(
    [
      "search",
      "--query",
      "Searchable legacy body",
      "--collection",
      "legacy-links",
      "--limit",
      "5",
      "--db",
      dbPath,
      "--json",
    ],
    env,
  );
  expect(search.exitCode, search.stderr).toBe(0);
  const searchResults = jsonData(search).results as Array<
    Record<string, unknown>
  >;
  expect(searchResults.length).toBeGreaterThan(0);
  expect(searchResults[0].collections).toContain("legacy-links");
  const documentId = searchResults[0].document_id as number;

  const context = runCli(
    [
      "context",
      "Searchable legacy body",
      "--limit",
      "3",
      "--db",
      dbPath,
      "--json",
    ],
    env,
  );
  expect(context.exitCode, context.stderr).toBe(0);
  const hits = jsonData(context).hits as Array<Record<string, unknown>>;
  expect(hits.length).toBeGreaterThan(0);
  expect(String(hits[0].citation).length).toBeGreaterThan(0);

  // Phase 3: verified post-import snapshot restores in isolation, proving
  // database, artifact references, and retained content survive a restore.
  const postSnapshot = join(fixture.root, "post-import-snapshot");
  const postBackup = runCli(
    ["backup", "create", "--output", postSnapshot, "--db", dbPath, "--json"],
    env,
  );
  expect(postBackup.exitCode, postBackup.stderr).toBe(0);
  const verify = runCli(
    ["backup", "verify", "--backup", postSnapshot, "--db", dbPath, "--json"],
    env,
  );
  expect(verify.exitCode, verify.stderr).toBe(0);
  expect(jsonData(verify)).toMatchObject({ verified: true });

  // The restored snapshot preserves generation identity exactly.
  const restoredDb = new Database(join(postSnapshot, BACKUP_DATABASE_FILE), {
    readonly: true,
  });
  const restoredRuns = count(
    restoredDb,
    "SELECT COUNT(*) AS count FROM runs WHERE run_type='legacy_recovery_import'",
  );
  const restoredGeneration = restoredDb
    .query(
      "SELECT checkpoint FROM runs WHERE run_type='legacy_recovery_import'",
    )
    .get() as { checkpoint: string } | null;
  expect(restoredRuns).toBe(1);
  expect(restoredGeneration?.checkpoint).toContain(generationId);
  expect(
    count(
      restoredDb,
      `SELECT COUNT(*) AS count FROM documents WHERE id=${documentId}`,
    ),
  ).toBe(1);
  restoredDb.close();

  // Phase 3: idempotent replay against the live database creates no new work.
  const replay = runCli(importArgs, env);
  expect(replay.exitCode, replay.stderr).toBe(0);
  expect(jsonData(replay)).toMatchObject({
    jobs: { created: 0, existing: 629 },
    effects: {
      candidate_outcomes_created: 0,
      candidate_outcomes_existing: 1088,
      observations_created: 0,
      observations_existing: 294,
    },
  });

  // Rollback: restore the pre-import snapshot into a fresh database and confirm
  // a re-import reproduces the identical admission deterministically.
  const rolledBack = join(fixture.root, "rolled-back.db");
  cpSync(join(preSnapshot, BACKUP_DATABASE_FILE), rolledBack);
  const rolledBackDb = new Database(rolledBack, { readonly: true });
  expect(count(rolledBackDb, "SELECT COUNT(*) AS count FROM jobs")).toBe(0);
  rolledBackDb.close();
  const reimport = runCli(
    [
      "recovery",
      "import",
      "--manifest-generation",
      fixture.descriptor,
      "--artifact-root",
      fixture.artifactRoot,
      "--db",
      rolledBack,
      "--json",
    ],
    env,
  );
  expect(reimport.exitCode, reimport.stderr).toBe(0);
  expect(jsonData(reimport)).toMatchObject({
    generation_id: generationId,
    jobs: { queued: 581, blocked: 11, excluded: 37, created: 629, existing: 0 },
    effects: { candidate_outcomes_created: 1088, observations_created: 294 },
  });
}, 120000);

test("a tampered generation file fails closed without writing state or leaking locators", () => {
  const fixture = makeFixture();
  const { binDir, sentinel } = forbiddenScrapectl(fixture.root);
  const dataHome = join(fixture.root, "data");
  const dbPath = join(fixture.root, "rehearsal.db");
  const env = {
    XDG_DATA_HOME: dataHome,
    PATH: `${binDir}:${originalPath}`,
  };

  // Corrupt one row after the checksum inventory was sealed: the bound hash no
  // longer matches, so the whole generation is rejected as mixed.
  const manifestPath = join(fixture.generationRoot, "candidate-manifest.jsonl");
  const original = readFileSync(manifestPath, "utf8");
  writeFileSync(manifestPath, `${original}{"tampered":true}\n`);

  const result = runCli(
    [
      "recovery",
      "import",
      "--manifest-generation",
      fixture.descriptor,
      "--artifact-root",
      fixture.artifactRoot,
      "--db",
      dbPath,
      "--json",
    ],
    env,
  );
  expect(result.exitCode).not.toBe(0);
  const error = (JSON.parse(result.stdout) as { error: { code: string } })
    .error;
  expect(error.code).toBe("mixed_recovery_generation");
  expect(existsSync(dbPath)).toBe(false);
  expect(existsSync(join(dataHome, "agentbrain", "artifacts"))).toBe(false);
  expect(existsSync(sentinel)).toBe(false);
  assertSanitized(result);
}, 30000);

test("a malformed legacy artifact fails closed before any admission", () => {
  const fixture = makeFixture({ malformedArtifact: true });
  const { binDir, sentinel } = forbiddenScrapectl(fixture.root);
  const dataHome = join(fixture.root, "data");
  const dbPath = join(fixture.root, "rehearsal.db");
  const env = {
    XDG_DATA_HOME: dataHome,
    PATH: `${binDir}:${originalPath}`,
  };

  const result = runCli(
    [
      "recovery",
      "import",
      "--manifest-generation",
      fixture.descriptor,
      "--artifact-root",
      fixture.artifactRoot,
      "--db",
      dbPath,
      "--json",
    ],
    env,
  );
  expect(result.exitCode).not.toBe(0);
  expect(existsSync(dbPath)).toBe(false);
  expect(existsSync(join(dataHome, "agentbrain", "artifacts"))).toBe(false);
  expect(existsSync(sentinel)).toBe(false);
  assertSanitized(result);
}, 30000);
