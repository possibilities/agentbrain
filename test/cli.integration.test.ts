import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDb(name: string, withLinks: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), `agentbrain-${name}-`));
  tempDirs.push(dir);
  const path = join(dir, "research.db");
  const db = new Database(path);
  db.exec(`
    PRAGMA journal_mode = OFF;
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY,
      title TEXT,
      source_uri TEXT NOT NULL,
      source_type TEXT NOT NULL,
      tags TEXT NOT NULL,
      notes TEXT,
      size_chars INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      content TEXT NOT NULL
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      start_char INTEGER NOT NULL,
      end_char INTEGER NOT NULL,
      content TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      document_id UNINDEXED,
      chunk_id UNINDEXED,
      chunk_index UNINDEXED,
      content
    );
  `);

  if (withLinks) {
    db.exec(`
      CREATE TABLE document_links (
        id INTEGER PRIMARY KEY,
        from_document_id INTEGER NOT NULL,
        to_document_id INTEGER,
        relation_type TEXT NOT NULL,
        discovered_url TEXT,
        resolved_url TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  const docs = [
    {
      id: 1,
      title: "Agent Memory Notes",
      source_uri: "https://x.com/a/status/1",
      source_type: "tweet_article",
      tags: JSON.stringify(["x", "memory"]),
      notes: "primary",
      size_chars: 62,
      content_hash: "hash-1",
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-03T00:00:00.000Z",
      content:
        "Agent memory systems help coding agents keep relevant research close.",
    },
    {
      id: 2,
      title: "Tweet Source",
      source_uri: "https://x.com/b/status/2",
      source_type: "tweet",
      tags: JSON.stringify(["x"]),
      notes: null,
      size_chars: 30,
      content_hash: "hash-2",
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-02T00:00:00.000Z",
      content: "Short tweet about agent links.",
    },
    {
      id: 3,
      title: "Scraped URL",
      source_uri: "https://example.com/article",
      source_type: "scraped_url",
      tags: JSON.stringify(["web"]),
      notes: null,
      size_chars: 46,
      content_hash: "hash-3",
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-04T00:00:00.000Z",
      content: "An article that cites the tweet article.",
    },
  ];

  for (const doc of docs) {
    db.query(
      `INSERT INTO documents
        (id, title, source_uri, source_type, tags, notes, size_chars, content_hash, created_at, updated_at, content)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      doc.id,
      doc.title,
      doc.source_uri,
      doc.source_type,
      doc.tags,
      doc.notes,
      doc.size_chars,
      doc.content_hash,
      doc.created_at,
      doc.updated_at,
      doc.content,
    );
  }

  const chunks = [
    {
      id: 11,
      document_id: 1,
      chunk_index: 0,
      start_char: 0,
      end_char: 62,
      content: docs[0].content,
    },
    {
      id: 12,
      document_id: 2,
      chunk_index: 0,
      start_char: 0,
      end_char: 30,
      content: docs[1].content,
    },
    {
      id: 13,
      document_id: 3,
      chunk_index: 0,
      start_char: 0,
      end_char: 46,
      content: docs[2].content,
    },
  ];

  for (const chunk of chunks) {
    db.query(
      `INSERT INTO chunks (id, document_id, chunk_index, start_char, end_char, content)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      chunk.id,
      chunk.document_id,
      chunk.chunk_index,
      chunk.start_char,
      chunk.end_char,
      chunk.content,
    );
    db.query(
      `INSERT INTO chunks_fts (document_id, chunk_id, chunk_index, content)
       VALUES (?, ?, ?, ?)`,
    ).run(chunk.document_id, chunk.id, chunk.chunk_index, chunk.content);
  }

  if (withLinks) {
    const links = [
      {
        id: 21,
        from_document_id: 1,
        to_document_id: 2,
        relation_type: "references",
        discovered_url: "https://x.com/b/status/2",
        resolved_url: "https://x.com/b/status/2",
        status: "success",
        error: null,
      },
      {
        id: 22,
        from_document_id: 3,
        to_document_id: 1,
        relation_type: "references",
        discovered_url: "https://x.com/a/status/1",
        resolved_url: "https://x.com/a/status/1",
        status: "success",
        error: null,
      },
      {
        id: 23,
        from_document_id: 1,
        to_document_id: null,
        relation_type: "saved_link",
        discovered_url: "https://example.com/missing",
        resolved_url: null,
        status: "failed",
        error: "unresolved",
      },
    ];

    for (const link of links) {
      db.query(
        `INSERT INTO document_links
          (id, from_document_id, to_document_id, relation_type, discovered_url, resolved_url, status, error, created_at, updated_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        link.id,
        link.from_document_id,
        link.to_document_id,
        link.relation_type,
        link.discovered_url,
        link.resolved_url,
        link.status,
        link.error,
        "2025-01-05T00:00:00.000Z",
        "2025-01-05T00:00:00.000Z",
      );
    }
  }

  db.close();
  return path;
}

