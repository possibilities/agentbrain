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

/**
 * Durable ingestion domain records (schema v3). Sensitivity is an inherited
 * handling policy drawn from a closed, ranked vocabulary, never a free tag.
 */
export type Sensitivity = "public" | "normal" | "sensitive" | "private";

export interface Resource {
  id: number;
  key_type: string;
  key_value: string;
  kind: string;
  sensitivity: Sensitivity;
  document_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface ResourceAlias {
  id: number;
  resource_id: number;
  alias_type: string;
  locator: string;
  evidence: string | null;
  first_observed_at: string;
  last_observed_at: string;
}

export interface ResourceRecord extends Resource {
  aliases: ResourceAlias[];
}

export interface Artifact {
  id: number;
  content_hash: string;
  media_type: string;
  byte_size: number;
  artifact_role: string;
  sensitivity: Sensitivity;
  storage_path: string | null;
  created_at: string;
}

export interface Source {
  id: number;
  source_type: string;
  identifier: string;
  display_name: string | null;
  enabled: boolean;
  sensitivity: Sensitivity;
  schedule: string | null;
  checkpoint: string | null;
  created_at: string;
  updated_at: string;
}

export interface Collection {
  id: number;
  slug: string;
  title: string;
  sensitivity: Sensitivity;
  created_at: string;
  updated_at: string;
}

export interface CollectionMembership {
  id: number;
  collection_id: number;
  resource_id: number;
  position: number | null;
  external_ref: string | null;
  added_at: string;
}

export interface Observation {
  id: number;
  resource_id: number;
  source_id: number | null;
  run_id: number | null;
  ingress: string;
  observed_locator: string | null;
  suppressed: boolean;
  suppressed_reason: string | null;
  observed_at: string;
}

export interface Run {
  id: number;
  run_type: string;
  source_id: number | null;
  state: string;
  checkpoint: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Provenance {
  id: number;
  resource_id: number;
  evidence_type: string;
  source_id: number | null;
  run_id: number | null;
  artifact_id: number | null;
  relation_id: number | null;
  ingress: string | null;
  raw_metadata: string | null;
  observed_at: string;
}

/**
 * Durable ingestion job lifecycle (schema v4). A job is one immutable intent;
 * every leased execution appends an immutable attempt; state changes append an
 * audited transition. See ADR 0004.
 */
export type JobState =
  | "queued"
  | "running"
  | "retry_wait"
  | "blocked"
  | "failed"
  | "completed"
  | "excluded"
  | "cancelled";

export type AttemptState =
  | "leased"
  | "succeeded"
  | "failed"
  | "stale"
  | "cancelled";

/**
 * How an attempt failed, which decides routing: infrastructure is retried
 * indefinitely, item-specific transient failure has a bounded budget before it
 * blocks, permanent failure stops, and auth/config failure blocks.
 */
export type FailureClass =
  | "infra"
  | "item_transient"
  | "permanent"
  | "auth_config";

export interface Job {
  id: number;
  idempotency_key: string;
  kind: string;
  intent: string | null;
  resource_id: number | null;
  source_id: number | null;
  run_id: number | null;
  state: JobState;
  sensitivity: Sensitivity;
  attempt_count: number;
  item_retry_count: number;
  current_attempt_id: number | null;
  run_at: string;
  block_reason: string | null;
  failure_class: FailureClass | null;
  failure_summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface Attempt {
  id: number;
  job_id: number;
  attempt_number: number;
  worker: string;
  state: AttemptState;
  lease_expires_at: string;
  heartbeat_at: string;
  failure_class: FailureClass | null;
  failure_summary: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface JobTransition {
  id: number;
  job_id: number;
  attempt_id: number | null;
  from_state: JobState | null;
  to_state: JobState;
  actor: string;
  reason: string | null;
  detail: string | null;
  created_at: string;
}

export interface JobRecord extends Job {
  attempts: Attempt[];
  transitions: JobTransition[];
}

/**
 * Retry and lease durations are policy, not identity: defaults are configurable
 * and testable without changing persisted job semantics or idempotency keys.
 */
export interface LifecyclePolicy {
  leaseMs: number;
  maxItemRetries: number;
  infraBaseMs: number;
  infraCapMs: number;
  itemBaseMs: number;
  itemCapMs: number;
  jitterRatio: number;
}

/** Outcome of a fenced heartbeat/completion/failure that lost its claim. */
export interface FencedResult {
  ok: false;
  reason: "stale" | "fenced" | "terminal";
  job: Job;
}

export type ClaimResult =
  | { claimed: false }
  | { claimed: true; job: Job; attempt: Attempt; fencing_token: number };

export type HeartbeatResult =
  | { ok: true; job: Job; attempt: Attempt }
  | FencedResult;

export type CompleteResult =
  | { ok: true; idempotent: boolean; job: Job }
  | FencedResult;

export type FailResult =
  | { ok: true; job: Job; attempt: Attempt; disposition: JobState }
  | FencedResult;

export type CancelResult =
  | { ok: true; job: Job }
  | { ok: false; reason: "already_completed"; job: Job };

export interface RecoveredLease {
  job_id: number;
  attempt_id: number;
  disposition: JobState;
}
