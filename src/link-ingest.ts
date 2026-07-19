import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CompletedLinkPayload,
  validateCompletedLinkPayload,
} from "./completed-link-input";
import { DEFAULT_MAX_BYTES } from "./extract";
import { sanitizeArtifactError } from "./sanitize";
import type { ScrapeProvider } from "./scrapectl";
import type {
  DocumentLinkResult,
  ResearchStore,
  UpsertDocumentResult,
} from "./store";
import type {
  ExtractionFanoutPlan,
  ExtractionRelation,
  FanoutDiscovery,
  FanoutSuppressionReason,
  ResourceRelationType,
} from "./types";
import {
  canonicalizeSource,
  isXHost,
  normalizedWebUrl,
  validateHttpUrl,
  xArticleId,
  xStatusId,
} from "./url";

export const LINKED_FAN_OUT_LIMIT = 25;
export const QUEUED_FANOUT_JOB_PREFIX = "x-fanout:v1:";

const MEDIA_PATH_RE =
  /\.(?:avif|bmp|gif|jpe?g|m4a|m4v|mov|mp3|mp4|ogg|png|svg|webm|webp|wav)$/i;
const X_MEDIA_HOSTS = new Set([
  "abs.twimg.com",
  "pbs.twimg.com",
  "ton.twitter.com",
  "video.twimg.com",
]);
const MEDIA_FORMATS = new Set([
  "avif",
  "gif",
  "jpeg",
  "jpg",
  "mp4",
  "png",
  "webm",
  "webp",
]);

function relationIdentity(url: string): {
  canonicalUrl: string;
  resourceKey: { type: string; value: string };
  relationType: ResourceRelationType;
} {
  const statusId = xStatusId(url);
  if (statusId !== null) {
    return {
      canonicalUrl: `https://x.com/i/status/${statusId}`,
      resourceKey: { type: "x:status", value: statusId },
      relationType: "quoted_post",
    };
  }
  const articleId = xArticleId(url);
  if (articleId !== null) {
    return {
      canonicalUrl: `https://x.com/i/article/${articleId}`,
      resourceKey: { type: "x:article", value: articleId },
      relationType: "article",
    };
  }
  const canonicalUrl = normalizedWebUrl(url);
  return {
    canonicalUrl,
    resourceKey: { type: "url", value: canonicalUrl },
    relationType: "content_link",
  };
}

function mappedRelationType(
  extractionType: ExtractionRelation["relation_type"],
  inferredType: ResourceRelationType,
): ResourceRelationType {
  if (extractionType !== "references") return extractionType;
  return inferredType === "quoted_post" ? "content_link" : inferredType;
}

function resourceIdentityKey(resourceKey: {
  type: string;
  value: string;
}): string {
  return `${resourceKey.type}\u0000${resourceKey.value}`;
}

function childIntent(url: string): string {
  return JSON.stringify({
    version: 1,
    kind: "url",
    ingress: "x-fanout",
    collections: [],
    payload: { url: { url } },
    options: {
      tags: [],
      force: false,
      max_bytes: DEFAULT_MAX_BYTES,
    },
  });
}

function childIdempotencyKey(resourceKey: {
  type: string;
  value: string;
}): string {
  const digest = createHash("sha256")
    .update(resourceIdentityKey(resourceKey))
    .digest("hex");
  return `${QUEUED_FANOUT_JOB_PREFIX}${digest}`;
}

function unsafeDestination(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const [first = 0, second = 0] = host.split(".").map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }
  if (host.includes(":")) {
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      /^fe[89ab]/.test(host) ||
      host.startsWith("ff") ||
      host.startsWith("::ffff:")
    );
  }
  return false;
}

function policySuppression(
  targetUrl: string,
  relationType: ResourceRelationType,
): FanoutSuppressionReason | null {
  const parsed = validateHttpUrl(targetUrl);
  if (unsafeDestination(parsed.hostname)) return "unsafe_destination";
  if (
    (relationType === "article" && xArticleId(targetUrl) === null) ||
    (relationType === "quoted_post" && xStatusId(targetUrl) === null)
  ) {
    return "relation_target_mismatch";
  }
  if (
    isXHost(targetUrl) &&
    xStatusId(targetUrl) === null &&
    xArticleId(targetUrl) === null
  ) {
    return "excluded_x_chrome";
  }
  if (
    X_MEDIA_HOSTS.has(parsed.hostname.toLowerCase()) ||
    MEDIA_PATH_RE.test(parsed.pathname) ||
    MEDIA_FORMATS.has((parsed.searchParams.get("format") ?? "").toLowerCase())
  ) {
    return "excluded_media";
  }
  return null;
}

