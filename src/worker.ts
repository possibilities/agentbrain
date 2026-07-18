import { hostname } from "node:os";
import type { DurableSubmissionIntent } from "./admission";
import { ArtifactStore } from "./artifacts";
import {
  decodeBytes,
  extractDocxBytes,
  extractEpubBytes,
  extractHtmlText,
  extractPdf,
  inferTitleFromSource,
  isProbablyBinary,
} from "./extract";
import { sanitizeExternalError } from "./sanitize";
import { type ScrapeProvider, scrapeWithScrapectl } from "./scrapectl";
import { DEFAULT_LIFECYCLE_POLICY, type ResearchStore } from "./store";
import { cleanText } from "./text";
import type { FailureClass, Job, LifecyclePolicy } from "./types";
import { sourceTypeForUrl } from "./url";

export interface MaterializedDocument {
  sourceType: string;
  sourceUri: string;
  title: string;
  content: string;
  tags?: string[];
  notes?: string;
  artifactDigest?: string;
}

export interface MaterializerContext {
  artifactStore: ArtifactStore;
  signal: AbortSignal;
  scrape: ScrapeProvider;
}

export type JobMaterializer = (
  job: Job,
  intent: DurableSubmissionIntent,
  context: MaterializerContext,
) => Promise<MaterializedDocument[]> | MaterializedDocument[];

export interface WorkerOptions {
  once?: boolean;
  workerId?: string;
  pollMs?: number;
  heartbeatMs?: number;
  leaseMs?: number;
  shutdownGraceMs?: number;
  artifactStore?: ArtifactStore;
  materialize?: JobMaterializer;
  scrape?: ScrapeProvider;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  policy?: Partial<LifecyclePolicy>;
  random?: () => number;
  signal?: AbortSignal;
  installSignalHandlers?: boolean;
}

export interface WorkerResult {
  worker_id: string;
  recovered: number;
  claimed: number;
  completed: number;
  failed: number;
  fenced: number;
  stopped: boolean;
}

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

function abortError(): Error {
  const error = new Error("worker shutdown requested");
  error.name = "AbortError";
  return error;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return Bun.sleep(milliseconds);
}

function parseIntent(job: Job): DurableSubmissionIntent {
  if (job.intent === null)
    throw new Error("ingestion job has no durable intent");
  let value: unknown;
  try {
    value = JSON.parse(job.intent);
  } catch {
    throw new Error("ingestion job has an invalid durable intent");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { kind?: unknown }).kind !== "string"
  ) {
    throw new Error("ingestion job has an unsupported durable intent");
  }
  return value as DurableSubmissionIntent;
}

