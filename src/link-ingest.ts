import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CompletedLinkPayload,
  validateCompletedLinkPayload,
} from "./completed-link-input";
import { findExecutable } from "./executable";
import { DEFAULT_MAX_BYTES, type ExtractedSource, extractUrl } from "./extract";
import { sanitizeExternalError } from "./sanitize";
import type {
  DocumentLinkResult,
  ResearchStore,
  UpsertDocumentResult,
} from "./store";
import { codePointLength } from "./text";
import {
  assertSafePublicUrl,
  normalizedWebUrl,
  validateHttpUrl,
} from "./url-safety";

const URL_RE = /https?:\/\/[^\s<>'"\])}]+/gi;
const X_STATUS_PATH_RE = /^\/(?:i|[A-Za-z0-9_]{1,20})\/status\/(\d+)(?:\/|$)/i;
const X_ARTICLE_PATH_RE =
  /^\/(?:i\/article|[A-Za-z0-9_]{1,20}\/articles?)\/(\d+)(?:\/|$)/i;
const PRIVATE_PATH_RE =
  /\/(account|accounts|billing|dashboard|settings|admin|messages|dm|inbox|private)(\/|$)/i;

export const LINKED_FAN_OUT_LIMIT = 25;

export type CanonicalSourceType = "tweet" | "tweet_article" | "scraped_url";

export type { CompletedLinkPayload } from "./completed-link-input";

export interface ScrapedLink {
  success: true;
  url: string;
  requested_url: string;
  preset: string | null;
  markdown: string;
  content: string;
  structured: unknown;
  links: unknown;
  size_chars: number;
}

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
  ensurePublicUrl?: (url: string) => Promise<unknown>;
  scrapeX?: (url: string, preset?: string | null) => Promise<ScrapedLink>;
  extractExternal?: (url: string) => Promise<ExtractedSource>;
  writeArtifact?: (path: string, markdown: string) => void;
  scrapeLinked?: boolean;
  scrapectlTimeoutMs?: number;
}

function validateUrl(input: string): string {
  return validateHttpUrl(input).toString();
}

function isXHost(input: string): boolean {
  try {
    const host = new URL(input).hostname.toLowerCase();
    return ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(
      host,
    );
  } catch {
    return false;
  }
}

function xStatusId(input: string): string | null {
  if (!isXHost(input)) return null;
  return validateHttpUrl(input).pathname.match(X_STATUS_PATH_RE)?.[1] ?? null;
}

function xArticleId(input: string): string | null {
  if (!isXHost(input)) return null;
  return validateHttpUrl(input).pathname.match(X_ARTICLE_PATH_RE)?.[1] ?? null;
}

