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

function createV2(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '2');
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
    CREATE TABLE document_links (
      id INTEGER PRIMARY KEY,
      from_document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      to_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
      relation_type TEXT NOT NULL, discovered_url TEXT NOT NULL, resolved_url TEXT,
      status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(from_document_id, relation_type, discovered_url)
    );
    INSERT INTO documents VALUES
      (3, 'url', 'https://a.example/post', 'A', '[]', '', 'alpha body', 'ha', 10, '2026-02-01', '2026-02-01'),
      (5, 'url', 'https://b.example/post', 'B', '[]', '', 'beta body', 'hb', 9, '2026-02-02', '2026-02-02');
    INSERT INTO chunks VALUES
      (11, 3, 0, 0, 10, 'alpha body'),
      (13, 5, 0, 0, 9, 'beta body');
    INSERT INTO chunks_fts(rowid, document_id, chunk_id, title, content, tags, source_uri) VALUES
      (11, 3, 11, 'A', 'alpha body', '', 'https://a.example/post'),
      (13, 5, 13, 'B', 'beta body', '', 'https://b.example/post');
    INSERT INTO document_links VALUES
      (2, 3, 5, 'content_link', 'https://a.example/child', 'https://b.example/post', 'success', NULL, '2026-02-03', '2026-02-03');
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
    value: "3",
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
  // Legacy document 7 gains a durable resource whose exact submitted URI is
  // preserved as a first-class alias without inventing a normalized identity.
  const resource = cache.resourceForDocument(7);
  expect(resource).not.toBeNull();
  expect(resource?.document_id).toBe(7);
  expect(resource?.key_type).toBe("legacy_document");
  expect(resource?.key_value).toBe("7");
  expect(resource?.kind).toBe("text");
  expect(resource?.sensitivity).toBe("normal");
  expect(
    resource?.aliases.map((alias) => [alias.alias_type, alias.locator]),
  ).toEqual([["legacy_source_uri", "text:legacy"]]);
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
    "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version','4')",
  );
  db.close();
  expect(() => new ResearchStore(path)).toThrow("newer than supported");
  expect(() => new ResearchCache(path)).toThrow("newer than supported");
});

test("migration maps legacy documents and relation provenance", () => {
  const path = tempDb();
  createV2(path);
  const store = new ResearchStore(path);
  store.close();

  const cache = new ResearchCache(path);
  expect(cache.resourceForDocument(3)?.aliases.map((a) => a.locator)).toEqual([
    "https://a.example/post",
  ]);
  expect(cache.resourceForDocument(5)?.aliases.map((a) => a.locator)).toEqual([
    "https://b.example/post",
  ]);
  cache.close();

  const db = new Database(path, { readonly: true });
  // The existing relation is untouched and mapped as provenance on the
  // originating resource, preserving its identity without inventing evidence.
  expect(db.query("SELECT COUNT(*) AS c FROM document_links").get()).toEqual({
    c: 1,
  });
  expect(
    db
      .query(
        `SELECT p.evidence_type, p.relation_id, p.raw_metadata
         FROM provenance p JOIN resources r ON r.id = p.resource_id
         WHERE r.document_id = 3`,
      )
      .get(),
  ).toEqual({
    evidence_type: "legacy_relation",
    relation_id: 2,
    raw_metadata: "https://a.example/child",
  });
  db.close();
});

test("read-only cache opens a legacy v2 database without migrating it", () => {
  const path = tempDb();
  createV2(path);
  const cache = new ResearchCache(path);
  // Read commands still work against the un-migrated schema.
  expect(cache.search({ query: "alpha", mode: "any" }).results).toHaveLength(1);
  expect(cache.resourceForDocument(3)).toBeNull();
  cache.close();

  // The database is untouched: still v2, with no resource model created.
  const db = new Database(path, { readonly: true });
  expect(
    db.query("SELECT value FROM meta WHERE key='schema_version'").get(),
  ).toEqual({ value: "2" });
  expect(
    db
      .query("SELECT COUNT(*) AS c FROM sqlite_master WHERE name='resources'")
      .get(),
  ).toEqual({ c: 0 });
  db.close();
});

