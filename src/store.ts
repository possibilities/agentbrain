import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CliError } from "./errors";
import {
  chunkText,
  cleanText,
  codePointLength,
  normalizeTags,
  sha256Text,
} from "./text";

export const RESEARCH_SCHEMA_VERSION = 3;

interface Row {
  [key: string]: unknown;
}

export interface UpsertDocumentInput {
  sourceType: string;
  sourceUri: string;
  title?: string | null;
  content: string;
  tags?: unknown;
  notes?: string | null;
  force?: boolean;
}

export interface UpsertDocumentResult {
  success: true;
  status: "created" | "updated" | "unchanged";
  document_id: number;
  title: string;
  source_uri: string;
  source_type?: string;
  size_chars: number;
  chunk_count?: number;
  tags: string[];
}

export interface DocumentLinkResult {
  success: true;
  id: number;
  from_document_id: number;
  to_document_id: number | null;
  relation_type: string;
  discovered_url: string;
  resolved_url: string | null;
  status: "success" | "failed";
  error: string | null;
  created_at: string;
  updated_at: string;
}

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_uri TEXT NOT NULL,
    title TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    notes TEXT,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    size_chars INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(source_type, source_uri)
  );

  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    start_char INTEGER NOT NULL,
    end_char INTEGER NOT NULL,
    content TEXT NOT NULL,
    UNIQUE(document_id, chunk_index)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    document_id UNINDEXED,
    chunk_id UNINDEXED,
    title,
    content,
    tags,
    source_uri,
    tokenize='porter unicode61 remove_diacritics 2'
  );

  CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_type, source_uri);
  CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id, chunk_index);
`;

const MIGRATION_V2 = `
  CREATE TABLE IF NOT EXISTS document_links (
    id INTEGER PRIMARY KEY,
    from_document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    to_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    relation_type TEXT NOT NULL,
    discovered_url TEXT NOT NULL,
    resolved_url TEXT,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(from_document_id, relation_type, discovered_url)
  );
  CREATE INDEX IF NOT EXISTS idx_document_links_from
    ON document_links(from_document_id, relation_type, status);
  CREATE INDEX IF NOT EXISTS idx_document_links_to
    ON document_links(to_document_id, relation_type);
  CREATE INDEX IF NOT EXISTS idx_document_links_status
    ON document_links(status, updated_at DESC);
  UPDATE meta SET value='2' WHERE key='schema_version';
