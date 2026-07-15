import { createHash } from "node:crypto";

export const DEFAULT_CHUNK_CHARS = 3200;
export const DEFAULT_CHUNK_OVERLAP = 350;

export interface TextChunk {
  start: number;
  end: number;
  content: string;
}

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

function replaceControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    const replace =
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31);
    return replace ? " " : character;
  }).join("");
}

export function cleanText(value: string): string {
  return replaceControlCharacters(
    (value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n"),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeTags(tags: unknown): string[] {
  let raw: string[];
  if (tags === null || tags === undefined) raw = [];
  else if (typeof tags === "string") raw = tags.split(/[,#]\s*|\s+#/);
  else if (Array.isArray(tags)) raw = tags.map(String);
  else raw = [String(tags)];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of raw) {
    const tag = item
      .trim()
      .toLowerCase()
      .replace(/^#+/, "")
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9_.-]/g, "");
    if (tag.length > 0 && !seen.has(tag)) {
      seen.add(tag);
      normalized.push(tag);
    }
  }
  return normalized;
}

function lastBoundary(window: string): { offset: number; width: number } {
  const paragraph = window.lastIndexOf("\n\n");
  const sentence = window.lastIndexOf(". ");
  const newline = window.lastIndexOf("\n");
  const utf16Offset = Math.max(paragraph, sentence, newline);
  if (utf16Offset < 0) return { offset: -1, width: 0 };
  return {
    offset: codePointLength(window.slice(0, utf16Offset)),
    width: utf16Offset === paragraph ? 2 : 1,
  };
}

/** Chunk by Unicode code point so offsets remain compatible with Python/SQLite. */
export function chunkText(
  text: string,
  chunkChars = DEFAULT_CHUNK_CHARS,
  overlap = DEFAULT_CHUNK_OVERLAP,
): TextChunk[] {
  const points = Array.from(text ?? "");
  if (points.length === 0) return [];
  if (points.length <= chunkChars) {
    return [{ start: 0, end: points.length, content: points.join("") }];
  }
  if (!Number.isInteger(chunkChars) || chunkChars < 1) {
    throw new Error("chunkChars must be a positive integer");
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= chunkChars) {
    throw new Error(
      "overlap must be a non-negative integer smaller than chunkChars",
    );
  }

  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < points.length) {
    let end = Math.min(points.length, start + chunkChars);
    if (end < points.length) {
      const boundary = lastBoundary(points.slice(start, end).join(""));
      if (boundary.offset > chunkChars * 0.55) {
        end = start + boundary.offset + boundary.width;
      }
    }
    const content = points.slice(start, end).join("").trim();
    if (content.length > 0) chunks.push({ start, end, content });
    if (end >= points.length) break;
    const previousStart = chunks.at(-1)?.start ?? start;
    const previousEnd = chunks.at(-1)?.end ?? end;
    start = Math.max(0, end - overlap);
    if (start <= previousStart) start = previousEnd;
  }
  return chunks;
}