export function canonicalizeSource(
  input: string,
): [CanonicalSourceType, string] {
  const normalized = normalizedWebUrl(input);
  const statusId = xStatusId(normalized);
  if (statusId) return ["tweet", `https://x.com/i/status/${statusId}`];
  const articleId = xArticleId(normalized);
  if (articleId)
    return ["tweet_article", `https://x.com/i/article/${articleId}`];
  return ["scraped_url", normalized];
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
    let type: CanonicalSourceType = "scraped_url";
    let key = candidate;
    try {
      [type, key] = canonicalizeSource(candidate);
    } catch {
      // Preserve unsafe but syntactically discovered URLs for failed provenance.
    }
    if (key === sourceKey || seen.has(key)) continue;
    if (isXHost(candidate) && type === "scraped_url") continue;
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

function structuredMarkdown(raw: Record<string, unknown>): string {
  if (Array.isArray(raw.tweets)) {
    const parts: string[] = [];
    const authorName = String(raw.author_name ?? "").trim();
    const authorHandle = String(raw.author_handle ?? "")
      .trim()
      .replace(/^@/, "");
    const authorUrl = String(raw.author_url ?? "").trim();
    const display =
      authorName && authorHandle
        ? `${authorName} (@${authorHandle})`
        : authorName || (authorHandle ? `@${authorHandle}` : "");
    if (display)
      parts.push(
        authorUrl
          ? `**Author**: [${display}](${authorUrl})`
          : `**Author**: ${display}`,
      );
    const blocks: string[] = [];
    for (const item of raw.tweets) {
      if (item === null || typeof item !== "object" || Array.isArray(item))
        continue;
      const tweet = item as Record<string, unknown>;
      const block = [String(tweet.text ?? "").trim()];
      const timestamp = String(tweet.timestamp ?? "").trim();
      const permalink = String(tweet.permalink ?? "").trim();
      if (timestamp && permalink) block.push(`[${timestamp}](${permalink})`);
      else if (timestamp) block.push(timestamp);
      else if (permalink) block.push(permalink);
      const rendered = block.filter(Boolean).join("\n\n");
      if (rendered) blocks.push(rendered);
    }
    if (blocks.length > 0) parts.push(blocks.join("\n\n---\n\n"));
    const quoted = raw.quoted_tweet;
    if (
      quoted !== null &&
      typeof quoted === "object" &&
      !Array.isArray(quoted)
    ) {
      const text = String(
        (quoted as Record<string, unknown>).text ?? "",
      ).trim();
      if (text)
        parts.push(
          `**Quoted Tweet:**\n${text
            .split("\n")
            .map((line) => (line ? `> ${line}` : ">"))
            .join("\n")}`,
        );
    }
    return parts.join("\n\n").trim();
  }
  if (Array.isArray(raw.turns)) {
    return raw.turns
      .filter(
        (turn) =>
          turn !== null && typeof turn === "object" && !Array.isArray(turn),
      )
      .map((turn) => {
        const record = turn as Record<string, unknown>;
        const roleText = String(record.role ?? "Unknown")
          .trim()
          .toLowerCase();
        const role =
          roleText.length > 0
            ? `${roleText[0].toUpperCase()}${roleText.slice(1)}`
            : "Unknown";
        const content = String(record.content ?? "").trim();
        return content ? `## ${role}\n\n${content}` : `## ${role}`;
      })
      .join("\n\n---\n\n")
      .trim();
  }
  return "";
}

function privateish(input: string, preset?: string | null): boolean {
  return (
    PRIVATE_PATH_RE.test(validateHttpUrl(input).pathname) ||
    /billing|usage|account|dashboard/i.test(preset ?? "")
  );
}

export function runScrapectl(
  url: string,
  preset: string | null,
  timeoutMs: number,
): ScrapedLink {
  const executable = findExecutable("scrapectl");
  if (!executable) throw new Error("scrapectl is not installed on PATH");
  const inferredPreset =
    preset ||
    (xStatusId(url) ? "x-tweet" : xArticleId(url) ? "x-article" : null);
  if (privateish(url, inferredPreset)) {
    throw new Error(
      "refusing to scrape likely private/account/billing/dashboard/DM URL",
    );
  }
  const args = ["fetch-markdown", "--json"];
  if (inferredPreset) args.push("--preset", inferredPreset);
  args.push(url);
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 20_000_000,
  });
  if (result.error) throw new Error(sanitizeExternalError(result.error));
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      sanitizeExternalError(
        detail || `scrapectl exited ${result.status ?? "without status"}`,
      ),
    );
  }
  const stdout = result.stdout.trim();
  let raw: Record<string, unknown>;
  if (!stdout) raw = { success: true };
  else {
    try {
      const parsed: unknown = JSON.parse(stdout);
      raw =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { content: stdout };
    } catch {
      raw = { content: stdout };
    }
  }
  const markdownValue = raw.markdown ?? raw.content ?? raw.text;
  const markdown =
    typeof markdownValue === "string" && markdownValue.trim()
      ? markdownValue
      : structuredMarkdown(raw);
  if (!markdown.trim()) throw new Error("scrape returned no markdown/content");
  let resolvedUrl = url;
  for (const key of ["resolved_url", "final_url", "url"]) {
    const candidate = raw[key];
    if (typeof candidate !== "string") continue;
    try {
      resolvedUrl = validateUrl(candidate);
      break;
    } catch {
      // Ignore malformed scraper metadata.
    }
  }
  return {
    success: true,
    url: resolvedUrl,
    requested_url: url,
    preset: inferredPreset,
    markdown,
    content: markdown,
    structured: raw.structured ?? raw,
    links: raw.links,
    size_chars: codePointLength(markdown),
  };
}

/** Commit an already-scraped root, then attempt exactly one child hop for X roots. */
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
  const source = payload.source ?? "botctl";
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
    scraper:
      origin === "arthack-scrapectl" ? "arthack scrapectl/browserctl" : origin,
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
    const ensurePublic = dependencies.ensurePublicUrl ?? assertSafePublicUrl;
    const scrapeX =
      dependencies.scrapeX ??
      (async (childUrl, childPreset) =>
        runScrapectl(
          childUrl,
          childPreset ?? null,
          dependencies.scrapectlTimeoutMs ?? 120_000,
        ));
    const extractExternal =
      dependencies.extractExternal ??
      (async (childUrl: string) =>
        extractUrl(childUrl, { maxBytes: DEFAULT_MAX_BYTES }));
    const discoveredLinks = extractOutboundLinks(
      canonicalUrl,
      payload.markdown,
      payload.structured,
    );
    linkedDiscoveredCount = discoveredLinks.length;
    linkedTruncated = linkedDiscoveredCount > LINKED_FAN_OUT_LIMIT;
    for (const linkedUrl of discoveredLinks.slice(0, LINKED_FAN_OUT_LIMIT)) {
      try {
        const [linkedType, linkedCanonicalUrl] = canonicalizeSource(linkedUrl);
        let childPayload: CompletedLinkPayload;
        if (linkedType === "tweet" || linkedType === "tweet_article") {
          await ensurePublic(linkedUrl);
          const scraped = await scrapeX(linkedUrl, null);
          const [reportedType, reportedCanonicalUrl] = canonicalizeSource(
            scraped.url,
          );
          if (
            reportedType !== linkedType ||
            reportedCanonicalUrl !== linkedCanonicalUrl
          ) {
            throw new Error(
              "Scrapectl resolved URL did not match the requested canonical X item",
            );
          }
          childPayload = {
            url: scraped.url,
            markdown: scraped.markdown,
            structured: scraped.structured,
            preset: scraped.preset ?? undefined,
          };
        } else {
          const extracted = await extractExternal(linkedUrl);
          childPayload = {
            url: extracted.source_uri,
            markdown: extracted.content,
            title: extracted.title,
            structured: {},
          };
        }
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