function makeDurableQueryDb(): string {
  const path = makeTempDb("durable-query", true);
  const db = new Database(path);
  db.exec(`
    CREATE TABLE sensitivity_levels (level TEXT PRIMARY KEY, rank INTEGER NOT NULL UNIQUE);
    INSERT INTO sensitivity_levels VALUES
      ('public', 0), ('normal', 1), ('sensitive', 2), ('private', 3);
    CREATE TABLE resources (
      id INTEGER PRIMARY KEY,
      key_type TEXT NOT NULL,
      key_value TEXT NOT NULL,
      kind TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      document_id INTEGER UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE resource_aliases (
      id INTEGER PRIMARY KEY,
      resource_id INTEGER NOT NULL,
      alias_type TEXT NOT NULL,
      locator TEXT NOT NULL,
      evidence TEXT,
      first_observed_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL
    );
    CREATE TABLE sources (
      id INTEGER PRIMARY KEY,
      source_type TEXT NOT NULL,
      identifier TEXT NOT NULL,
      display_name TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      sensitivity TEXT NOT NULL,
      schedule TEXT,
      checkpoint TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE collections (
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE collection_memberships (
      id INTEGER PRIMARY KEY,
      collection_id INTEGER NOT NULL,
      resource_id INTEGER NOT NULL,
      position INTEGER,
      external_ref TEXT,
      added_at TEXT NOT NULL
    );
    CREATE TABLE runs (
      id INTEGER PRIMARY KEY,
      run_type TEXT NOT NULL,
      source_id INTEGER,
      state TEXT NOT NULL,
      checkpoint TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY,
      resource_id INTEGER NOT NULL,
      source_id INTEGER,
      run_id INTEGER,
      ingress TEXT NOT NULL,
      observed_locator TEXT,
      suppressed INTEGER NOT NULL DEFAULT 0,
      suppressed_reason TEXT,
      observed_at TEXT NOT NULL
    );
    CREATE TABLE provenance (
      id INTEGER PRIMARY KEY,
      resource_id INTEGER NOT NULL,
      evidence_type TEXT NOT NULL,
      source_id INTEGER,
      run_id INTEGER,
      artifact_id INTEGER,
      relation_id INTEGER,
      ingress TEXT,
      raw_metadata TEXT,
      observed_at TEXT NOT NULL
    );
    INSERT INTO resources VALUES
      (101, 'provider', 'one', 'note', 'private', 1, '2025-01-01', '2025-01-03'),
      (102, 'provider', 'two', 'post', 'public', 2, '2025-01-01', '2025-01-02'),
      (103, 'url', 'three', 'article', 'normal', 3, '2025-01-01', '2025-01-04');
    INSERT INTO resource_aliases(
      resource_id, alias_type, locator, first_observed_at, last_observed_at
    ) VALUES (101, 'local_path', '/vault/agent.md', '2025-01-01', '2025-01-03');
    INSERT INTO collections VALUES
      (201, 'shared', 'Shared', 'public', '2025-01-01', '2025-01-01');
    INSERT INTO collection_memberships(collection_id, resource_id, added_at) VALUES
      (201, 101, '2025-01-01'), (201, 102, '2025-01-01');
    INSERT INTO sources VALUES
      (301, 'feed', 'agent-feed', NULL, 1, 'public', NULL, NULL, '2025-01-01', '2025-01-01');
    INSERT INTO observations(resource_id, source_id, ingress, observed_locator, observed_at) VALUES
      (101, 301, 'source-scheduler', 'one', '2025-01-01'),
      (102, 301, 'source-scheduler', 'two', '2025-01-01');
  `);
  db.close();
  return path;
}

