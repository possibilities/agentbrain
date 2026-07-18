import { createHash } from "node:crypto";
import { lstatSync, opendirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { ArtifactStore, type StoredArtifact } from "./artifacts";
import { CliError } from "./errors";
import { DEFAULT_EXTENSIONS, looksSensitiveComponent } from "./extract";
import {
  DIRECTORY_CANDIDATE_LIMIT,
  DIRECTORY_TRAVERSAL_LIMIT,
  type IngestSourceType,
  SKIP_DIRS,
} from "./ingest";
import type { ResearchStore } from "./store";
import { normalizeTags } from "./text";
import type { AdmissionStatus, AdmissionWaitStatus, JobState } from "./types";
import { normalizedWebUrl } from "./url";

export const SUBMISSION_VERSION = 1 as const;
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

export type SubmissionKind = Exclude<IngestSourceType, "auto">;

export interface SubmissionIntent {
  version: typeof SUBMISSION_VERSION;
  source: string;
  kind?: IngestSourceType;
  ingress: string;
  collections?: string[];
  idempotencyKey?: string;
  title?: string;
  tags?: unknown;
  notes?: string;
  recursive?: boolean;
  maxFiles?: number;
  maxBytes?: number;
  force?: boolean;
  skipSecrets?: boolean;
}

interface ArtifactPayload {
  content_digest: string;
  byte_size: number;
  media_type: string;
  artifact_role: "original";
}

export interface DurableSubmissionIntent {
  version: typeof SUBMISSION_VERSION;
  kind: SubmissionKind;
  ingress: string;
  collections: string[];
  payload:
    | { text: ArtifactPayload }
    | { file: ArtifactPayload }
    | {
        directory: {
          artifacts: ArtifactPayload[];
          recursive: boolean;
          truncated: boolean;
        };
      }
    | { url: { url: string } };
  options: {
    title?: string;
    tags: string[];
    notes?: string;
    force: boolean;
    max_bytes: number;
  };
}

export interface AdmissionResult {
  version: typeof SUBMISSION_VERSION;
  status: AdmissionStatus;
  job_id: number;
  idempotency_key: string;
  intent_hash: string;
  state: JobState;
  wait_status?: AdmissionWaitStatus;
}

export interface AdmissionOptions {
  artifactStore?: ArtifactStore;
}

interface PreparedSubmission {
  kind: SubmissionKind;
  ingress: string;
  collections: string[];
  source: string;
  localPaths: string[];
  recursive: boolean;
  truncated: boolean;
  maxBytes: number;
  title?: string;
  tags: string[];
  notes?: string;
  force: boolean;
}

const MEDIA_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".epub": "application/epub+zip",
};

const TERMINAL_JOB_STATES = new Set<JobState>([
  "blocked",
  "failed",
  "completed",
  "excluded",
  "cancelled",
]);

function admissionError(code: string, message: string): CliError {
  return new CliError(code, message, { exitCode: 2 });
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw admissionError("bad_intent", `${name} must be a positive integer`);
  }
  return resolved;
}

function optionalText(
  value: string | undefined,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (!text) throw admissionError("bad_intent", `${name} must not be empty`);
  if (Array.from(text).length > 5000) {
    throw admissionError("bad_intent", `${name} is too long`);
  }
  return text;
}

function normalizedName(value: string, name: string): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(normalized)) {
    throw admissionError(
      "bad_intent",
      `${name} must use 1-100 lowercase letters, numbers, dots, underscores, or hyphens`,
    );
  }
  return normalized;
}

function detectedKind(source: string): SubmissionKind {
  try {
    const url = new URL(source);
    if (url.protocol === "http:" || url.protocol === "https:") return "url";
  } catch {}
  try {
    const stat = statSync(source);
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
  } catch {}
  return "text";
}

function sensitivePath(path: string): boolean {
  return realpathSync(path).split(/[\\/]/).some(looksSensitiveComponent);
}

