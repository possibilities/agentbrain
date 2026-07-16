import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CompletedLinkPayload,
  validateCompletedLinkPayload,
} from "./completed-link-input";
import { DEFAULT_MAX_BYTES } from "./extract";
import { sanitizeExternalError } from "./sanitize";
import { type ScrapeProvider, scrapeWithScrapectl } from "./scrapectl";
import type {
  DocumentLinkResult,
  ResearchStore,
  UpsertDocumentResult,
} from "./store";
import { canonicalizeSource, validateHttpUrl } from "./url";

const URL_RE = /https?:\/\/[^\s<>'"\])}]+/gi;

export const LINKED_FAN_OUT_LIMIT = 25;

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
  scrapeLinked?: boolean;
  scrapectlTimeoutMs?: number;
}

function validateUrl(input: string): string {
  return validateHttpUrl(input).toString();
}

function extractUrlCandidates(text: string): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const raw of String(text ?? "").match(URL_RE) ?? []) {
    const candidate = raw.replace(/[.,;:!?\])}'"]+$/g, "");
    try {
      const parsed = new URL(candidate);
      if (!parsed.hostname || !["http:", "https:"].includes(parsed.protocol)) {
        continue;
      }
    } catch {
      continue;
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      output.push(candidate);
    }
  }
  return output;
}

function extractLinkContainer(value: unknown): string[] {
  if (typeof value === "string") return extractUrlCandidates(value);
  if (Array.isArray(value)) return value.flatMap(extractLinkContainer);
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of [
    "unwound_url",
    "expanded_url",
    "expandedUrl",
    "resolved_url",
    "destination_url",
    "destinationUrl",
    "href",
    "url",
  ]) {
    const candidate = record[key];
    if (typeof candidate === "string") {
      const urls = extractUrlCandidates(candidate);
      if (urls.length > 0) return urls;
    }
  }
  return Object.values(record).flatMap(extractLinkContainer);
}

function structuredLinks(value: unknown): { links: string[]; found: boolean } {
  const links: string[] = [];
  let found = false;
  const visit = (nested: unknown): void => {
    if (Array.isArray(nested)) {
      for (const item of nested) visit(item);
      return;
    }
    if (nested === null || typeof nested !== "object") return;
    for (const [key, child] of Object.entries(nested)) {
      if (key.toLowerCase() === "links") {
        found = true;
        links.push(...extractLinkContainer(child));
      } else visit(child);
    }
  };
  visit(value);
  return { links, found };
}

export function extractOutboundLinks(
  sourceUrl: string,
  markdown: string,
  structured?: unknown,
): string[] {
  const [, sourceKey] = canonicalizeSource(sourceUrl);
  const structuredResult = structuredLinks(structured);
  const candidates = structuredResult.found
    ? structuredResult.links
    : extractUrlCandidates(markdown);
  const output: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    let key = candidate;
    try {
      [, key] = canonicalizeSource(candidate);
    } catch {
      // Preserve unsafe but syntactically discovered URLs for failed provenance.
    }
    if (key === sourceKey || seen.has(key)) continue;
    seen.add(key);
    output.push(candidate);
  }
  return output;
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

/** Commit an already-scraped root, then attempt exactly one provider-backed child hop. */
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
      artifactError = sanitizeExternalError(error);
    }
  }

  const linkedResults: LinkedResult[] = [];
  let linkedTruncated = false;
  let linkedDiscoveredCount = 0;
  const shouldScrape =
    dependencies.scrapeLinked ?? payload.scrape_linked !== false;
  if (
    shouldScrape &&
    (sourceType === "tweet" || sourceType === "tweet_article")
  ) {
    const scrape = dependencies.scrape ?? scrapeWithScrapectl;
    const discoveredLinks = extractOutboundLinks(
      canonicalUrl,
      payload.markdown,
      payload.structured,
    );
    linkedDiscoveredCount = discoveredLinks.length;
    linkedTruncated = linkedDiscoveredCount > LINKED_FAN_OUT_LIMIT;
    for (const linkedUrl of discoveredLinks.slice(0, LINKED_FAN_OUT_LIMIT)) {
      try {
        canonicalizeSource(linkedUrl);
        const scraped = await scrape(linkedUrl, {
          maxMarkdownBytes: DEFAULT_MAX_BYTES,
          maxMarkdownCodePoints: DEFAULT_MAX_BYTES,
          timeoutMs: dependencies.scrapectlTimeoutMs,
        });
        const childPayload: CompletedLinkPayload = {
          url: linkedUrl,
          markdown: scraped.markdown,
        };
        const child = await ingestPrescrapedLink(
          store,
          {
            ...childPayload,
            category: "linked-resource",
            tags: [`linked-from-${sourceType}`, domainTag(canonicalUrl)],
            notes: `Linked from ${sourceType}: ${canonicalUrl}`,
            source: { origin: "linked-destination", parent: canonicalUrl },
            scrape_linked: false,
          },
          { ...dependencies, scrapeLinked: false },
        );
        const childIngest = child.ingest;
        const relation = store.upsertDocumentLink({
          fromDocumentId: root.document_id,
          toDocumentId: childIngest.document_id,
          relationType: "content_link",
          discoveredUrl: linkedUrl,
          resolvedUrl:
            childIngest.source_uri || canonicalizeSource(linkedUrl)[1],
          status: "success",
        });
        linkedResults.push({ ...child, url: linkedUrl, relation });
      } catch (error) {
        let message = sanitizeExternalError(error);
        let relation: DocumentLinkResult | { success: false; error: string };
        try {
          let resolvedUrl: string | null = null;
          try {
            resolvedUrl = canonicalizeSource(linkedUrl)[1];
          } catch {
            // Leave malformed discoveries unresolved.
          }
          relation = store.upsertDocumentLink({
            fromDocumentId: root.document_id,
            relationType: "content_link",
            discoveredUrl: linkedUrl,
            resolvedUrl,
            status: "failed",
            error: message,
          });
        } catch (relationError) {
          const relationMessage = sanitizeExternalError(relationError);
          relation = { success: false, error: relationMessage };
          message = sanitizeExternalError(
            `${message}; provenance write failed: ${relationMessage}`,
          );
        }
        linkedResults.push({
          success: false,
          url: linkedUrl,
          error: message,
          relation,
        });
      }
    }
  }

  const failedCount = linkedResults.filter((result) => !result.success).length;
  return {
    success:
      failedCount === 0 &&
      artifactError === undefined &&
      linkedTruncated === false,
    root_success: true,
    root,
    ingest: root,
    artifact_path: artifact,
    linked_results: linkedResults,
    linked_count: linkedResults.length,
    linked_failed_count: failedCount,
    ...(linkedTruncated
      ? {
          linked_truncated: true as const,
          linked_discovered_count: linkedDiscoveredCount,
        }
      : {}),
    ...(artifactError === undefined ? {} : { artifact_error: artifactError }),
  };
}