function titleFromMarkdown(source: string, markdown: string): string {
  for (const line of markdown.split("\n")) {
    const stripped = line.trim();
    if (stripped.startsWith("#")) {
      return Array.from(stripped.replace(/^#+/, "").trim() || source)
        .slice(0, 500)
        .join("");
    }
    if (stripped) return Array.from(stripped).slice(0, 120).join("");
  }
  return inferTitleFromSource(source);
}

function extractArtifact(
  artifacts: ArtifactStore,
  digest: string,
  mediaType: string,
  maxBytes: number,
): string {
  if (mediaType === "application/pdf") {
    return extractPdf(artifacts.pathFor(digest), maxBytes);
  }
  const bytes = artifacts.readBytes(digest, maxBytes);
  if (
    mediaType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return extractDocxBytes(bytes, maxBytes);
  }
  if (mediaType === "application/epub+zip") {
    return extractEpubBytes(bytes, maxBytes);
  }
  if (isProbablyBinary(bytes)) throw new Error("Artifact appears to be binary");
  const decoded = decodeBytes(bytes);
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
    return extractHtmlText(decoded).content;
  }
  return cleanText(decoded);
}

interface IntentArtifact {
  content_digest: string;
  byte_size: number;
  media_type: string;
}

function requireArtifact(value: unknown): IntentArtifact {
  if (value === null || typeof value !== "object") {
    throw new Error("durable intent has no Artifact descriptor");
  }
  const artifact = value as Record<string, unknown>;
  if (
    typeof artifact.content_digest !== "string" ||
    typeof artifact.byte_size !== "number" ||
    typeof artifact.media_type !== "string"
  ) {
    throw new Error("durable intent has an invalid Artifact descriptor");
  }
  return artifact as unknown as IntentArtifact;
}

export const defaultMaterializer: JobMaterializer = async (
  job,
  intent,
  context,
) => {
  if (context.signal.aborted) throw abortError();
  const options = intent.options;
  const common = {
    tags: options.tags,
    notes: options.notes,
  };
  if (intent.kind === "url") {
    if (!("url" in intent.payload))
      throw new Error("URL intent payload is missing");
    const url = intent.payload.url.url;
    const scraped = await context.scrape(url, {
      maxMarkdownBytes: options.max_bytes,
      maxMarkdownCodePoints: options.max_bytes,
      retry: { maxAttempts: 1, writeDiagnostic: () => {} },
    });
    if (context.signal.aborted) throw abortError();
    return [
      {
        sourceType: sourceTypeForUrl(url),
        sourceUri: url,
        title: options.title ?? titleFromMarkdown(url, scraped.markdown),
        content: scraped.markdown,
        ...common,
      },
    ];
  }

  const descriptors =
    intent.kind === "text" && "text" in intent.payload
      ? [requireArtifact(intent.payload.text)]
      : intent.kind === "file" && "file" in intent.payload
        ? [requireArtifact(intent.payload.file)]
        : intent.kind === "directory" && "directory" in intent.payload
          ? intent.payload.directory.artifacts.map(requireArtifact)
          : [];
  if (descriptors.length === 0 && intent.kind !== "directory") {
    throw new Error("local intent payload is missing");
  }
  return descriptors.map((artifact, index) => {
    if (context.signal.aborted) throw abortError();
    const content = extractArtifact(
      context.artifactStore,
      artifact.content_digest,
      artifact.media_type,
      options.max_bytes,
    );
    return {
      sourceType: intent.kind === "text" ? "text" : "file",
      sourceUri: `ingestion-job:${job.id}:artifact:${index + 1}`,
      title:
        options.title ??
        (intent.kind === "text"
          ? "Pasted note"
          : `Captured Artifact ${artifact.content_digest.slice(0, 12)}`),
      content,
      artifactDigest: artifact.content_digest,
      ...common,
    };
  });
};

function classifyFailure(error: unknown): FailureClass {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  if (
    /not installed|not found|credential|authorization|authentication|permission/.test(
      message,
    )
  ) {
    return "auth_config";
  }
  if (
    /timeout|timed out|unavailable|busy|locked|econn|temporar|interrupted/.test(
      message,
    )
  ) {
    return "infra";
  }
  if (/429|rate limit|throttl/.test(message)) return "item_transient";
  return "permanent";
}

function applyDocuments(
  store: ResearchStore,
  job: Job,
  intent: DurableSubmissionIntent,
  documents: MaterializedDocument[],
): number | null {
  let firstResourceId: number | null = null;
  const timestamp = new Date().toISOString();
  for (const [index, document] of documents.entries()) {
    const indexed = store.upsertDocument({
      sourceType: document.sourceType,
      sourceUri: document.sourceUri,
      title: document.title,
      content: document.content,
      tags: document.tags,
      notes: document.notes,
      force: intent.options.force,
    });
    const keyValue = `${job.id}:${index + 1}`;
    store.db
      .query(
        `INSERT INTO resources(
           key_type, key_value, kind, sensitivity, document_id, created_at, updated_at
         ) VALUES ('ingestion_job_item', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key_type, key_value) DO UPDATE SET
           document_id=excluded.document_id, sensitivity=excluded.sensitivity,
           updated_at=excluded.updated_at`,
      )
      .run(
        keyValue,
        job.kind,
        job.sensitivity,
        indexed.document_id,
        timestamp,
        timestamp,
      );
    const resource = store.db
      .query(
        "SELECT id FROM resources WHERE key_type='ingestion_job_item' AND key_value=?",
      )
      .get(keyValue) as { id: number };
    if (firstResourceId === null) firstResourceId = resource.id;
    store.db
      .query(
        `INSERT INTO resource_aliases(
           resource_id, alias_type, locator, evidence, first_observed_at, last_observed_at
         ) VALUES (?, 'materialized_uri', ?, 'worker', ?, ?)
         ON CONFLICT(resource_id, alias_type, locator) DO UPDATE SET
           last_observed_at=excluded.last_observed_at`,
      )
      .run(resource.id, document.sourceUri, timestamp, timestamp);
    store.db
      .query(
        `INSERT INTO provenance(resource_id, evidence_type, ingress, observed_at)
         VALUES (?, 'ingestion_materialized', ?, ?)`,
      )
      .run(resource.id, intent.ingress, timestamp);
    if (document.artifactDigest !== undefined) {
      const artifact = store.db
        .query(
          "SELECT id FROM artifacts WHERE content_hash=? AND artifact_role='original'",
        )
        .get(document.artifactDigest) as { id: number } | null;
      if (artifact !== null) {
        store.db
          .query(
            `INSERT OR IGNORE INTO resource_artifacts(resource_id, artifact_id, observed_at)
             VALUES (?, ?, ?)`,
          )
          .run(resource.id, artifact.id, timestamp);
      }
    }
    for (const slug of intent.collections) {
      store.db
        .query(
          `INSERT OR IGNORE INTO collections(slug, title, sensitivity, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(slug, slug, job.sensitivity, timestamp, timestamp);
      store.db
        .query(
          `INSERT OR IGNORE INTO collection_memberships(collection_id, resource_id, added_at)
           SELECT id, ?, ? FROM collections WHERE slug=?`,
        )
        .run(resource.id, timestamp, slug);
    }
  }
  if (firstResourceId !== null) {
    store.db
      .query("UPDATE jobs SET resource_id=? WHERE id=?")
      .run(firstResourceId, job.id);
  }
  return firstResourceId;
}

export async function runWorker(
  store: ResearchStore,
  options: WorkerOptions = {},
): Promise<WorkerResult> {
  const once = options.once === true;
  const workerId = options.workerId ?? `${hostname()}:${process.pid}`;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const leaseMs = options.leaseMs ?? DEFAULT_LIFECYCLE_POLICY.leaseMs;
  const heartbeatMs =
    options.heartbeatMs ?? Math.max(100, Math.floor(leaseMs / 3));
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const artifactStore = options.artifactStore ?? new ArtifactStore();
  const materialize = options.materialize ?? defaultMaterializer;
  const scrape = options.scrape ?? scrapeWithScrapectl;
  if (
    !Number.isFinite(pollMs) ||
    pollMs < 1 ||
    !Number.isFinite(leaseMs) ||
    leaseMs < 1 ||
    !Number.isFinite(heartbeatMs) ||
    heartbeatMs < 1 ||
    !Number.isFinite(shutdownGraceMs) ||
    shutdownGraceMs < 0
  ) {
    throw new Error(
      "worker timing options must be positive (shutdown grace may be zero)",
    );
  }

  let stopping = options.signal?.aborted === true;
  let activeController: AbortController | null = null;
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeIdle: (() => void) | null = null;
  const requestStop = (): void => {
    if (stopping) return;
    stopping = true;
    wakeIdle?.();
    if (activeController !== null) {
      shutdownTimer = setTimeout(
        () => activeController?.abort(),
        shutdownGraceMs,
      );
    }
  };
  const onAbort = (): void => requestStop();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const signalHandlers: Array<[NodeJS.Signals, () => void]> = [];
  if (options.installSignalHandlers !== false) {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const handler = (): void => requestStop();
      process.on(signal, handler);
      signalHandlers.push([signal, handler]);
    }
  }

  const recovered = store.recoverExpiredLeases({
    now: now(),
    policy: options.policy,
    random: options.random,
  }).length;
  const result: WorkerResult = {
    worker_id: workerId,
    recovered,
    claimed: 0,
    completed: 0,
    failed: 0,
    fenced: 0,
    stopped: false,
  };

  try {
    while (!stopping) {
      const claim = store.claimJob({
        worker: workerId,
        now: now(),
        leaseMs,
        policy: options.policy,
      });
      if (!claim.claimed) {
        if (once) break;
        let resolveWake: () => void = () => {};
        const wake = new Promise<void>((resolve) => {
          resolveWake = resolve;
          wakeIdle = resolve;
        });
        if (stopping) resolveWake();
        await Promise.race([sleep(pollMs), wake]);
        wakeIdle = null;
        continue;
      }
      result.claimed += 1;
      const controller = new AbortController();
      activeController = controller;
      let lostLease = false;
      const heartbeat = setInterval(() => {
        try {
          const beat = store.heartbeat({
            fencingToken: claim.fencing_token,
            now: now(),
            leaseMs,
            policy: options.policy,
          });
          if (!beat.ok) {
            lostLease = true;
            controller.abort();
          }
        } catch {
          lostLease = true;
          controller.abort();
        }
      }, heartbeatMs);
      try {
        const intent = parseIntent(claim.job);
        const documents = await materialize(claim.job, intent, {
          artifactStore,
          signal: controller.signal,
          scrape,
        });
        if (controller.signal.aborted || lostLease) {
          result.fenced += 1;
          continue;
        }
        const completed = store.completeJob({
          fencingToken: claim.fencing_token,
          now: now(),
          apply: () => {
            applyDocuments(store, claim.job, intent, documents);
          },
        });
        if (completed.ok) {
          result.completed += 1;
        } else {
          result.fenced += 1;
        }
      } catch (error) {
        if (controller.signal.aborted || lostLease) {
          result.fenced += 1;
          continue;
        }
        const failed = store.failAttempt({
          fencingToken: claim.fencing_token,
          failureClass: classifyFailure(error),
          summary: sanitizeExternalError(error),
          now: now(),
          policy: options.policy,
          random: options.random,
        });
        if (failed.ok) result.failed += 1;
        else result.fenced += 1;
      } finally {
        clearInterval(heartbeat);
        activeController = null;
        if (shutdownTimer !== null) {
          clearTimeout(shutdownTimer);
          shutdownTimer = null;
        }
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    for (const [signal, handler] of signalHandlers)
      process.off(signal, handler);
  }
  result.stopped = stopping;
  return result;
}
