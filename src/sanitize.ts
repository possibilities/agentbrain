const ERROR_LIMIT = 600;

/** Redact likely credentials before an external-process error is persisted or emitted. */
export function sanitizeExternalError(value: unknown): string {
  let message = value instanceof Error ? value.message : String(value ?? "");
  message = Array.from(message, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 ? " " : character;
  }).join("");
  message = message
    .replace(
      /\b(authorization\s*[:=]\s*)(?:bearer\s+[^\s,;]+|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(
      /([?&](?:access_token|api[_-]?key|auth|authorization|credential|password|passwd|secret|token)=)[^&#\s]*/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(["']?[a-z0-9_-]*(?:api[_-]?key|authorization|credential|password|passwd|secret|token)[a-z0-9_-]*["']?\s*[:=]\s*["']?)[^\s,"';&}]+/gi,
      "$1[REDACTED]",
    )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!message) message = "external command failed";
  if (message.length > ERROR_LIMIT) {
    message = `${message.slice(0, ERROR_LIMIT)}…`;
  }
  return message;
}
