import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchCache } from "../src/db";
import { ResearchStore } from "../src/store";
import { chunkText } from "../src/text";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentbrain-store-"));
  dirs.push(dir);
  return join(dir, "research.db");
}

function createV1(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '1');
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY, source_type TEXT NOT NULL, source_uri TEXT NOT NULL,
      title TEXT, tags TEXT NOT NULL DEFAULT '[]', notes TEXT, content TEXT NOT NULL,
      content_hash TEXT NOT NULL, size_chars INTEGER NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, UNIQUE(source_type, source_uri)
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL, start_char INTEGER NOT NULL, end_char INTEGER NOT NULL,
      content TEXT NOT NULL, UNIQUE(document_id, chunk_index)
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      document_id UNINDEXED, chunk_id UNINDEXED, title, content, tags, source_uri,
      tokenize='porter unicode61 remove_diacritics 2'
    );
    INSERT INTO documents VALUES (
      7, 'text', 'text:legacy', 'Legacy', '[]', '', 'legacy searchable body',
      'legacy-hash', 22, '2026-01-01', '2026-01-01'
    );
    INSERT INTO chunks VALUES (9, 7, 0, 0, 22, 'legacy searchable body');
    INSERT INTO chunks_fts(rowid, document_id, chunk_id, title, content, tags, source_uri)
      VALUES (9, 7, 9, 'Legacy', 'legacy searchable body', '', 'text:legacy');
  `);
  db.close();
}

test("writable store migrates v1 additively and preserves IDs and FTS", () => {
  const path = tempDb();
  createV1(path);
  const store = new ResearchStore(path);
  store.close();

  const db = new Database(path, { readonly: true });
  expect(
    db.query("SELECT value FROM meta WHERE key='schema_version'").get(),
  ).toEqual({
    value: "2",
  });
  expect(db.query("SELECT id FROM documents").get()).toEqual({ id: 7 });
  expect(
    db
      .query("SELECT name FROM sqlite_master WHERE name='document_links'")
      .get(),
  ).toEqual({ name: "document_links" });
  db.close();

  const cache = new ResearchCache(path);
  expect(
    cache.search({ query: "searchable", mode: "any" }).results[0].document_id,
  ).toBe(7);
  cache.close();
});

test("upsert is transactional, unchanged-aware, and manually maintains FTS", () => {
  const path = tempDb();
  const store = new ResearchStore(path);
  const created = store.upsertDocument({
    sourceType: "text",
    sourceUri: "text:one",
    title: "One",
    content: "alpha searchable content",
    tags: ["Alpha", "alpha", "two words"],
  });
  expect(created.status).toBe("created");
  expect(created.tags).toEqual(["alpha", "two-words"]);
  const unchanged = store.upsertDocument({
    sourceType: "text",
    sourceUri: "text:one",
    title: "One",
    content: "alpha searchable content",
    tags: ["Alpha", "alpha", "two words"],
  });
  expect(unchanged).toMatchObject({
    status: "unchanged",
    document_id: created.document_id,
  });
  const updated = store.upsertDocument({
    sourceType: "text",
    sourceUri: "text:one",
    title: "One",
    content: "replacement beta content",
    tags: ["alpha", "two words"],
  });
  expect(updated).toMatchObject({
    status: "updated",
    document_id: created.document_id,
  });
  store.close();

  const cache = new ResearchCache(path);
  expect(cache.search({ query: "beta", mode: "any" }).results).toHaveLength(1);
  expect(
    cache.search({ query: "searchable", mode: "any" }).results,
  ).toHaveLength(0);
  cache.close();
});

test("chunk offsets and size_chars count Unicode code points, including non-BMP", () => {
  const text = `${"a".repeat(1900)}😀 paragraph. ${"b".repeat(1900)}🧠 end`;
  const chunks = chunkText(text);
  const points = Array.from(text);
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(points.slice(chunk.start, chunk.end).join("").trim()).toBe(
      chunk.content,
    );
  }

  const path = tempDb();
  const store = new ResearchStore(path);
  const result = store.upsertDocument({
    sourceType: "text",
    sourceUri: "text:unicode",
    content: text,
  });
  expect(result.size_chars).toBe(points.length);
  store.close();
  const db = new Database(path, { readonly: true });
  const rows = db
    .query(
      "SELECT start_char, end_char, content FROM chunks ORDER BY chunk_index",
    )
    .all() as Array<{
    start_char: number;
    end_char: number;
    content: string;
  }>;
  for (const row of rows) {
    expect(points.slice(row.start_char, row.end_char).join("").trim()).toBe(
      row.content,
    );
  }
  db.close();
});

test("failed relation retries in place, shared targets survive delete as null links", () => {
  const path = tempDb();
  const store = new ResearchStore(path);
  const parentA = store.upsertDocument({
    sourceType: "text",
    sourceUri: "a",
    content: "parent a",
  });
  const parentB = store.upsertDocument({
    sourceType: "text",
    sourceUri: "b",
    content: "parent b",
  });
  const child = store.upsertDocument({
    sourceType: "text",
    sourceUri: "child",
    content: "child",
  });
  const failed = store.upsertDocumentLink({
    fromDocumentId: parentA.document_id,
    discoveredUrl: "https://example.com/child",
    status: "failed",
    error: "temporary",
  });
  const retried = store.upsertDocumentLink({
    fromDocumentId: parentA.document_id,
    discoveredUrl: "https://example.com/child",
    toDocumentId: child.document_id,
    status: "success",
  });
  store.upsertDocumentLink({
    fromDocumentId: parentB.document_id,
    discoveredUrl: "https://example.com/child",
    toDocumentId: child.document_id,
    status: "success",
  });
  expect(retried.id).toBe(failed.id);
  store.deleteDocument({ documentId: child.document_id, confirm: "delete" });
  const links = store.db
    .query("SELECT to_document_id, status FROM document_links ORDER BY id")
    .all();
  expect(links).toEqual([
    { to_document_id: null, status: "success" },
    { to_document_id: null, status: "success" },
  ]);
  store.close();
});

test("immediate write transactions serialize concurrent duplicate upserts", async () => {
  const path = tempDb();
  const initialized = new ResearchStore(path);
  initialized.close();
  const repo = join(import.meta.dir, "..");
  const processes = Array.from({ length: 4 }, () =>
    Bun.spawn({
      cmd: [
        "bun",
        "run",
        "src/cli.ts",
        "ingest",
        "concurrent stable text",
        "--source-type",
        "text",
        "--json",
        "--db",
        path,
      ],
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const results = await Promise.all(
    processes.map(async (process) => ({
      exitCode: await process.exited,
      stdout: await new Response(process.stdout).text(),
      stderr: await new Response(process.stderr).text(),
    })),
  );
  expect(results.map((result) => result.exitCode)).toEqual([0, 0, 0, 0]);
  const statuses = results.map(
    (result) => JSON.parse(result.stdout).data.status,
  );
  expect(statuses.filter((status) => status === "created")).toHaveLength(1);
  expect(statuses.filter((status) => status === "unchanged")).toHaveLength(3);
  const db = new Database(path, { readonly: true });
  expect(db.query("SELECT COUNT(*) AS count FROM documents").get()).toEqual({
    count: 1,
  });
  db.close();
});

test("newer schema versions are rejected", () => {
  const path = tempDb();
  const db = new Database(path);
  db.exec(
    "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version','3')",
  );
  db.close();
  expect(() => new ResearchStore(path)).toThrow("newer than supported");
  expect(() => new ResearchCache(path)).toThrow("newer than supported");
});