function discoverDirectory(
  root: string,
  recursive: boolean,
  skipSecrets: boolean,
  maxFiles: number,
): { paths: string[]; truncated: boolean } {
  const paths: string[] = [];
  let entries = 0;
  let candidates = 0;
  let truncated = false;

  const visit = (directory: string): void => {
    if (truncated) return;
    const handle = opendirSync(directory);
    try {
      while (!truncated) {
        const entry = handle.readSync();
        if (entry === null) break;
        if (entries >= DIRECTORY_TRAVERSAL_LIMIT) {
          truncated = true;
          break;
        }
        entries += 1;
        if (skipSecrets && looksSensitiveComponent(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (recursive && !SKIP_DIRS.has(entry.name)) visit(path);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!DEFAULT_EXTENSIONS.has(extname(entry.name).toLowerCase()))
          continue;
        if (
          candidates >= DIRECTORY_CANDIDATE_LIMIT ||
          paths.length >= maxFiles
        ) {
          truncated = true;
          break;
        }
        candidates += 1;
        paths.push(path);
      }
    } finally {
      handle.closeSync();
    }
  };

  visit(root);
  paths.sort();
  return { paths, truncated };
}

function prepareSubmission(input: SubmissionIntent): PreparedSubmission {
  if (input.version !== SUBMISSION_VERSION) {
    throw admissionError(
      "unsupported_submission_version",
      `submission version must be ${SUBMISSION_VERSION}`,
    );
  }
  const source = String(input.source ?? "").trim();
  if (!source) throw admissionError("bad_intent", "source is required");
  const requestedKind = String(input.kind ?? "auto")
    .trim()
    .toLowerCase();
  if (!["auto", "url", "file", "directory", "text"].includes(requestedKind)) {
    throw admissionError(
      "bad_intent",
      `unknown submission kind '${requestedKind}'`,
    );
  }
  const kind =
    requestedKind === "auto"
      ? detectedKind(source)
      : (requestedKind as SubmissionKind);
  const ingress = normalizedName(input.ingress, "ingress");
  const collections = [
    ...new Set(
      (input.collections ?? []).map((value) =>
        normalizedName(value, "collection"),
      ),
    ),
  ].sort();
  const maxBytes = positiveInteger(input.maxBytes, 5_000_000, "max_bytes");
  const recursive = input.recursive !== false;
  const maxFiles = Math.min(
    positiveInteger(input.maxFiles, 300, "max_files"),
    5000,
  );
  const skipSecrets = input.skipSecrets !== false;
  const title = optionalText(input.title, "title");
  const notes = optionalText(input.notes, "notes");
  const tags = [...new Set(normalizeTags(input.tags))].sort();
  let normalizedSource = source;
  let localPaths: string[] = [];
  let truncated = false;

  if (kind === "url") {
    try {
      normalizedSource = normalizedWebUrl(source);
    } catch (error) {
      throw admissionError(
        "bad_intent",
        error instanceof Error ? error.message : String(error),
      );
    }
  } else if (kind === "file") {
    try {
      if (lstatSync(source).isSymbolicLink() || !statSync(source).isFile()) {
        throw new Error("not a regular file");
      }
      if (skipSecrets && sensitivePath(source)) {
        throw new Error(`refusing likely secret file: ${basename(source)}`);
      }
      if (statSync(source).size > maxBytes)
        throw new Error("file exceeds max_bytes");
      localPaths = [realpathSync(source)];
    } catch (error) {
      throw admissionError(
        "bad_intent",
        error instanceof Error ? error.message : String(error),
      );
    }
  } else if (kind === "directory") {
    try {
      const root = realpathSync(source);
      if (!statSync(root).isDirectory()) throw new Error("not a directory");
      if (skipSecrets && sensitivePath(root)) {
        throw new Error(`refusing likely secret directory: ${basename(root)}`);
      }
      const discovered = discoverDirectory(
        root,
        recursive,
        skipSecrets,
        maxFiles,
      );
      for (const path of discovered.paths) {
        if (statSync(path).size > maxBytes) {
          throw new Error(
            `directory file exceeds max_bytes: ${basename(path)}`,
          );
        }
      }
      localPaths = discovered.paths;
      truncated = discovered.truncated;
    } catch (error) {
      throw admissionError(
        "bad_intent",
        error instanceof Error ? error.message : String(error),
      );
    }
  } else {
    const bytes = new TextEncoder().encode(source).byteLength;
    if (bytes > maxBytes)
      throw admissionError("bad_intent", "text exceeds max_bytes");
  }

  const idempotencyKey = input.idempotencyKey?.trim();
  if (input.idempotencyKey !== undefined && !idempotencyKey) {
    throw admissionError(
      "bad_idempotency_key",
      "idempotency_key must not be empty",
    );
  }
  if (idempotencyKey !== undefined && idempotencyKey.length > 500) {
    throw admissionError("bad_idempotency_key", "idempotency_key is too long");
  }

  return {
    kind,
    ingress,
    collections,
    source: normalizedSource,
    localPaths,
    recursive,
    truncated,
    maxBytes,
    title,
    tags,
    notes,
    force: input.force === true,
  };
}

function mediaType(path: string): string {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function artifactPayload(
  stored: StoredArtifact,
  type: string,
): ArtifactPayload {
  return {
    content_digest: stored.contentDigest,
    byte_size: stored.byteSize,
    media_type: type,
    artifact_role: "original",
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function canonicalSubmissionIntent(
  intent: DurableSubmissionIntent,
): string {
  return JSON.stringify(stableValue(intent));
}

export function submissionIntentHash(intent: DurableSubmissionIntent): string {
  return createHash("sha256")
    .update(canonicalSubmissionIntent(intent))
    .digest("hex");
}

function existingIntent(
  store: ResearchStore,
  idempotencyKey: string,
): { id: number; intent: string | null } | null {
  return store.db
    .query("SELECT id, intent FROM jobs WHERE idempotency_key=?")
    .get(idempotencyKey) as { id: number; intent: string | null } | null;
}

function assertEquivalent(
  existing: { id: number; intent: string | null },
  canonicalIntent: string,
): void {
  if (existing.intent !== canonicalIntent) {
    throw new CliError(
      "idempotency_conflict",
      `idempotency_key already belongs to a different intent (job ${existing.id})`,
      { exitCode: 2 },
    );
  }
}

export function admitSubmission(
  store: ResearchStore,
  input: SubmissionIntent,
  options: AdmissionOptions = {},
): AdmissionResult {
  const prepared = prepareSubmission(input);
  const registered: Array<{ stored: StoredArtifact; mediaType: string }> = [];
  let payload: DurableSubmissionIntent["payload"];

  if (prepared.kind === "url") {
    payload = { url: { url: prepared.source } };
  } else {
    const artifactStore = options.artifactStore ?? new ArtifactStore();
    if (prepared.kind === "text") {
      const type = "text/plain; charset=utf-8";
      const stored = artifactStore.captureBytes(prepared.source, {
        maxBytes: prepared.maxBytes,
      });
      registered.push({ stored, mediaType: type });
      payload = { text: artifactPayload(stored, type) };
    } else {
      const snapshots = prepared.localPaths.map((path) => {
        const type = mediaType(path);
        const stored = artifactStore.snapshotLocalFile(path, {
          mediaType: type,
          maxBytes: prepared.maxBytes,
        });
        return { stored, mediaType: type };
      });
      registered.push(...snapshots);
      if (prepared.kind === "file") {
        const snapshot = snapshots[0];
        if (snapshot === undefined)
          throw admissionError("bad_intent", "file snapshot is missing");
        payload = {
          file: artifactPayload(snapshot.stored, snapshot.mediaType),
        };
      } else {
        payload = {
          directory: {
            artifacts: snapshots.map((snapshot) =>
              artifactPayload(snapshot.stored, snapshot.mediaType),
            ),
            recursive: prepared.recursive,
            truncated: prepared.truncated,
          },
        };
      }
    }
  }

  const intent: DurableSubmissionIntent = {
    version: SUBMISSION_VERSION,
    kind: prepared.kind,
    ingress: prepared.ingress,
    collections: prepared.collections,
    payload,
    options: {
      ...(prepared.title === undefined ? {} : { title: prepared.title }),
      tags: prepared.tags,
      ...(prepared.notes === undefined ? {} : { notes: prepared.notes }),
      force: prepared.force,
      max_bytes: prepared.maxBytes,
    },
  };
  const canonicalIntent = canonicalSubmissionIntent(intent);
  const intentHash = submissionIntentHash(intent);
  const explicitKey = input.idempotencyKey?.trim();
  const idempotencyKey =
    explicitKey ?? `submit:v${SUBMISSION_VERSION}:${intentHash}`;
  const existing = existingIntent(store, idempotencyKey);
  if (existing !== null) assertEquivalent(existing, canonicalIntent);

  const enqueue = () => {
    for (const artifact of registered) {
      store.registerStoredArtifact(artifact.stored, {
        mediaType: artifact.mediaType,
        artifactRole: "original",
      });
    }
    const result = store.enqueueJob({
      idempotencyKey,
      kind: prepared.kind,
      intent: canonicalIntent,
    });
    if (!result.created) {
      assertEquivalent(
        { id: result.job.id, intent: result.job.intent },
        canonicalIntent,
      );
    }
    return result;
  };
  const admitted =
    existing === null
      ? store.db.transaction(enqueue).immediate()
      : store.enqueueJob({
          idempotencyKey,
          kind: prepared.kind,
          intent: canonicalIntent,
        });
  return {
    version: SUBMISSION_VERSION,
    status: admitted.created ? "queued" : "duplicate",
    job_id: admitted.job.id,
    idempotency_key: admitted.job.idempotency_key,
    intent_hash: intentHash,
    state: admitted.job.state,
  };
}

export async function waitForAdmission(
  store: ResearchStore,
  result: AdmissionResult,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  pollMs = 50,
): Promise<AdmissionResult> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw admissionError(
      "bad_wait_timeout",
      "wait_timeout_ms must be a non-negative integer",
    );
  }
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const row = store.db
      .query("SELECT state FROM jobs WHERE id=?")
      .get(result.job_id) as { state: JobState } | null;
    if (row === null)
      throw new CliError("job_not_found", `job ${result.job_id} not found`);
    if (TERMINAL_JOB_STATES.has(row.state)) {
      return { ...result, state: row.state, wait_status: "terminal" };
    }
    if (Date.now() >= deadline) {
      return { ...result, state: row.state, wait_status: "timeout" };
    }
    await Bun.sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}
