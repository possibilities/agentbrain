import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ArtifactStore,
  defaultArtifactRoot,
  isSafeArtifactStoragePath,
} from "./artifacts";
import { ResearchCache } from "./db";
import { CliError } from "./errors";
import { findExecutable } from "./executable";
import { RESEARCH_SCHEMA_VERSION, type ResearchStore } from "./store";
import type { Attempt, Job, JobRecord, JobState, JobTransition } from "./types";

const JOB_STATES: readonly JobState[] = [
  "queued",
  "running",
  "retry_wait",
  "blocked",
  "failed",
  "completed",
  "excluded",
  "cancelled",
];

export interface SafeJob {
  id: number;
  kind: string;
  state: JobState;
  sensitivity: string;
  resource_id: number | null;
  source_id: number | null;
  run_id: number | null;
  attempt_count: number;
  item_retry_count: number;
  run_at: string;
  failure_class: string | null;
  created_at: string;
  updated_at: string;
}

export interface SafeJobRecord extends SafeJob {
  attempts: Array<Omit<Attempt, "worker" | "failure_summary">>;
  transitions: Array<Omit<JobTransition, "actor" | "detail" | "reason">>;
}

export interface RevealedArtifact {
  content_digest: string;
  media_type: string;
  byte_size: number;
  body: string;
}

export interface RevealedJob extends SafeJobRecord {
  intent: unknown;
  artifacts: RevealedArtifact[];
}

export interface JobStats {
  total: number;
  by_state: Record<JobState, number>;
  runnable_due: number;
  active_leases: number;
  stale_leases: number;
  oldest_runnable_at: string | null;
}

export interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "failed";
  detail: string;
}

export interface DoctorReport {
  healthy: boolean;
  checks: DoctorCheck[];
}

export function safeJobView(job: Job): SafeJob {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    sensitivity: job.sensitivity,
    resource_id: job.resource_id,
    source_id: job.source_id,
    run_id: job.run_id,
    attempt_count: job.attempt_count,
    item_retry_count: job.item_retry_count,
    run_at: job.run_at,
    failure_class: job.failure_class,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

function safeRecord(record: JobRecord): SafeJobRecord {
  return {
    ...safeJobView(record),
    attempts: record.attempts.map(
      ({ worker: _worker, failure_summary: _summary, ...attempt }) => attempt,
    ),
    transitions: record.transitions.map(
      ({ actor: _actor, detail: _detail, reason: _reason, ...transition }) =>
        transition,
    ),
  };
}

export function parseJobState(value: string | undefined): JobState | undefined {
  if (value === undefined) return undefined;
  if (JOB_STATES.includes(value as JobState)) return value as JobState;
  throw new CliError("bad_job_state", `unknown job state '${value}'`, {
    exitCode: 2,
    hint: `Use one of: ${JOB_STATES.join(", ")}.`,
  });
}

export function listJobs(
  cache: ResearchCache,
  options: { state?: JobState; limit?: number } = {},
): SafeJob[] {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new CliError(
      "bad_limit",
      "--limit must be an integer from 1 to 1000",
      {
        exitCode: 2,
      },
    );
  }
  return cache.jobs({ state: options.state }).slice(0, limit).map(safeJobView);
}

export function showJob(cache: ResearchCache, jobId: number): SafeJobRecord {
  const record = cache.job(jobId);
  if (record === null)
    throw new CliError("job_not_found", `job ${jobId} not found`);
  return safeRecord(record);
}

function artifactDescriptors(intent: unknown): Array<{
  content_digest: string;
  media_type: string;
  byte_size: number;
}> {
  if (intent === null || typeof intent !== "object") return [];
  const payload = (intent as { payload?: unknown }).payload;
  if (payload === null || typeof payload !== "object") return [];
  const value = payload as Record<string, unknown>;
  const candidates: unknown[] = [];
  if (value.text !== undefined) candidates.push(value.text);
  if (value.file !== undefined) candidates.push(value.file);
  const directory = value.directory as { artifacts?: unknown[] } | undefined;
  if (Array.isArray(directory?.artifacts))
    candidates.push(...directory.artifacts);
  return candidates.flatMap((candidate) => {
    if (candidate === null || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    if (
      typeof item.content_digest !== "string" ||
      typeof item.media_type !== "string" ||
      typeof item.byte_size !== "number"
    )
      return [];
    return [
      {
        content_digest: item.content_digest,
        media_type: item.media_type,
        byte_size: item.byte_size,
      },
    ];
  });
}

export function revealJob(
  store: ResearchStore,
  jobId: number,
  options: {
    artifactStore?: ArtifactStore;
    actor?: string;
    maxBytes?: number;
  } = {},
): RevealedJob {
  const row = store.db
    .query("SELECT intent FROM jobs WHERE id=?")
    .get(jobId) as {
    intent: string | null;
  } | null;
  if (row === null)
    throw new CliError("job_not_found", `job ${jobId} not found`);
  let intent: unknown = null;
  if (row.intent !== null) {
    try {
      intent = JSON.parse(row.intent);
    } catch {
      throw new CliError(
        "invalid_intent",
        `job ${jobId} has an invalid durable intent`,
      );
    }
  }
  const artifacts = options.artifactStore ?? new ArtifactStore();
  const bodies = artifactDescriptors(intent).map((artifact) => ({
    ...artifact,
    body: artifacts.readUtf8(artifact.content_digest, options.maxBytes),
  }));
  store.recordSensitiveInspection({
    jobId,
    actor: options.actor ?? "operator",
    detail: `revealed ${bodies.length} Artifact bodies`,
  });
  const cache = new ResearchCache(store.dbPath);
  try {
    return { ...showJob(cache, jobId), intent, artifacts: bodies };
  } finally {
    cache.close();
  }
}

function tableExists(cache: ResearchCache, name: string): boolean {
  return (
    cache.db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
      )
      .get(name) !== null
  );
}

