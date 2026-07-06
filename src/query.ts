import { CliError } from "./errors";
import type { SearchMode } from "./types";

const FTS_TOKEN = /[\p{L}\p{N}_./:@-]+/gu;

export function normalizeSearchQuery(input: string, mode: SearchMode): string {
  const query = input.trim();
  if (query.length === 0) {
    throw new CliError("empty_query", "search query cannot be empty", {
      exitCode: 2,
    });
  }
  if (mode === "raw") return query;

  const phrases = Array.from(query.matchAll(/"([^"]+)"/g), (m) =>
    m[1].trim(),
  ).filter(Boolean);
  const withoutPhrases = query.replace(/"([^"]+)"/g, " ");
  const terms = Array.from(
    withoutPhrases.matchAll(FTS_TOKEN),
    (m) => m[0],
  ).filter((term) => term.length > 0);
  const atoms = [...phrases.map(quoteFtsPhrase), ...terms.map(quoteFtsPhrase)];
  if (atoms.length === 0) {
    throw new CliError("empty_query", "search query has no searchable terms", {
      exitCode: 2,
    });
  }
  return atoms.join(mode === "all" ? " AND " : " OR ");
}

function quoteFtsPhrase(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function parseTags(raw: string | null): string[] {
  if (raw === null || raw.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

export function domainFromUri(sourceUri: string): string | null {
  try {
    const url = new URL(sourceUri);
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function clampLimit(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1) {
    throw new CliError("bad_limit", "limit must be a positive integer", {
      exitCode: 2,
    });
  }
  return Math.min(n, max);
}

export function nonNegativeOffset(value: number | undefined): number {
  const n = value ?? 0;
  if (!Number.isInteger(n) || n < 0) {
    throw new CliError("bad_offset", "offset must be a non-negative integer", {
      exitCode: 2,
    });
  }
  return n;
}

export function truncateContent(
  content: string,
  charLimit: number | null,
): { content: string; omitted: number } {
  if (charLimit === null || content.length <= charLimit)
    return { content, omitted: 0 };
  if (charLimit < 500) {
    throw new CliError("bad_char_limit", "char limit must be at least 500", {
      exitCode: 2,
    });
  }
  const head = Math.floor(charLimit * 0.65);
  const tail = charLimit - head;
  const omitted = content.length - charLimit;
  return {
    content: `${content.slice(0, head)}\n\n[... omitted ${omitted} chars ...]\n\n${content.slice(-tail)}`,
    omitted,
  };
}