`;

// Additive durable-ingestion domain model. Legacy documents/chunks/FTS and
// document_links are untouched; resources reference them by nullable FK so a
// resource's identity survives content deletion. Artifact bytes dedupe by
// digest while resources link them many-to-many, and observed locators are
// per-resource aliases: equal digests and canonical URLs never collapse two
// resources (ADR 0006, ADR 0008).
const MIGRATION_V3 = `
  CREATE TABLE IF NOT EXISTS sensitivity_levels (
    level TEXT PRIMARY KEY,
    rank INTEGER NOT NULL UNIQUE
  );
  INSERT OR IGNORE INTO sensitivity_levels(level, rank) VALUES
    ('public', 0), ('normal', 1), ('sensitive', 2), ('private', 3);

  CREATE TABLE IF NOT EXISTS resources (
    id INTEGER PRIMARY KEY,
    key_type TEXT NOT NULL,
    key_value TEXT NOT NULL,
    kind TEXT NOT NULL,
    sensitivity TEXT NOT NULL DEFAULT 'normal' REFERENCES sensitivity_levels(level),
    document_id INTEGER UNIQUE REFERENCES documents(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(key_type, key_value)
  );
  CREATE INDEX IF NOT EXISTS idx_resources_kind ON resources(kind, updated_at DESC);

  CREATE TABLE IF NOT EXISTS resource_aliases (
    id INTEGER PRIMARY KEY,
    resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    alias_type TEXT NOT NULL,
    locator TEXT NOT NULL,
    evidence TEXT,
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    UNIQUE(resource_id, alias_type, locator)
  );
  CREATE INDEX IF NOT EXISTS idx_resource_aliases_locator
    ON resource_aliases(locator, alias_type);

  CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY,
    content_hash TEXT NOT NULL,
    media_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    artifact_role TEXT NOT NULL,
    sensitivity TEXT NOT NULL DEFAULT 'normal' REFERENCES sensitivity_levels(level),
    storage_path TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(content_hash, artifact_role)
  );

  CREATE TABLE IF NOT EXISTS resource_artifacts (
    id INTEGER PRIMARY KEY,
    resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    observed_at TEXT NOT NULL,
    UNIQUE(resource_id, artifact_id)
  );

  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY,
    source_type TEXT NOT NULL,
    identifier TEXT NOT NULL,
    display_name TEXT,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    sensitivity TEXT NOT NULL DEFAULT 'normal' REFERENCES sensitivity_levels(level),
    schedule TEXT,
    checkpoint TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(source_type, identifier)
  );

  CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    sensitivity TEXT NOT NULL DEFAULT 'normal' REFERENCES sensitivity_levels(level),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS collection_memberships (
    id INTEGER PRIMARY KEY,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    position INTEGER,
    external_ref TEXT,
    added_at TEXT NOT NULL,
    UNIQUE(collection_id, resource_id),
    UNIQUE(collection_id, position)
  );

  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    run_type TEXT NOT NULL,
    source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending', 'active', 'completed', 'failed', 'cancelled')),
    checkpoint TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_runs_source ON runs(source_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY,
    resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
    ingress TEXT NOT NULL,
    observed_locator TEXT,
    suppressed INTEGER NOT NULL DEFAULT 0 CHECK (suppressed IN (0, 1)),
    suppressed_reason TEXT,
    observed_at TEXT NOT NULL,
    CHECK (suppressed = 0 OR suppressed_reason IS NOT NULL),
    UNIQUE(run_id, resource_id, observed_locator)
  );
  CREATE INDEX IF NOT EXISTS idx_observations_resource
    ON observations(resource_id, observed_at DESC);

  CREATE TABLE IF NOT EXISTS provenance (
    id INTEGER PRIMARY KEY,
    resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    evidence_type TEXT NOT NULL,
    source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
    artifact_id INTEGER REFERENCES artifacts(id) ON DELETE SET NULL,
    relation_id INTEGER REFERENCES document_links(id) ON DELETE SET NULL,
    ingress TEXT,
    raw_metadata TEXT,
    observed_at TEXT NOT NULL,
    UNIQUE(resource_id, evidence_type, source_id, run_id, artifact_id, relation_id)
  );
  CREATE INDEX IF NOT EXISTS idx_provenance_resource
    ON provenance(resource_id, evidence_type);

  INSERT INTO resources(
    key_type, key_value, kind, sensitivity, document_id, created_at, updated_at
  )
    SELECT 'legacy_document', CAST(d.id AS TEXT), d.source_type, 'normal',
           d.id, d.created_at, d.updated_at
    FROM documents d;

  INSERT INTO resource_aliases(
    resource_id, alias_type, locator, evidence, first_observed_at, last_observed_at
  )
    SELECT r.id, 'legacy_source_uri', d.source_uri, d.source_type,
           d.created_at, d.updated_at
    FROM documents d JOIN resources r ON r.document_id = d.id;

  INSERT INTO provenance(
    resource_id, evidence_type, relation_id, raw_metadata, observed_at
  )
    SELECT r.id, 'legacy_relation', dl.id, dl.discovered_url, dl.created_at
    FROM document_links dl JOIN resources r ON r.document_id = dl.from_document_id;

  UPDATE meta SET value='3' WHERE key='schema_version';