export function jobStats(cache: ResearchCache, now = new Date()): JobStats {
  const rows = cache.jobs();
  const byState = Object.fromEntries(
    JOB_STATES.map((state) => [state, 0]),
  ) as Record<JobState, number>;
  for (const row of rows) byState[row.state] += 1;
  const due = rows.filter(
    (row) =>
      (row.state === "queued" || row.state === "retry_wait") &&
      Date.parse(row.run_at) <= now.getTime(),
  );
  const leases = tableExists(cache, "attempts")
    ? (cache.db
        .query("SELECT lease_expires_at FROM attempts WHERE state='leased'")
        .all() as Array<{ lease_expires_at: string }>)
    : [];
  return {
    total: rows.length,
    by_state: byState,
    runnable_due: due.length,
    active_leases: leases.length,
    stale_leases: leases.filter(
      (lease) => Date.parse(lease.lease_expires_at) <= now.getTime(),
    ).length,
    oldest_runnable_at: due.map((row) => row.run_at).sort()[0] ?? null,
  };
}

export function doctor(cache: ResearchCache, now = new Date()): DoctorReport {
  const checks: DoctorCheck[] = [];
  try {
    const quick = cache.db.query("PRAGMA quick_check").get() as {
      quick_check: string;
    };
    checks.push({
      name: "database_integrity",
      status: quick.quick_check === "ok" ? "ok" : "failed",
      detail:
        quick.quick_check === "ok"
          ? "SQLite quick check passed"
          : "SQLite quick check reported defects",
    });
  } catch {
    checks.push({
      name: "database_integrity",
      status: "failed",
      detail: "SQLite quick check failed",
    });
  }

  const schema = tableExists(cache, "meta")
    ? (cache.db
        .query("SELECT value FROM meta WHERE key='schema_version'")
        .get() as { value: string } | null)
    : null;
  const schemaVersion = Number(schema?.value);
  checks.push({
    name: "schema_version",
    status: schemaVersion === RESEARCH_SCHEMA_VERSION ? "ok" : "failed",
    detail:
      schemaVersion === RESEARCH_SCHEMA_VERSION
        ? `Schema version ${RESEARCH_SCHEMA_VERSION}`
        : "Schema is not at the supported version",
  });

  const artifacts = tableExists(cache, "artifacts")
    ? (cache.db
        .query("SELECT content_hash, storage_path FROM artifacts ORDER BY id")
        .all() as Array<{
        content_hash: string;
        storage_path: string | null;
      }>)
    : [];
  const root = defaultArtifactRoot();
  let missing = 0;
  let invalid = 0;
  for (const artifact of artifacts) {
    try {
      if (
        artifact.storage_path === null ||
        !isSafeArtifactStoragePath(artifact.storage_path, artifact.content_hash)
      ) {
        invalid += 1;
        continue;
      }
    } catch {
      invalid += 1;
      continue;
    }
    if (!existsSync(join(root, artifact.storage_path))) missing += 1;
  }
  checks.push({
    name: "artifact_references",
    status: missing === 0 && invalid === 0 ? "ok" : "failed",
    detail:
      missing === 0 && invalid === 0
        ? `${artifacts.length} Artifact references present`
        : `${missing} missing and ${invalid} invalid Artifact references`,
  });

  const stats = jobStats(cache, now);
  checks.push({
    name: "leases",
    status: stats.stale_leases === 0 ? "ok" : "warning",
    detail: `${stats.active_leases} active, ${stats.stale_leases} expired`,
  });
  const scrapectl = findExecutable("scrapectl");
  checks.push({
    name: "scrapectl",
    status: scrapectl === null ? "failed" : "ok",
    detail:
      scrapectl === null
        ? "Scrapectl executable not found"
        : "Scrapectl executable found",
  });
  return {
    healthy: checks.every((check) => check.status !== "failed"),
    checks,
  };
}
