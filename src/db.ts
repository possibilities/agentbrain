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
    return {
      db_path: this.dbPath,
      db_size_bytes: statSync(this.dbPath).size,
      document_count: doc.count,
      chunk_count: chunk.count,
      total_chars: doc.total,
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
    return {
      document_id: row.id,
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