function runCli(
  args: string[],
  dbPath?: string,
  env: Record<string, string> = {},
) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli.ts", ...args],
    cwd: REPO,
    env: {
      ...process.env,
      ...env,
      ...(dbPath !== undefined ? { AGENTBRAIN_DB: dbPath } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function decode(value: Uint8Array | string): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

test("json error envelope works with spaced --format json", () => {
  const proc = runCli([
    "stats",
    "--db",
    "/definitely/missing.db",
    "--format",
    "json",
  ]);
  expect(proc.exitCode).toBe(1);
  const payload = JSON.parse(decode(proc.stdout).trim());
  expect(payload.ok).toBe(false);
  expect(payload.schema_version).toBe(1);
  expect(payload.error.code).toBe("db_not_found");
  expect(decode(proc.stderr)).toBe("");
});

test("json parse errors stay machine-readable", () => {
  const proc = runCli(["stats", "--format", "json", "--db"]);
  expect(proc.exitCode).toBe(2);
  const payload = JSON.parse(decode(proc.stdout).trim());
  expect(payload).toMatchObject({
    ok: false,
    schema_version: 1,
    command: "(none)",
    error: { code: "missing_value" },
  });
  expect(decode(proc.stderr)).toBe("");
});

test("v1 fallback keeps relation arrays empty and stats zeroed", () => {
  const dbPath = makeTempDb("v1", false);
  const stats = runCli(["stats", "--json"], dbPath);
  expect(stats.exitCode).toBe(0);
  const statsPayload = JSON.parse(decode(stats.stdout).trim());
  expect(statsPayload.data.relation_count).toBe(0);
  expect(statsPayload.data.failed_relation_count).toBe(0);

  const get = runCli(["get", "--document-id", "1", "--json"], dbPath);
  expect(get.exitCode).toBe(0);
  const getPayload = JSON.parse(decode(get.stdout).trim());
  expect(getPayload.data.outbound_links).toEqual([]);
  expect(getPayload.data.inbound_links).toEqual([]);
});

test("v2 relations appear in get and stats", () => {
  const dbPath = makeTempDb("v2", true);
  const stats = runCli(["stats", "--json"], dbPath);
  expect(stats.exitCode).toBe(0);
  const statsPayload = JSON.parse(decode(stats.stdout).trim());
  expect(statsPayload.data.relation_count).toBe(3);
  expect(statsPayload.data.failed_relation_count).toBe(1);

  const get = runCli(["get", "--document-id", "1", "--json"], dbPath);
  expect(get.exitCode).toBe(0);
  const payload = JSON.parse(decode(get.stdout).trim());
  expect(payload.data.outbound_links).toHaveLength(2);
  expect(payload.data.inbound_links).toHaveLength(1);
  expect(payload.data.outbound_links[0]).toMatchObject({
    id: 21,
    from_document_id: 1,
    to_document_id: 2,
    relation_type: "references",
    status: "success",
  });
  expect(payload.data.outbound_links[1]).toMatchObject({
    id: 23,
    from_document_id: 1,
    to_document_id: null,
    relation_type: "saved_link",
    status: "failed",
    error: "unresolved",
  });
  expect(payload.data.inbound_links[0]).toMatchObject({
    id: 22,
    from_document_id: 3,
    to_document_id: 1,
    relation_type: "references",
    status: "success",
  });
});

test("fts search and get work against the fixture DB", () => {
  const dbPath = makeTempDb("fts", true);
  const search = runCli(["search", "memory", "--json"], dbPath);
  expect(search.exitCode).toBe(0);
  const searchPayload = JSON.parse(decode(search.stdout).trim());
  expect(searchPayload.ok).toBe(true);
  expect(searchPayload.data.results).toHaveLength(1);
  expect(searchPayload.data.results[0]).toMatchObject({
    document_id: 1,
    chunk_id: 11,
    source_type: "tweet_article",
  });

  const get = runCli(["get", "--document-id", "1", "--json"], dbPath);
  expect(get.exitCode).toBe(0);
  const getPayload = JSON.parse(decode(get.stdout).trim());
  expect(getPayload.data.content).toContain("Agent memory systems");
});

test("search and context expose durable filters without relation content expansion", () => {
  const dbPath = makeDurableQueryDb();
  const search = runCli(
    [
      "search",
      "agent",
      "--collection",
      "shared",
      "--source",
      "agent-feed",
      "--json",
    ],
    dbPath,
  );
  expect(search.exitCode).toBe(0);
  const payload = JSON.parse(decode(search.stdout).trim());
  expect(payload.data.filters).toMatchObject({
    collection: "shared",
    source: "agent-feed",
  });
  expect(
    payload.data.results
      .map((result: { resource_id: number }) => result.resource_id)
      .sort(),
  ).toEqual([101, 102]);
  expect(payload.data.results[0]).toHaveProperty("relations");

  const privateContext = runCli(
    [
      "context",
      "agent",
      "--sensitivity",
      "private",
      "--local-path",
      "/vault/agent.md",
      "--json",
    ],
    dbPath,
  );
  expect(privateContext.exitCode).toBe(0);
  const contextPayload = JSON.parse(decode(privateContext.stdout).trim());
  expect(contextPayload.data.hits).toHaveLength(1);
  expect(contextPayload.data.hits[0]).toMatchObject({
    resource_id: 101,
    resource_kind: "note",
    sensitivity: "private",
    relations: [],
  });
  expect(contextPayload.data.hits[0].content).not.toContain("Short tweet");
});

test("submit emits stable human and JSON queued and duplicate acknowledgements", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbrain-submit-cli-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "research.db");
  const env = { XDG_DATA_HOME: join(dir, "data") };
  const args = [
    "submit",
    "https://Example.com/article#fragment",
    "--kind",
    "url",
    "--idempotency-key",
    "cli-url",
  ];
  const human = runCli(args, dbPath, env);
  expect(human.exitCode).toBe(0);
  expect(decode(human.stdout)).toBe(
    "queued: ingestion job 1\nidempotency_key: cli-url\nstate: queued\n",
  );
  expect(decode(human.stderr)).toBe("");

  const duplicate = runCli([...args, "--json"], dbPath, env);
  expect(duplicate.exitCode).toBe(0);
  expect(JSON.parse(decode(duplicate.stdout))).toMatchObject({
    schema_version: 1,
    ok: true,
    command: "submit",
    data: {
      version: 1,
      status: "duplicate",
      job_id: 1,
      idempotency_key: "cli-url",
      intent_hash:
        "e6cc973d1d4644587c85856379900d4390cc660dc7e331bb05b2d8d345fce3b0",
      state: "queued",
    },
    meta: { read_only: false },
  });
});