`;

function nowIso(): string {
  return new Date().toISOString();
}

function pythonStyleTagJson(tags: string[]): string {
  return `[${tags.map((tag) => JSON.stringify(tag)).join(", ")}]`;
}

function titleFromSource(source: string): string {
  if (source.length === 0) return "Untitled";
  try {
    const url = new URL(source);
    const last = url.pathname.split("/").filter(Boolean).at(-1);
    return decodeURIComponent(last ?? url.hostname) || url.hostname;
  } catch {
    return source.split(/[\\/]/).at(-1) || source.slice(0, 80);
  }
}

function limitCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

/** Writable schema-v2 store. Read commands deliberately use ResearchCache instead. */
export class ResearchStore {
  readonly dbPath: string;
  readonly db: Database;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true, strict: true });
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    try {
      this.rejectUnsupportedExistingSchema();
      try {
        this.db.exec("PRAGMA journal_mode=WAL;");
      } catch {
        // WAL may be unavailable on unusual filesystems; transactions still work.
      }
      this.initializeSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  upsertDocument(input: UpsertDocumentInput): UpsertDocumentResult {
    const content = cleanText(input.content);
    if (content.length === 0) throw new Error("no extractable text content");
    const tags = normalizeTags(input.tags);
    const tagsJson = pythonStyleTagJson(tags);
    const hash = sha256Text(content);
    const sizeChars = codePointLength(content);
    const sourceType = (input.sourceType || "unknown").trim().toLowerCase();
    const sourceUri = String(input.sourceUri || "").trim();
    if (sourceUri.length === 0) throw new Error("source_uri is required");
    const title = limitCodePoints(
      (input.title || titleFromSource(sourceUri) || "Untitled").trim(),
      500,
    );
    const notes = input.notes ?? "";

    const transaction = this.db.transaction((): UpsertDocumentResult => {
      const existing = this.db
        .query(
          "SELECT id, title, tags, notes, content_hash FROM documents WHERE source_type=? AND source_uri=?",
        )
        .get(sourceType, sourceUri) as {
        id: number;
        title: string | null;
        tags: string;
        notes: string | null;
        content_hash: string;
      } | null;

      if (
        existing !== null &&
        existing.content_hash === hash &&
        existing.title === title &&
        existing.tags === tagsJson &&
        (existing.notes ?? "") === notes &&
        !input.force
      ) {
        return {
          success: true,
          status: "unchanged",
          document_id: existing.id,
          title,
          source_uri: sourceUri,
          size_chars: sizeChars,
          tags,
        };
      }

      const timestamp = nowIso();
      let documentId: number;
      let status: "created" | "updated";
      if (existing !== null) {
        documentId = existing.id;
        status = "updated";
        this.db
          .query(
            "DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id=?)",
          )
          .run(documentId);
        this.db.query("DELETE FROM chunks WHERE document_id=?").run(documentId);
        this.db
          .query(
            `UPDATE documents
             SET title=?, tags=?, notes=?, content=?, content_hash=?, size_chars=?, updated_at=?
             WHERE id=?`,
          )
          .run(
            title,
            tagsJson,
            notes,
            content,
            hash,
            sizeChars,
            timestamp,
            documentId,
          );
      } else {
        status = "created";
        const inserted = this.db
          .query(
            `INSERT INTO documents(
               source_type, source_uri, title, tags, notes, content, content_hash,
               size_chars, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            sourceType,
            sourceUri,
            title,
            tagsJson,
            notes,
            content,
            hash,
            sizeChars,
            timestamp,
            timestamp,
          );
        documentId = Number(inserted.lastInsertRowid);
      }

      const chunks = chunkText(content);
      for (const [index, chunk] of chunks.entries()) {
        const inserted = this.db
          .query(
            `INSERT INTO chunks(document_id, chunk_index, start_char, end_char, content)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(documentId, index, chunk.start, chunk.end, chunk.content);
        const chunkId = Number(inserted.lastInsertRowid);
        this.db
          .query(
            `INSERT INTO chunks_fts(
               rowid, document_id, chunk_id, title, content, tags, source_uri
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            chunkId,
            documentId,
            chunkId,
            title,
            chunk.content,
            tags.join(" "),
            sourceUri,
          );
      }

      return {
        success: true,
        status,
        document_id: documentId,
        title,
        source_uri: sourceUri,
        source_type: sourceType,
        size_chars: sizeChars,
        chunk_count: chunks.length,
        tags,
      };
    });
    return transaction.immediate();
  }

  upsertDocumentLink(input: {
    fromDocumentId: number;
    discoveredUrl: string;
    relationType?: string;
    toDocumentId?: number | null;
    resolvedUrl?: string | null;
    status?: "success" | "failed";
    error?: string | null;
  }): DocumentLinkResult {
    const parentId = Number(input.fromDocumentId);
    const targetId =
      input.toDocumentId === null || input.toDocumentId === undefined
        ? null
        : Number(input.toDocumentId);
    const discoveredUrl = String(input.discoveredUrl || "").trim();
    const relationType = (input.relationType || "content_link")
      .trim()
      .toLowerCase();
    const resolvedUrl = String(input.resolvedUrl || "").trim() || null;
    const status = input.status ?? (targetId === null ? "failed" : "success");
    let error = String(input.error || "").trim() || null;
    if (discoveredUrl.length === 0)
      throw new Error("discovered_url is required");
    if (relationType.length === 0) throw new Error("relation_type is required");
    if (status !== "success" && status !== "failed") {
      throw new Error("document link status must be 'success' or 'failed'");
    }
    if (status === "success" && targetId === null) {
      throw new Error("a successful document link requires to_document_id");
    }
    if (status === "failed" && targetId !== null) {
      throw new Error("a failed document link cannot have to_document_id");
    }
    if (status === "success") error = null;
    const timestamp = nowIso();

    const transaction = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO document_links(
             from_document_id, to_document_id, relation_type, discovered_url,
             resolved_url, status, error, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(from_document_id, relation_type, discovered_url) DO UPDATE SET
             to_document_id=excluded.to_document_id,
             resolved_url=excluded.resolved_url,
             status=excluded.status,
             error=excluded.error,
             updated_at=excluded.updated_at`,
        )
        .run(
          parentId,
          targetId,
          relationType,
          discoveredUrl,
          resolvedUrl,
          status,
          error,
          timestamp,
          timestamp,
        );
      return this.db
        .query(
          `SELECT * FROM document_links
           WHERE from_document_id=? AND relation_type=? AND discovered_url=?`,
        )
        .get(parentId, relationType, discoveredUrl) as Omit<
        DocumentLinkResult,
        "success"
      >;
    });
    return { success: true, ...transaction.immediate() };
  }

  deleteDocument(input: {
    documentId?: number;
    sourceUri?: string;
    confirm: string;
  }): {
    success: true;
    deleted_document_id: number;
    title: string | null;
    source_uri: string;
  } {
    if (input.confirm !== "delete") {
      throw new Error("set --confirm delete to delete from the research cache");
    }
    const selectorCount =
      Number(input.documentId !== undefined) +
      Number(input.sourceUri !== undefined);
    if (selectorCount !== 1) {
      throw new Error("provide exactly one of document_id or source_uri");
    }
    const transaction = this.db.transaction(() => {
      const row = (
        input.documentId !== undefined
          ? this.db
              .query("SELECT id, title, source_uri FROM documents WHERE id=?")
              .get(input.documentId)
          : this.db
              .query(
                `SELECT id, title, source_uri FROM documents
               WHERE source_uri=? ORDER BY updated_at DESC, id DESC LIMIT 1`,
              )
              .get(input.sourceUri as string)
      ) as {
        id: number;
        title: string | null;
        source_uri: string;
      } | null;
      if (row === null) throw new CliError("not_found", "document not found");
      this.db
        .query(
          "DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id=?)",
        )
        .run(row.id);
      this.db.query("DELETE FROM documents WHERE id=?").run(row.id);
      return {
        success: true as const,
        deleted_document_id: row.id,
        title: row.title,
        source_uri: row.source_uri,
      };
    });
    return transaction.immediate();
  }

  private rejectUnsupportedExistingSchema(): void {
    const hasMeta = this.db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='meta' LIMIT 1",
      )
      .get() as Row | null;
    if (hasMeta === null) return;
    const row = this.db
      .query("SELECT value FROM meta WHERE key='schema_version'")
      .get() as { value: string } | null;
    if (row === null) return;
    const version = Number(row.value);
    if (!Number.isInteger(version)) {
      throw new CliError(
        "bad_schema_version",
        "research cache schema_version is not an integer",
      );
    }
    if (version > RESEARCH_SCHEMA_VERSION) {
      throw new CliError(
        "unsupported_schema_version",
        `research cache schema version ${version} is newer than supported version ${RESEARCH_SCHEMA_VERSION}`,
      );
    }
  }

  private initializeSchema(): void {
    this.db
      .transaction(() => {
        this.db.exec(SCHEMA_V1);
        const row = this.db
          .query("SELECT value FROM meta WHERE key='schema_version'")
          .get() as { value: string } | null;
        const version = Number(row?.value ?? 1);
        if (!Number.isInteger(version)) {
          throw new CliError(
            "bad_schema_version",
            "research cache schema_version is not an integer",
          );
        }
        if (version > RESEARCH_SCHEMA_VERSION) {
          throw new CliError(
            "unsupported_schema_version",
            `research cache schema version ${version} is newer than supported version ${RESEARCH_SCHEMA_VERSION}`,
          );
        }
        if (version < 2) this.db.exec(MIGRATION_V2);
        if (version < 3) this.db.exec(MIGRATION_V3);
      })
      .immediate();
  }
}
