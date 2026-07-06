import { formatList } from "./format";
import type {
  ChunkData,
  DocumentData,
  SearchData,
  SourcesData,
  StatsData,
  TagsData,
} from "./types";

export function humanStats(data: StatsData): string {
  return [
    `DB: ${data.db_path}`,
    `Documents: ${data.document_count}`,
    `Chunks: ${data.chunk_count}`,
    `Characters: ${data.total_chars}`,
    `DB bytes: ${data.db_size_bytes}`,
    "",
    "By source type:",
    formatList(data.by_source_type, ["source_type", "count"]).trimEnd(),
    "",
    "Top tags:",
    formatList(data.top_tags, ["tag", "count"]).trimEnd(),
    "",
    "Recent:",
    formatList(
      data.recent.map((r) => ({
        id: r.document_id,
        type: r.source_type,
        updated: r.updated_at,
        title: r.title ?? "",
        uri: r.source_uri,
      })),
      ["id", "type", "updated", "title", "uri"],
    ).trimEnd(),
    "",
  ].join("\n");
}

export function humanSearch(data: SearchData): string {
  const lines = [
    `Query: ${data.query}`,
    `Mode: ${data.mode}`,
    `Normalized: ${data.normalized_query}`,
    `Results: ${data.results.length}`,
    "",
  ];
  for (const [i, result] of data.results.entries()) {
    lines.push(
      `${data.offset + i + 1}. document_id=${result.document_id} chunk_id=${result.chunk_id} score=${result.score}`,
    );
    lines.push(`   title: ${result.title ?? "(untitled)"}`);
    lines.push(`   source: ${result.source_uri}`);
    lines.push(
      `   type/tags: ${result.source_type} / ${result.tags.join(", ")}`,
    );
    lines.push(`   snippet: ${result.snippet.replaceAll("\n", " ")}`);
    lines.push("");
  }
  if (data.next_offset !== null)
    lines.push(`Next page: --offset ${data.next_offset}\n`);
  return lines.join("\n");
}

export function searchJsonl(data: SearchData): unknown[] {
  return [
    {
      record_type: "meta",
      query: data.query,
      normalized_query: data.normalized_query,
      mode: data.mode,
      limit: data.limit,
      offset: data.offset,
      filters: data.filters,
      next_offset: data.next_offset,
    },
    ...data.results.map((result) => ({ record_type: "result", ...result })),
  ];
}

export function humanDocument(data: DocumentData): string {
  return [
    `document_id: ${data.document_id}`,
    `title: ${data.title ?? "(untitled)"}`,
    `source_uri: ${data.source_uri}`,
    `source_type: ${data.source_type}`,
    `tags: ${data.tags.join(", ")}`,
    `updated_at: ${data.updated_at}`,
    `chars: ${data.truncation.returned_chars}/${data.size_chars}${data.truncation.omitted_chars > 0 ? ` (${data.truncation.omitted_chars} omitted)` : ""}`,
    "",
    data.content,
    "",
  ].join("\n");
}

export function humanChunk(data: ChunkData): string {
  return [
    `chunk_id: ${data.chunk_id}`,
    `document_id: ${data.document_id}`,
    `chunk_index: ${data.chunk_index}`,
    `title: ${data.title ?? "(untitled)"}`,
    `source_uri: ${data.source_uri}`,
    `source_type: ${data.source_type}`,
    `tags: ${data.tags.join(", ")}`,
    `span: ${data.start_char}-${data.end_char}`,
    "",
    data.content,
    "",
  ].join("\n");
}

export function humanTags(data: TagsData): string {
  return formatList(data.tags, ["tag", "count"]);
}

export function humanSources(data: SourcesData): string {
  return [
    "Source types:",
    formatList(data.source_types, ["source_type", "count"]).trimEnd(),
    "",
    "Domains:",
    formatList(data.domains, ["domain", "count"]).trimEnd(),
    "",
  ].join("\n");
}