test("legacy ingest queues text without writing documents and wait timeout preserves it", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbrain-ingest-alias-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "research.db");
  const proc = runCli(
    [
      "ingest",
      "durable text",
      "--source-type",
      "text",
      "--wait",
      "--wait-timeout-ms",
      "0",
      "--json",
    ],
    dbPath,
    { XDG_DATA_HOME: join(dir, "data") },
  );
  expect(proc.exitCode).toBe(0);
  expect(JSON.parse(decode(proc.stdout))).toMatchObject({
    ok: true,
    command: "ingest",
    data: {
      version: 1,
      status: "queued",
      job_id: 1,
      state: "queued",
      wait_status: "timeout",
    },
    meta: { read_only: false },
  });
  const db = new Database(dbPath, { readonly: true });
  expect(db.query("SELECT id, state FROM jobs").all()).toEqual([
    { id: 1, state: "queued" },
  ]);
  expect(db.query("SELECT COUNT(*) AS count FROM documents").get()).toEqual({
    count: 0,
  });
  db.close();
});

test("invalid submission fails before creating a job or Artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbrain-invalid-submit-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "research.db");
  const proc = runCli(
    ["submit", "hello", "--intent-version", "2", "--json"],
    dbPath,
    { XDG_DATA_HOME: join(dir, "data") },
  );
  expect(proc.exitCode).toBe(2);
  expect(JSON.parse(decode(proc.stdout))).toMatchObject({
    schema_version: 1,
    ok: false,
    command: "submit",
    error: {
      code: "unsupported_submission_version",
      message: "submission version must be 1",
    },
  });
  const db = new Database(dbPath, { readonly: true });
  expect(db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
    count: 0,
  });
  expect(db.query("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({
    count: 0,
  });
  db.close();
});

test("completed-link compatibility commands are absent from every public surface", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbrain-retired-command-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "research.db");
  const retired = runCli(["ingest-link", "--json"], dbPath);
  expect(retired.exitCode).toBe(2);
  expect(JSON.parse(decode(retired.stdout))).toMatchObject({
    ok: false,
    command: "ingest-link",
    error: { code: "unknown_command" },
  });
  expect(existsSync(dbPath)).toBe(false);

  const topHelp = decode(runCli(["--help"]).stdout);
  const guide = decode(runCli(["guide", "--json"]).stdout);
  const prompt = decode(runCli(["prompt"]).stdout);
  for (const output of [topHelp, guide, prompt]) {
    expect(output).not.toContain("ingest-link");
    expect(output).not.toContain("completed-link");
  }

  const pkg = await Bun.file(join(REPO, "package.json")).json();
  expect(pkg.bin).toEqual({ agentbrain: "src/cli.ts" });
  expect(existsSync(join(REPO, "src/research-ingest-link.ts"))).toBe(false);
  expect(existsSync(join(REPO, "src/completed-link-input.ts"))).toBe(false);
});
