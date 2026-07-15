import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { CliError } from "./errors";
import {
  clampLimit,
  domainFromUri,
  nonNegativeOffset,
  normalizeSearchQuery,
  parseTags,
  truncateContent,
} from "./query";
import type {
  ChunkData,
  ContextData,
  DocumentData,
  SearchData,
  SearchMode,
  SearchResult,
  SourcesData,
  StatsData,
  TagsData,
} from "./types";

interface Row {
  [key: string]: unknown;
}

export class ResearchCache {
  readonly dbPath: string;
  readonly db: Database;
  private readonly tableExistsCache = new Map<string, boolean>();

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (!existsSync(dbPath)) {
      throw new CliError(
        "db_not_found",
        `research cache DB not found: ${dbPath}`,
        {
          hint: "Pass --db PATH or set AGENTBRAIN_DB.",
        },
      );
    }
    this.db = new Database(`file:${dbPath}?mode=ro`, {
      readonly: true,
      strict: true,
    });
    try {
      this.rejectUnsupportedSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  stats(options: { topTags: number; recent: number }): StatsData {
    const doc = this.one<{ count: number; total: number }>(
      "SELECT COUNT(*) AS count, COALESCE(SUM(size_chars), 0) AS total FROM documents",
    );
    const chunk = this.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM chunks",
    );
    const bySource = this.all<{ source_type: string; count: number }>(
      "SELECT source_type, COUNT(*) AS count FROM documents GROUP BY source_type ORDER BY count DESC, source_type ASC",
    );
    const topTags = this.all<{ tag: string; count: number }>(
      `SELECT j.value AS tag, COUNT(*) AS count
       FROM documents d, json_each(d.tags) AS j
       GROUP BY j.value
       ORDER BY count DESC, tag ASC
       LIMIT ?`,
      [options.topTags],
    );
    const recent = this.all<{
      document_id: number;
      title: string | null;
      source_uri: string;
      source_type: string;
      updated_at: string;
    }>(
      `SELECT id AS document_id, title, source_uri, source_type, updated_at
       FROM documents
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
      [options.recent],
    );
    const relationStats = this.tableExists("document_links")
      ? this.one<{ count: number; failed: number }>(
          `SELECT
             COUNT(*) AS count,
             COALESCE(SUM(CASE
               WHEN COALESCE(LOWER(status), '') = 'failed' OR COALESCE(error, '') <> '' THEN 1
               ELSE 0
             END), 0) AS failed
           FROM document_links`,
        )
      : { count: 0, failed: 0 };
    return {
      db_path: this.dbPath,
      db_size_bytes: statSync(this.dbPath).size,
      document_count: doc.count,
      chunk_count: chunk.count,
      total_chars: doc.total,
      relation_count: relationStats.count,
      failed_relation_count: relationStats.failed,
      by_source_type: bySource,
      top_tags: topTags,
      recent,
    };
  }

  search(input: {
    query: string;
    mode: SearchMode;
    limit?: number;
    offset?: number;
    tag?: string;
    sourceType?: string;
  }): SearchData {
    const limit = clampLimit(input.limit, 10, 50);
    const offset = nonNegativeOffset(input.offset);
    const normalized = normalizeSearchQuery(input.query, input.mode);
    const params: unknown[] = [normalized];
    const filters: string[] = [];
    if (input.tag !== undefined) {
      filters.push(
        "EXISTS (SELECT 1 FROM json_each(d.tags) jt WHERE jt.value = ?)",
      );
      params.push(input.tag);
    }
    if (input.sourceType !== undefined) {
      filters.push("d.source_type = ?");
      params.push(input.sourceType);
    }
    params.push(limit + 1, offset);
    const where = filters.length === 0 ? "" : ` AND ${filters.join(" AND ")}`;
    const rows = this.all<{
      document_id: number;
      chunk_id: number;
      chunk_index: number;
      title: string | null;
      source_uri: string;
      source_type: string;
      tags: string;
      updated_at: string;
      start_char: number;
      end_char: number;
      score: number;
      snippet: string;
    }>(
      `SELECT
         d.id AS document_id,
         c.id AS chunk_id,
         c.chunk_index AS chunk_index,
         d.title AS title,
         d.source_uri AS source_uri,
         d.source_type AS source_type,
         d.tags AS tags,
         d.updated_at AS updated_at,
         c.start_char AS start_char,
         c.end_char AS end_char,
         bm25(chunks_fts) AS score,
         snippet(chunks_fts, 3, '⟦', '⟧', ' … ', 48) AS snippet
       FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.chunk_id
       JOIN documents d ON d.id = chunks_fts.document_id
       WHERE chunks_fts MATCH ?${where}
       ORDER BY score ASC, d.updated_at DESC, c.id ASC
       LIMIT ? OFFSET ?`,
      params,
    );
    const page = rows.slice(0, limit);
    const results: SearchResult[] = page.map((row) => ({
      ...row,
      tags: parseTags(row.tags),
    }));
    return {
      query: input.query,
      normalized_query: normalized,
      mode: input.mode,
      limit,
      offset,
      filters: {
        ...(input.tag !== undefined ? { tag: input.tag } : {}),
        ...(input.sourceType !== undefined
          ? { source_type: input.sourceType }
          : {}),
      },
      results,
      next_offset: rows.length > limit ? offset + limit : null,
    };
  }

  context(input: {
    query: string;
    limit?: number;
    maxChars?: number;
  }): ContextData {
    const limit = clampLimit(input.limit, 6, 20);
    const maxChars = input.maxChars ?? 12_000;
    if (!Number.isInteger(maxChars) || maxChars < 500 || maxChars > 50_000) {
      throw new CliError(
        "bad_max_chars",
        "max-chars must be an integer between 500 and 50000",
        { exitCode: 2 },
      );
    }
    const search = this.search({
      query: input.query,
      mode: "any",
      limit,
      offset: 0,
    });
    let remaining = maxChars;
    let returnedChars = 0;
    let truncated = false;
    const hits = [];
    for (const result of search.results) {
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const row = this.one<{
        content: string;
      }>("SELECT content FROM chunks WHERE id=?", [result.chunk_id]);
      const points = Array.from(row.content);
      const selected = points.slice(0, remaining).join("");
      const wasTruncated = points.length > remaining;
      returnedChars += Math.min(points.length, remaining);
      remaining -= Math.min(points.length, remaining);
      truncated ||= wasTruncated;
      hits.push({
        document_id: result.document_id,
        chunk_id: result.chunk_id,
        chunk_index: result.chunk_index,
        title: result.title,
        source_uri: result.source_uri,
        source_type: result.source_type,
        tags: result.tags,
        start_char: result.start_char,
        end_char: result.end_char,
        score: result.score,
        citation: `[document_id:${result.document_id} chunk_id:${result.chunk_id}] ${result.title ?? "Untitled"} — ${result.source_uri}`,
        content: selected,
        truncated: wasTruncated,
      });
    }
    if (hits.length < search.results.length) truncated = true;
    return {
      query: input.query,
      limit,
      max_chars: maxChars,
      returned_chars: returnedChars,
      truncated,
      hits,
    };
  }

  getDocument(input: {
    documentId?: number;
    sourceUri?: string;
    charLimit: number | null;
  }): DocumentData {
    if (input.documentId === undefined && input.sourceUri === undefined) {
      throw new CliError(
        "missing_selector",
        "get requires --document-id or --source-uri",
        { exitCode: 2 },
      );
    }
    const row =
      input.documentId !== undefined
        ? this.oneOrNull<{
            id: number;
            title: string | null;
            source_uri: string;
            source_type: string;
            tags: string;
            notes: string | null;
            size_chars: number;
            content_hash: string;
            created_at: string;
            updated_at: string;
            content: string;
          }>("SELECT * FROM documents WHERE id = ?", [input.documentId])
        : this.oneOrNull<{
            id: number;
            title: string | null;
            source_uri: string;
            source_type: string;
            tags: string;
            notes: string | null;
            size_chars: number;
            content_hash: string;
            created_at: string;
            updated_at: string;
            content: string;
          }>(
            "SELECT * FROM documents WHERE source_uri = ? ORDER BY updated_at DESC LIMIT 1",
            [input.sourceUri],
          );
    if (row === null) throw new CliError("not_found", "document not found");
    const truncated = truncateContent(row.content, input.charLimit);
    const documentId = row.id;
    return {
      document_id: documentId,
      title: row.title,
      source_uri: row.source_uri,
      source_type: row.source_type,
      tags: parseTags(row.tags),
      notes: row.notes,
      size_chars: row.size_chars,
      content_hash: row.content_hash,
      created_at: row.created_at,
      updated_at: row.updated_at,
      content: truncated.content,
      outbound_links: this.documentLinks("from_document_id", documentId),
      inbound_links: this.documentLinks("to_document_id", documentId),
      truncation: {
        requested_char_limit: input.charLimit,
        returned_chars: truncated.content.length,
        omitted_chars: truncated.omitted,
      },
    };
  }

  getChunk(chunkId: number): ChunkData {
    const row = this.oneOrNull<{
      chunk_id: number;
      document_id: number;
      chunk_index: number;
      start_char: number;
      end_char: number;
      content: string;
      title: string | null;
      source_uri: string;
      source_type: string;
      tags: string;
    }>(
      `SELECT c.id AS chunk_id, c.document_id, c.chunk_index, c.start_char, c.end_char, c.content,
              d.title, d.source_uri, d.source_type, d.tags
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.id = ?`,
      [chunkId],
    );
    if (row === null) throw new CliError("not_found", "chunk not found");
    return { ...row, tags: parseTags(row.tags) };
  }

  tags(limitInput?: number): TagsData {
    const limit = clampLimit(limitInput, 100, 500);
    return {
      tags: this.all<{ tag: string; count: number }>(
        `SELECT j.value AS tag, COUNT(*) AS count
         FROM documents d, json_each(d.tags) AS j
         GROUP BY j.value
         ORDER BY count DESC, tag ASC
         LIMIT ?`,
        [limit],
      ),
    };
  }

  sources(limitInput?: number): SourcesData {
    const limit = clampLimit(limitInput, 100, 500);
    const sourceTypes = this.all<{ source_type: string; count: number }>(
      "SELECT source_type, COUNT(*) AS count FROM documents GROUP BY source_type ORDER BY count DESC, source_type ASC",
    );
    const uris = this.all<{ source_uri: string }>(
      "SELECT source_uri FROM documents",
    );
    const counts = new Map<string, number>();
    for (const row of uris) {
      const domain = domainFromUri(row.source_uri) ?? "local/other";
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
    return {
      source_types: sourceTypes,
      domains: Array.from(counts.entries())
        .map(([domain, count]) => ({ domain, count }))
        .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
        .slice(0, limit),
    };
  }

  private documentLinks(
    direction: "from_document_id" | "to_document_id",
    documentId: number,
  ): Array<{
    id: number;
    from_document_id: number;
    to_document_id: number | null;
    relation_type: string;
    discovered_url: string | null;
    resolved_url: string | null;
    status: string;
    error: string | null;
    created_at: string;
    updated_at: string;
  }> {
    if (!this.tableExists("document_links")) return [];
    return this.all<{
      id: number;
      from_document_id: number;
      to_document_id: number | null;
      relation_type: string;
      discovered_url: string | null;
      resolved_url: string | null;
      status: string;
      error: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT
         id,
         from_document_id,
         to_document_id,
         relation_type,
         discovered_url,
         resolved_url,
         status,
         error,
         created_at,
         updated_at
       FROM document_links
       WHERE ${direction} = ?
       ORDER BY id ASC`,
      [documentId],
    );
  }