export function planQueuedUrlFanout(
  sourceUrl: string,
  relations: readonly ExtractionRelation[],
  options: { oneHopChild?: boolean } = {},
): ExtractionFanoutPlan {
  const rootEligible =
    xStatusId(sourceUrl) !== null || xArticleId(sourceUrl) !== null;
  const parent = relationIdentity(sourceUrl);
  const parentKey = resourceIdentityKey(parent.resourceKey);
  const seen = new Set<string>();
  let admitted = 0;
  const discoveries: FanoutDiscovery[] = relations.map((relation, index) => {
    const target = relationIdentity(relation.target_url);
    const targetKey = resourceIdentityKey(target.resourceKey);
    const relationType = mappedRelationType(
      relation.relation_type,
      target.relationType,
    );
    let suppressionReason = policySuppression(
      relation.target_url,
      relationType,
    );
    if (suppressionReason === null) {
      if (options.oneHopChild === true) suppressionReason = "one_hop_limit";
      else if (!rootEligible) suppressionReason = "ineligible_root";
    }
    if (targetKey === parentKey) suppressionReason = "self_reference";
    else if (seen.has(targetKey)) suppressionReason = "duplicate_destination";
    else {
      seen.add(targetKey);
      if (suppressionReason === null) {
        if (admitted >= LINKED_FAN_OUT_LIMIT) {
          suppressionReason = "fanout_limit";
        } else {
          admitted += 1;
        }
      }
    }
    return {
      ordinal: index,
      relationType,
      targetUrl: relation.target_url,
      canonicalUrl: target.canonicalUrl,
      resourceKey: target.resourceKey,
      childIdempotencyKey: childIdempotencyKey(target.resourceKey),
      childIntent: childIntent(target.canonicalUrl),
      suppressionReason,
    };
  });
  return { discoveries };
}

export type { CompletedLinkPayload } from "./completed-link-input";
export type { ScrapedLink } from "./scrapectl";
export { type CanonicalSourceType, canonicalizeSource } from "./url";

export interface LinkedResult {
  success: boolean;
  url: string;
  root_success?: boolean;
  root?: UpsertDocumentResult;
  ingest?: UpsertDocumentResult;
  artifact_path?: string | null;
  linked_results?: LinkedResult[];
  linked_count?: number;
  linked_failed_count?: number;
  relation: DocumentLinkResult | { success: false; error: string };
  error?: string;
}

export interface LinkIngestResult {
  success: boolean;
  root_success: true;
  root: UpsertDocumentResult;
  ingest: UpsertDocumentResult;
  artifact_path: string | null;
  linked_results: LinkedResult[];
  linked_count: number;
  linked_failed_count: number;
  linked_truncated?: true;
  linked_discovered_count?: number;
  artifact_error?: string;
}

export interface LinkIngestDependencies {
  scrape?: ScrapeProvider;
  writeArtifact?: (path: string, markdown: string) => void;
}

function validateUrl(input: string): string {
  return validateHttpUrl(input).toString();
}

function safeTag(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_.-]/g, "");
}

function domainTag(input: string): string {
  const host = validateHttpUrl(input).hostname.toLowerCase();
  return host.startsWith("www.") ? host.slice(4) : host || "link";
}

function sourceLabel(source: unknown): string {
  if (source !== null && typeof source === "object" && !Array.isArray(source)) {
    const record = source as Record<string, unknown>;
    for (const key of ["origin", "source", "name", "kind", "type"]) {
      if (record[key]) return safeTag(record[key]);
    }
    return "";
  }
  return safeTag(source);
}

function jsonSafe(value: unknown): unknown {
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return String(value);
  }
}

function structuredMetadata(structured: unknown): Record<string, unknown> {
  if (
    structured === null ||
    typeof structured !== "object" ||
    Array.isArray(structured)
  ) {
    return {};
  }
  const root = structured as Record<string, unknown>;
  const candidates = [root];
  for (const key of ["article", "metadata", "data"]) {
    const nested = root[key];
    if (
      nested !== null &&
      typeof nested === "object" &&
      !Array.isArray(nested)
    ) {
      candidates.push(nested as Record<string, unknown>);
    }
  }
  const output: Record<string, unknown> = {};
  const aliases: Record<string, string[]> = {
    title: ["title", "headline"],
    author: ["author", "author_name", "byline"],
    published_at: [
      "published_at",
      "publishedAt",
      "published",
      "date",
      "timestamp",
    ],
  };
  for (const [outputKey, keys] of Object.entries(aliases)) {
    for (const candidate of candidates) {
      const value = keys
        .map((key) => candidate[key])
        .find((item) => item !== null && item !== undefined && item !== "");
      if (value !== undefined) {
        output[outputKey] = jsonSafe(value);
        break;
      }
    }
  }
  if (root.author_handle) output.author_handle = String(root.author_handle);
  return output;
}