test("equal artifact digests and canonical URLs never merge resources", () => {
  const path = tempDb();
  const store = new ResearchStore(path);
  const now = "2026-03-01";
  const insertResource = (keyValue: string): number =>
    Number(
      store.db
        .query(
          `INSERT INTO resources(key_type, key_value, kind, created_at, updated_at)
           VALUES ('url', ?, 'url', ?, ?)`,
        )
        .run(keyValue, now, now).lastInsertRowid,
    );
  const a = insertResource("url:https://a.example/");
  const b = insertResource("url:https://b.example/");
  const artifact = Number(
    store.db
      .query(
        `INSERT INTO artifacts(content_hash, media_type, byte_size, artifact_role, created_at)
         VALUES ('sha256:shared', 'text/markdown', 12, 'normalized_markdown', ?)`,
      )
      .run(now).lastInsertRowid,
  );
  // The same immutable bytes attach to two distinct resources, and the same
  // observed canonical URL is a per-resource alias on both.
  for (const id of [a, b]) {
    store.db
      .query(
        "INSERT INTO resource_artifacts(resource_id, artifact_id, observed_at) VALUES (?, ?, ?)",
      )
      .run(id, artifact, now);
    store.db
      .query(
        `INSERT INTO resource_aliases(resource_id, alias_type, locator, first_observed_at, last_observed_at)
         VALUES (?, 'publisher_canonical', 'https://canonical.example/x', ?, ?)`,
      )
      .run(id, now, now);
  }
  expect(a).not.toBe(b);
  expect(store.db.query("SELECT COUNT(*) AS c FROM resources").get()).toEqual({
    c: 2,
  });
  expect(store.db.query("SELECT COUNT(*) AS c FROM artifacts").get()).toEqual({
    c: 1,
  });
  expect(
    store.db
      .query(
        "SELECT COUNT(DISTINCT resource_id) AS c FROM resource_aliases WHERE locator = 'https://canonical.example/x'",
      )
      .get(),
  ).toEqual({ c: 2 });
  store.close();
});

test("domain constraints enforce cardinality, uniqueness, and sensitivity", () => {
  const path = tempDb();
  const store = new ResearchStore(path);
  const now = "2026-04-01";
  const insertResource = (keyValue: string, sensitivity = "normal"): number =>
    Number(
      store.db
        .query(
          `INSERT INTO resources(key_type, key_value, kind, sensitivity, created_at, updated_at)
           VALUES ('url', ?, 'url', ?, ?, ?)`,
        )
        .run(keyValue, sensitivity, now, now).lastInsertRowid,
    );
  const r1 = insertResource("url:https://one.example/");

  // A typed resource key is unique: identity cannot silently merge.
  expect(() => insertResource("url:https://one.example/")).toThrow();
  // Sensitivity is drawn from a closed vocabulary, enforced by foreign key.
  expect(() => insertResource("url:https://two.example/", "secret")).toThrow();

  // A suppressed observation must carry a durable reason rather than vanish.
  expect(() =>
    store.db
      .query(
        `INSERT INTO observations(resource_id, ingress, suppressed, observed_at)
         VALUES (?, 'cli', 1, ?)`,
      )
      .run(r1, now),
  ).toThrow();
  store.db
    .query(
      `INSERT INTO observations(resource_id, ingress, suppressed, suppressed_reason, observed_at)
       VALUES (?, 'cli', 1, 'per-source limit', ?)`,
    )
    .run(r1, now);

  // Ordered membership positions are unique within a collection; the legacy
  // positional identifier rides along as an external reference, not a key.
  const collection = Number(
    store.db
      .query(
        `INSERT INTO collections(slug, title, created_at, updated_at)
         VALUES ('saved-links', 'Saved links', ?, ?)`,
      )
      .run(now, now).lastInsertRowid,
  );
  const r2 = insertResource("url:https://three.example/");
  store.db
    .query(
      `INSERT INTO collection_memberships(collection_id, resource_id, position, external_ref, added_at)
       VALUES (?, ?, 0, 'link-00001', ?)`,
    )
    .run(collection, r1, now);
  expect(() =>
    store.db
      .query(
        `INSERT INTO collection_memberships(collection_id, resource_id, position, added_at)
         VALUES (?, ?, 0, ?)`,
      )
      .run(collection, r2, now),
  ).toThrow();
  store.close();
});