  private rejectUnsupportedSchema(): void {
    if (!this.tableExists("meta")) return;
    const row = this.oneOrNull<{ value: string }>(
      "SELECT value FROM meta WHERE key='schema_version'",
    );
    if (row === null) return;
    const version = Number(row.value);
    if (!Number.isInteger(version)) {
      throw new CliError(
        "bad_schema_version",
        "research cache schema_version is not an integer",
      );
    }
    if (version > 2) {
      throw new CliError(
        "unsupported_schema_version",
        `research cache schema version ${version} is newer than supported version 2`,
      );
    }
  }

  private tableExists(name: string): boolean {
    const cached = this.tableExistsCache.get(name);
    if (cached !== undefined) return cached;
    const exists =
      this.oneOrNull<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        [name],
      ) !== null;
    this.tableExistsCache.set(name, exists);
    return exists;
  }

  private all<T extends Row>(sql: string, params: unknown[] = []): T[] {
    return this.db.query(sql).all(...(params as never[])) as T[];
  }

  private one<T extends Row>(sql: string, params: unknown[] = []): T {
    return this.db.query(sql).get(...(params as never[])) as T;
  }

  private oneOrNull<T extends Row>(
    sql: string,
    params: unknown[] = [],
  ): T | null {
    return (this.db.query(sql).get(...(params as never[])) as T | null) ?? null;
  }
}
