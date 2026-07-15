import { DEFAULT_MAX_BYTES } from "./extract";
import { codePointLength } from "./text";
import { validateHttpUrl } from "./url-safety";

export const COMPLETED_LINK_MARKDOWN_MAX_BYTES = DEFAULT_MAX_BYTES;
export const COMPLETED_LINK_MARKDOWN_MAX_CODE_POINTS = DEFAULT_MAX_BYTES;
export const COMPLETED_LINK_STDIN_MAX_BYTES = DEFAULT_MAX_BYTES * 2;

export interface CompletedLinkPayload {
  url: string;
  markdown: string;
  structured?: unknown;
  source?: unknown;
  title?: string;
  category?: string;
  tags?: string[] | string;
  summary?: string;
  notes?: string;
  preset?: string;
  save_markdown_copy?: boolean;
  scrape_linked?: boolean;
}

export function validateCompletedLinkPayload(
  value: unknown,
): CompletedLinkPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stdin JSON must be an object");
  }
  const payload = value as Record<string, unknown>;
  if (!("url" in payload))
    throw new Error("payload is missing required field 'url'");
  if (!("markdown" in payload))
    throw new Error("payload is missing required field 'markdown'");
  if (typeof payload.url !== "string" || !payload.url.trim()) {
    throw new Error("payload field 'url' must be a non-empty string");
  }
  validateHttpUrl(payload.url);
  if (typeof payload.markdown !== "string" || !payload.markdown.trim()) {
    throw new Error("payload field 'markdown' must be a non-empty string");
  }
  for (const field of ["title", "category", "summary", "notes", "preset"]) {
    if (payload[field] !== undefined && typeof payload[field] !== "string") {
      throw new Error(`payload field '${field}' must be a string`);
    }
  }
  if (
    payload.tags !== undefined &&
    typeof payload.tags !== "string" &&
    (!Array.isArray(payload.tags) ||
      payload.tags.some((tag) => typeof tag !== "string"))
  ) {
    throw new Error("payload field 'tags' must be a string or string array");
  }
  for (const field of ["save_markdown_copy", "scrape_linked"]) {
    if (payload[field] !== undefined && typeof payload[field] !== "boolean") {
      throw new Error(`payload field '${field}' must be a boolean`);
    }
  }
  const markdownBytes = Buffer.byteLength(payload.markdown, "utf8");
  if (markdownBytes > COMPLETED_LINK_MARKDOWN_MAX_BYTES) {
    throw new Error(
      `payload markdown exceeds ${COMPLETED_LINK_MARKDOWN_MAX_BYTES} UTF-8 bytes`,
    );
  }
  const markdownCodePoints = codePointLength(payload.markdown);
  if (markdownCodePoints > COMPLETED_LINK_MARKDOWN_MAX_CODE_POINTS) {
    throw new Error(
      `payload markdown exceeds ${COMPLETED_LINK_MARKDOWN_MAX_CODE_POINTS} Unicode code points`,
    );
  }
  return payload as unknown as CompletedLinkPayload;
}

/** Read one completed-link object without ever buffering past the raw JSON cap. */
export async function readCompletedLinkPayload(
  stream: ReadableStream<Uint8Array> = Bun.stdin.stream(),
): Promise<CompletedLinkPayload> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > COMPLETED_LINK_STDIN_MAX_BYTES) {
        await reader.cancel();
        throw new Error(
          `stdin JSON exceeds ${COMPLETED_LINK_STDIN_MAX_BYTES} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error("stdin must contain one JSON object");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("stdin JSON must be valid UTF-8");
  }
  if (!raw.trim()) throw new Error("stdin must contain one JSON object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON on stdin: ${message}`);
  }
  return validateCompletedLinkPayload(parsed);
}