function authorTag(metadata: Record<string, unknown>): string {
  let author = metadata.author_handle ?? metadata.author;
  if (author !== null && typeof author === "object" && !Array.isArray(author)) {
    const record = author as Record<string, unknown>;
    author = record.handle ?? record.username ?? record.name;
  }
  const tag = safeTag(String(author ?? "").replace(/^@/, ""));
  return tag ? `author-${tag}` : "";
}

function inferTitle(url: string, markdown: string, explicit?: string): string {
  if (explicit?.trim())
    return Array.from(explicit.trim()).slice(0, 500).join("");
  for (const line of markdown.split("\n")) {
    const stripped = line.trim();
    if (stripped.startsWith("#")) {
      return Array.from(stripped.replace(/^#+/, "").trim() || url)
        .slice(0, 500)
        .join("");
    }
    if (stripped) return Array.from(stripped).slice(0, 120).join("");
  }
  return url;
}

function artifactPath(url: string, title: string): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const domain = safeTag(domainTag(url)) || "link";
  const pathname = validateHttpUrl(url).pathname;
  const slugSource = title || pathname.split("/").at(-1) || domain;
  const slug = safeTag(slugSource).slice(0, 80) || "scraped-link";
  const dataHome =
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(
    dataHome,
    "agentbrain",
    "scraped",
    year,
    month,
    `${domain}-${slug}.md`,
  );
}

/** Commit an already-scraped root for the temporary compatibility adapter. */
export async function ingestPrescrapedLink(
  store: ResearchStore,
  unvalidatedPayload: CompletedLinkPayload,
  dependencies: LinkIngestDependencies = {},
): Promise<LinkIngestResult> {
  const payload = validateCompletedLinkPayload(unvalidatedPayload);
  const url = validateUrl(payload.url);
  const [sourceType, canonicalUrl] = canonicalizeSource(url);
  const metadata = structuredMetadata(payload.structured);
  const explicitTitle =
    payload.title ||
    (typeof metadata.title === "string" ? metadata.title : undefined);
  const title = inferTitle(canonicalUrl, payload.markdown, explicitTitle);
  const category = safeTag(payload.category || "link");
  const extraTags = Array.isArray(payload.tags)
    ? payload.tags
    : payload.tags
      ? [payload.tags]
      : [];
  const source = payload.source ?? "agentbot";
  const origin = sourceLabel(source);
  const preset = payload.preset || null;
  const tags = [
    "link",
    "saved-link",
    "scraped",
    category && category !== "link" ? `link-${category}` : "link",
    domainTag(canonicalUrl),
  ];
  if (sourceType === "tweet") tags.push("tweet", "twitter", "x-twitter");
  else if (sourceType === "tweet_article") {
    tags.push(
      "tweet-article",
      "twitter-article",
      "x-article",
      "twitter",
      "x-twitter",
    );
  }
  if (preset) tags.push(preset);
  if (origin) tags.push(`source-${origin}`);
  const author = authorTag(metadata);
  if (author) tags.push(author);
  tags.push(...extraTags.map(String));

  const notesPayload = {
    user_notes: payload.notes || "",
    summary: payload.summary || "",
    source: jsonSafe(source),
    origin,
    scraper: origin === "arthack-scrapectl" ? "arthack scrapectl" : origin,
    preset,
    structured_metadata: metadata,
    original_url: url,
    canonical_url: canonicalUrl,
  };
  const root = store.upsertDocument({
    sourceType,
    sourceUri: canonicalUrl,
    title,
    content: payload.markdown,
    tags,
    notes: JSON.stringify(notesPayload),
  });

  let artifact: string | null = null;
  let artifactError: string | undefined;
  if (payload.save_markdown_copy === true) {
    const path = artifactPath(canonicalUrl, title);
    const writer =
      dependencies.writeArtifact ??
      ((target: string, markdown: string) => {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, markdown, "utf8");
      });
    try {
      writer(path, payload.markdown);
      artifact = path;
    } catch (error) {
      artifactError = sanitizeArtifactError(error, [path, dirname(path)]);
    }
  }

  const linkedResults: LinkedResult[] = [];
  const failedCount = 0;
  return {
    success: artifactError === undefined,
    root_success: true,
    root,
    ingest: root,
    artifact_path: artifact,
    linked_results: linkedResults,
    linked_count: linkedResults.length,
    linked_failed_count: failedCount,
    ...(artifactError === undefined ? {} : { artifact_error: artifactError }),
  };
}
