export const SCHEMA_VERSION = 1;

export type OutputFormat = "human" | "json" | "jsonl";
export type SearchMode = "any" | "all" | "raw";

export interface GlobalOptions {
  dbPath: string;
  format: OutputFormat;
  quiet: boolean;
}

export interface Envelope<T> {
  schema_version: typeof SCHEMA_VERSION;
  ok: true;
  command: string;
  data: T;
  meta: {
    db_path: string;
    read_only: boolean;
    generated_at: string;
  };
}

export interface ErrorEnvelope {
  schema_version: typeof SCHEMA_VERSION;
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
    hint?: string;
  };
}

export interface RelationStats {
  relation_count: number;
  failed_relation_count: number;
}

export interface StatsData extends RelationStats {
  db_path: string;
  db_size_bytes: number;
  document_count: number;
  chunk_count: number;
  total_chars: number;
  by_source_type: Array<{ source_type: string; count: number }>;
  top_tags: Array<{ tag: string; count: number }>;
  recent: Array<{
    document_id: number;
    title: string | null;
    source_uri: string;
    source_type: string;
    updated_at: string;
  }>;
}

export interface SearchResult {
  document_id: number;
  chunk_id: number;
  chunk_index: number;
  title: string | null;
  source_uri: string;
  source_type: string;
  tags: string[];
  updated_at: string;
  start_char: number;
  end_char: number;
  score: number;
  snippet: string;
}

export interface SearchData {
  query: string;
  normalized_query: string;
  mode: SearchMode;
  limit: number;
  offset: number;
  filters: {
    tag?: string;
    source_type?: string;
  };
  results: SearchResult[];
  next_offset: number | null;
}

export interface ContextHit {
  document_id: number;
  chunk_id: number;
  chunk_index: number;
  title: string | null;
  source_uri: string;
  source_type: string;
  tags: string[];
  start_char: number;
  end_char: number;
  score: number;
  citation: string;
  content: string;
  truncated: boolean;
}

export interface ContextData {
  query: string;
  limit: number;
  max_chars: number;
  returned_chars: number;
  truncated: boolean;
  hits: ContextHit[];
}

export interface DocumentLink {
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
}

export interface DocumentData {
  document_id: number;
  title: string | null;
  source_uri: string;
  source_type: string;
  tags: string[];
  notes: string | null;
  size_chars: number;
  content_hash: string;
  created_at: string;
  updated_at: string;
  content: string;
  outbound_links: DocumentLink[];
  inbound_links: DocumentLink[];
  truncation: {
    requested_char_limit: number | null;
    returned_chars: number;
    omitted_chars: number;
  };
}

export interface ChunkData {
  chunk_id: number;
  document_id: number;
  chunk_index: number;
  start_char: number;
  end_char: number;
  title: string | null;
  source_uri: string;
  source_type: string;
  tags: string[];
  content: string;
}

export interface TagsData {
  tags: Array<{ tag: string; count: number }>;
}

export interface SourcesData {
  source_types: Array<{ source_type: string; count: number }>;
  domains: Array<{ domain: string; count: number }>;
}
