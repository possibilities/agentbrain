import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

function runCli(args: string[], dbPath?: string) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli.ts", ...args],
    cwd: REPO,
    env: {
      ...process.env,
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
