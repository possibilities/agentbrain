import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { findExecutable } from "./executable";
import { sanitizeExternalError } from "./sanitize";
import { codePointLength } from "./text";
import type {
  ExtractionEnvelope,
  ExtractionFailureClass,
  ExtractionFailureDetail,
  ExtractionMetadata,
  ExtractionRelation,
  ExtractionSuccess,
  ExtractorIdentity,
  FailureClass,
} from "./types";
import { normalizedWebUrl, validateHttpUrl } from "./url";

export const SCRAPECTL_DEFAULT_TIMEOUT_MS = 120_000;
export const SCRAPECTL_OUTPUT_MAX_BYTES = 20_000_000;
export const SCRAPECTL_DEFAULT_MARKDOWN_MAX_BYTES = 5_000_000;
export const SCRAPECTL_DEFAULT_MARKDOWN_MAX_CODE_POINTS = 5_000_000;
export const SCRAPECTL_RETRY_INITIAL_MS = 1_000;
export const SCRAPECTL_RETRY_MAX_MS = 30_000;
export const SCRAPECTL_RETRY_ENV_MIN_MS = 100;
export const SCRAPECTL_RETRY_CONFIG_MAX_MS = 3_600_000;
export const SCRAPECTL_TIMEOUT_MAX_MS = 600_000;
export const SCRAPECTL_TERMINATION_GRACE_MS = 250;
export const SCRAPECTL_EXTRACTION_SCHEMA_VERSION = "1" as const;
export const SCRAPECTL_DEFAULT_MAX_RELATIONS = 256;

export interface ScrapedLink {
  success: true;
  url: string;
  requested_url: string;
  markdown: string;
  content: string;
  size_chars: number;
}

export interface ScrapectlRetryOptions {
  /** Total attempts, including the first. Undefined means no limit. */
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (delayMs: number) => void | Promise<void>;
  writeDiagnostic?: (message: string) => void;
}

export interface ScrapeOptions {
  timeoutMs?: number;
  maxMarkdownBytes?: number;
  maxMarkdownCodePoints?: number;
  maxOutputBytes?: number;
  /** Retry controls are primarily dependency-injection seams for offline tests. */
  retry?: ScrapectlRetryOptions;
}

export type ScrapeProvider = (
  url: string,
  options?: ScrapeOptions,
) => ScrapedLink | Promise<ScrapedLink>;

export interface ExtractionOptions {
  timeoutMs?: number;
  maxContentBytes?: number;
  maxOutputBytes?: number;
  maxRelations?: number;
  signal?: AbortSignal;
}

export type ExtractionProvider = (
  url: string,
  options?: ExtractionOptions,
) => ExtractionSuccess | Promise<ExtractionSuccess>;

export type ExtractionDisposition = FailureClass | "cancelled";

export class ScrapectlExtractionError extends Error {
  constructor(
    message: string,
    readonly disposition: ExtractionDisposition,
    readonly outcome:
      | "infrastructure"
      | "item"
      | "auth_config"
      | "permanent"
      | "policy"
      | "cancellation"
      | "protocol",
  ) {
    super(message);
    this.name = "ScrapectlExtractionError";
  }
}

type CancellationSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

type ProviderTerminator = () => void | Promise<void>;

const activeProviderTerminators = new Set<ProviderTerminator>();
let parentCancellationStarted = false;
const CANCELLATION_EXIT_CODES: Record<CancellationSignal, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

async function exitForCancellation(signal: CancellationSignal): Promise<void> {
  if (parentCancellationStarted) return;
  parentCancellationStarted = true;
  await Promise.allSettled(
    [...activeProviderTerminators].map(async (terminate) => terminate()),
  );
  process.exit(CANCELLATION_EXIT_CODES[signal]);
}

const cancellationHandlers: Record<CancellationSignal, () => void> = {
  SIGHUP: () => {
    void exitForCancellation("SIGHUP");
  },
  SIGINT: () => {
    void exitForCancellation("SIGINT");
  },
  SIGTERM: () => {
    void exitForCancellation("SIGTERM");
  },
};

function registerProviderTerminator(terminate: ProviderTerminator): () => void {
  if (activeProviderTerminators.size === 0) {
    for (const signal of Object.keys(
      cancellationHandlers,
    ) as CancellationSignal[]) {
      process.once(signal, cancellationHandlers[signal]);
    }
  }
  activeProviderTerminators.add(terminate);
  return () => {
    activeProviderTerminators.delete(terminate);
    if (activeProviderTerminators.size === 0) {
      for (const signal of Object.keys(
        cancellationHandlers,
      ) as CancellationSignal[]) {
        process.removeListener(signal, cancellationHandlers[signal]);
      }
    }
  };
}

interface CommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: unknown;
  timedOut: boolean;
  outputExceeded: boolean;
  aborted: boolean;
}

class AttemptFailure extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "AttemptFailure";
  }
}

function positiveInteger(
  value: number,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive safe integer <= ${maximum}`);
  }
  return value;
}

function nonnegativeInteger(
  value: number,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(
      `${name} must be a non-negative safe integer <= ${maximum}`,
    );
  }
  return value;
}

function markdownLimits(options: ScrapeOptions): {
  bytes: number;
  codePoints: number;
} {
  return {
    bytes: positiveInteger(
      options.maxMarkdownBytes ?? SCRAPECTL_DEFAULT_MARKDOWN_MAX_BYTES,
      "max markdown bytes",
    ),
    codePoints: positiveInteger(
      options.maxMarkdownCodePoints ??
        SCRAPECTL_DEFAULT_MARKDOWN_MAX_CODE_POINTS,
      "max markdown code points",
    ),
  };
}

function enforceMarkdownCap(
  markdown: string,
  limits: { bytes: number; codePoints: number },
): void {
  const bytes = Buffer.byteLength(markdown, "utf8");
  if (bytes > limits.bytes) {
    throw new Error(
      `scrapectl markdown exceeds max_bytes (${bytes} > ${limits.bytes})`,
    );
  }
  const points = codePointLength(markdown);
  if (points > limits.codePoints) {
    throw new Error(
      `scrapectl markdown exceeds max_code_points (${points} > ${limits.codePoints})`,
    );
  }
}

function envDelay(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) &&
    parsed >= SCRAPECTL_RETRY_ENV_MIN_MS &&
    parsed <= SCRAPECTL_RETRY_CONFIG_MAX_MS
    ? parsed
    : fallback;
}

function retrySettings(options: ScrapectlRetryOptions | undefined): {
  maxAttempts: number | undefined;
  initialDelayMs: number;
  maxDelayMs: number;
  sleep: (delayMs: number) => void | Promise<void>;
  writeDiagnostic: (message: string) => void;
} {
  const maxAttempts =
    options?.maxAttempts === undefined
      ? undefined
      : positiveInteger(options.maxAttempts, "retry max attempts");
  const initialDelayMs = nonnegativeInteger(
    options?.initialDelayMs ??
      envDelay(
        "AGENTBRAIN_SCRAPECTL_RETRY_INITIAL_MS",
        SCRAPECTL_RETRY_INITIAL_MS,
      ),
    "retry initial delay",
    SCRAPECTL_RETRY_CONFIG_MAX_MS,
  );
  const maxDelayMs = nonnegativeInteger(
    options?.maxDelayMs ??
      envDelay("AGENTBRAIN_SCRAPECTL_RETRY_MAX_MS", SCRAPECTL_RETRY_MAX_MS),
    "retry max delay",
    SCRAPECTL_RETRY_CONFIG_MAX_MS,
  );
  return {
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    sleep:
      options?.sleep ??
      ((delayMs) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        })),
    writeDiagnostic:
      options?.writeDiagnostic ??
      ((message) => {
        process.stderr.write(message);
      }),
  };
}

function runCommand(
  executable: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
  abortSignal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const useProcessGroup = process.platform !== "win32";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, {
        detached: useProcessGroup,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let aborted = false;
    let spawnError: unknown;
    let terminationStarted = false;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    let markChildClosed = (): void => {};
    const childClosed = new Promise<void>((resolveClosed) => {
      markChildClosed = resolveClosed;
    });

    const signalAttempt = (signal: NodeJS.Signals): void => {
      if (useProcessGroup && child.pid !== undefined) {
        let groupSignaled = false;
        try {
          process.kill(-child.pid, signal);
          groupSignaled = true;
        } catch {
          // The group may not have existed yet; the native fallback retries it.
        }
        // Bun has intermittently failed to deliver negative-PID group signals
        // on both hosted Linux and Darwin despite reporting success. A POSIX
        // shell kill reaches the same process-group contract through the OS.
        const nativeKill = spawnSync(
          "/bin/sh",
          [
            "-c",
            'kill -s "$1" -- "-$2"',
            "agentbrain-group-kill",
            signal.slice(3),
            String(child.pid),
          ],
          { stdio: "ignore" },
        );
        if (nativeKill.status === 0 || groupSignaled) return;
      }
      try {
        child.kill(signal);
      } catch {
        // The attempt has already exited.
      }
    };
    const terminateOnParentExit = async (): Promise<void> => {
      signalAttempt("SIGKILL");
      const retry = setInterval(() => signalAttempt("SIGKILL"), 25);
      try {
        await childClosed;
      } finally {
        clearInterval(retry);
        signalAttempt("SIGKILL");
      }
    };
    const unregisterProviderTerminator = registerProviderTerminator(
      terminateOnParentExit,
    );
    process.once("exit", terminateOnParentExit);

    const terminateAttempt = (): void => {
      if (terminationStarted) return;
      terminationStarted = true;
      signalAttempt("SIGTERM");
      escalationTimer = setTimeout(
        () => signalAttempt("SIGKILL"),
        SCRAPECTL_TERMINATION_GRACE_MS,
      );
    };
    const abortAttempt = (): void => {
      aborted = true;
      terminateAttempt();
    };
    abortSignal?.addEventListener("abort", abortAttempt, { once: true });
    if (abortSignal?.aborted) abortAttempt();
    const collect = (destination: Buffer[], chunk: Buffer | string): void => {
      if (outputExceeded) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > maxOutputBytes) {
        outputExceeded = true;
        terminateAttempt();
        return;
      }
      destination.push(buffer);
    };
    child.stdout?.on("data", (chunk) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk) => collect(stderr, chunk));
    child.on("error", (error) => {
      spawnError = error;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminateAttempt();
    }, timeoutMs);

    child.on("close", (status, signal) => {
      clearTimeout(timer);
      unregisterProviderTerminator();
      process.removeListener("exit", terminateOnParentExit);
      abortSignal?.removeEventListener("abort", abortAttempt);
      if (escalationTimer !== undefined) {
        clearTimeout(escalationTimer);
        // The direct process may exit while descendants still hold no pipes.
        signalAttempt("SIGKILL");
      }
      markChildClosed();
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        status,
        signal,
        ...(spawnError === undefined ? {} : { spawnError }),
        timedOut,
        outputExceeded,
        aborted,
      });
    });
  });
}

const PERMANENT_FAILURE_PATTERNS = [
  /\b(?:auth(?:entication|orization)?|login|credentials?)\s+(?:is\s+)?required\b/i,
  /\b(?:unauthorized|forbidden)\b/i,
  /\b(?:authentication|authorization)\s+(?:failed|denied)\b/i,
  /\binvalid\s+(?:api[-_ ]?key|credentials?|token)\b/i,
  /\b(?:400|401|403|404|410|413|415|422)\b/,
  /\b(?:invalid|unknown|unsupported|missing|bad)\s+(?:preset|input|url|argument|option|request)\b/i,
  /\b(?:preset|input|url|argument|option)\s+(?:is\s+)?invalid\b/i,
  /\b(?:content|document|response|payload|markdown).{0,40}(?:too large|exceeds|unsupported|empty|not found)\b/i,
  /\b(?:unsupported content|content not found|cannot extract|extraction failed)\b/i,
];

const TRANSIENT_FAILURE_PATTERNS = [
  /\bupstream down\b/i,
  /\bfailed to acquire browser from browserctl\b/i,
  /\b(?:agent-browser|browser(?:ctl)?).{0,60}\btimed out\b/i,
  /\b(?:scrapectl|browserctl|agent-browser|executable|binary|command).{0,60}\b(?:not found|missing)\b/i,
  /\bno such file or directory\b/i,
  /\b(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT)\b/i,
  /\bconnection\s+(?:was\s+)?(?:refused|reset|unreachable|timed out)\b/i,
  /\b(?:network|host)\s+(?:is\s+)?unreachable\b/i,
  /\bsocket hang up\b/i,
  /\b(?:backend|browser|upstream|provider|service|daemon).{0,60}\b(?:unavailable|down|offline|not running|unreachable|refused|reset)\b/i,
  /\b(?:failed|unable) to connect\b/i,
];

function transientCommandFailure(detail: string): boolean {
  if (PERMANENT_FAILURE_PATTERNS.some((pattern) => pattern.test(detail))) {
    return false;
  }
  return TRANSIENT_FAILURE_PATTERNS.some((pattern) => pattern.test(detail));
}

function commandErrorDetail(result: CommandResult): string {
  if (result.stderr.trim()) return result.stderr;
  return `scrapectl exited ${result.status ?? "without status"}`;
}

function providerFailure(detail: unknown, transient: boolean): AttemptFailure {
  const sanitized = sanitizeExternalError(detail);
  return new AttemptFailure(
    `scrapectl provider ${transient ? "unavailable" : "failed"}: ${sanitized}`,
    transient,
  );
}

async function scrapeAttempt(
  requestedUrl: string,
  timeoutMs: number,
  maxOutputBytes: number,
  limits: { bytes: number; codePoints: number },
): Promise<ScrapedLink> {
  const executable = findExecutable("scrapectl");
  if (!executable) {
    throw providerFailure("scrapectl is not installed on PATH", true);
  }
  const args = ["fetch-markdown", "--markdown", requestedUrl];

  let result: CommandResult;
  try {
    result = await runCommand(executable, args, timeoutMs, maxOutputBytes);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw providerFailure(error, code === "ENOENT");
  }
  if (result.outputExceeded) {
    throw providerFailure(
      `command output exceeds max_output_bytes (${maxOutputBytes})`,
      false,
    );
  }
  if (result.timedOut) {
    throw providerFailure(`command timed out after ${timeoutMs}ms`, true);
  }
  if (result.spawnError) {
    const code = (result.spawnError as NodeJS.ErrnoException).code;
    throw providerFailure(result.spawnError, code === "ENOENT");
  }
  if (result.signal) {
    throw providerFailure(`command terminated by ${result.signal}`, false);
  }
  if (result.status !== 0) {
    const detail = commandErrorDetail(result).replaceAll(requestedUrl, "[URL]");
    throw providerFailure(detail, transientCommandFailure(detail));
  }
  if (!result.stdout.trim()) {
    throw providerFailure("scrapectl returned empty markdown", false);
  }

  try {
    enforceMarkdownCap(result.stdout, limits);
  } catch (error) {
    throw providerFailure(error, false);
  }
  return {
    success: true,
    url: requestedUrl,
    requested_url: requestedUrl,
    markdown: result.stdout,
    content: result.stdout,
    size_chars: codePointLength(result.stdout),
  };
}

/** Invoke the sole URL-extraction provider, retrying only availability failures. */
export async function scrapeWithScrapectl(
  inputUrl: string,
  options: ScrapeOptions = {},
): Promise<ScrapedLink> {
  const requestedUrl = normalizedWebUrl(inputUrl);
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? SCRAPECTL_DEFAULT_TIMEOUT_MS,
    "scrapectl timeout",
    SCRAPECTL_TIMEOUT_MAX_MS,
  );
  const requestedOutputLimit = positiveInteger(
    options.maxOutputBytes ?? SCRAPECTL_OUTPUT_MAX_BYTES,
    "scrapectl max output bytes",
  );
  const maxOutputBytes = Math.min(
    requestedOutputLimit,
    SCRAPECTL_OUTPUT_MAX_BYTES,
  );
  const limits = markdownLimits(options);
  const retry = retrySettings(options.retry);

  let attempt = 1;
  let lastDiagnosticDelay: number | undefined;
  while (true) {
    try {
      return await scrapeAttempt(
        requestedUrl,
        timeoutMs,
        maxOutputBytes,
        limits,
      );
    } catch (error) {
      if (!(error instanceof AttemptFailure)) throw error;
      if (
        !error.transient ||
        (retry.maxAttempts !== undefined && attempt >= retry.maxAttempts)
      ) {
        throw new Error(error.message);
      }
      const exponent = Math.min(attempt - 1, 30);
      const delayMs = Math.min(
        retry.initialDelayMs * 2 ** exponent,
        retry.maxDelayMs,
      );
      if (delayMs !== lastDiagnosticDelay) {
        const diagnostic =
          `agentbrain: Scrapectl unavailable; retrying provider command ` +
          `(attempt ${attempt + 1}, delay ${delayMs}ms)\n`;
        try {
          retry.writeDiagnostic(diagnostic);
        } catch {
          // Diagnostics must never change provider retry behavior.
        }
        lastDiagnosticDelay = delayMs;
      }
      await retry.sleep(delayMs);
      attempt += 1;
    }
  }
}

const EXTRACTION_FAILURE_CLASSES = new Set<ExtractionFailureClass>([
  "invalid_request",
  "authentication_required",
  "upstream_unavailable",
  "timeout",
  "browser_error",
  "provider_error",
  "malformed_provider_output",
  "empty_content",
  "output_limit_exceeded",
  "cancelled",
  "internal_error",
]);

function protocolDefect(detail: string): never {
  throw new ScrapectlExtractionError(
    `scrapectl protocol defect: ${detail}`,
    "permanent",
    "protocol",
  );
}

function extractionRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return protocolDefect(`${name} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return protocolDefect(`${name} has unknown or missing fields`);
  }
  return record;
}

function extractionString(
  value: unknown,
  name: string,
  maximum: number,
  minimum = 0,
): string {
  if (typeof value !== "string") {
    return protocolDefect(`${name} must be text`);
  }
  const length = codePointLength(value);
  if (length < minimum || length > maximum) {
    return protocolDefect(`${name} is outside its size bound`);
  }
  return value;
}

function extractionUrl(value: unknown, name: string): string {
  const text = extractionString(value, name, 4096, 1);
  if (Buffer.byteLength(text, "utf8") > 4096) {
    return protocolDefect(`${name} is outside its byte bound`);
  }
  try {
    validateHttpUrl(text);
  } catch {
    return protocolDefect(`${name} is not an absolute HTTP(S) URL`);
  }
  return text;
}

function redactedComponentMatches(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  try {
    return decodeURIComponent(actual) === "[REDACTED]";
  } catch {
    return false;
  }
}

function requestEvidenceMatches(expected: string, actual: string): boolean {
  const left = validateHttpUrl(expected);
  const right = validateHttpUrl(actual);
  if (
    left.protocol.toLowerCase() !== right.protocol.toLowerCase() ||
    left.hostname.toLowerCase() !== right.hostname.toLowerCase() ||
    left.port !== right.port
  ) {
    return false;
  }
  const leftPath = left.pathname.split("/");
  const rightPath = right.pathname.split("/");
  if (
    leftPath.length !== rightPath.length ||
    leftPath.some(
      (part, index) => !redactedComponentMatches(part, rightPath[index] ?? ""),
    )
  ) {
    return false;
  }
  const leftQuery = [...left.searchParams.entries()];
  const rightQuery = [...right.searchParams.entries()];
  return (
    leftQuery.length === rightQuery.length &&
    leftQuery.every(([name, value], index) => {
      const other = rightQuery[index];
      return (
        other !== undefined &&
        name === other[0] &&
        redactedComponentMatches(value, other[1])
      );
    })
  );
}

function parseExtractor(value: unknown): ExtractorIdentity {
  const record = extractionRecord(
    value,
    ["name", "version", "implementation", "implementation_version"],
    "extractor",
  );
  if (record.name !== "scrapectl") {
    return protocolDefect("extractor name is unsupported");
  }
  return {
    name: "scrapectl",
    version: extractionString(record.version, "extractor version", 100),
    implementation: extractionString(
      record.implementation,
      "extractor implementation",
      100,
    ),
    implementation_version: extractionString(
      record.implementation_version,
      "extractor implementation version",
      100,
    ),
  };
}

function parseMetadata(value: unknown): ExtractionMetadata {
  const record = extractionRecord(
    value,
    [
      "content_type",
      "title",
      "author_name",
      "author_handle",
      "published_at",
      "source_id",
      "warnings",
    ],
    "extraction metadata",
  );
  if (
    !new Set(["web_page", "social_post", "article"]).has(
      String(record.content_type),
    )
  ) {
    return protocolDefect("metadata content type is unsupported");
  }
  if (!Array.isArray(record.warnings) || record.warnings.length > 8) {
    return protocolDefect("metadata warnings are invalid");
  }
  if (record.warnings.some((warning) => warning !== "partial_content")) {
    return protocolDefect("metadata warning is unsupported");
  }
  return {
    content_type: record.content_type as ExtractionMetadata["content_type"],
    title: extractionString(record.title, "metadata title", 500),
    author_name: extractionString(record.author_name, "metadata author", 200),
    author_handle: extractionString(
      record.author_handle,
      "metadata author handle",
      100,
    ),
    published_at: extractionString(
      record.published_at,
      "metadata publication time",
      100,
    ),
    source_id: extractionString(record.source_id, "metadata source id", 200),
    warnings: record.warnings as Array<"partial_content">,
  };
}

const EXTRACTION_RELATION_TYPES = new Set<ExtractionRelation["relation_type"]>([
  "references",
  "content_link",
  "article",
  "quoted_post",
]);

function parseRelations(value: unknown, maximum: number): ExtractionRelation[] {
  if (!Array.isArray(value) || value.length > maximum) {
    return protocolDefect("extraction relations are invalid");
  }
  return value.map((item) => {
    const record = extractionRecord(
      item,
      ["relation_type", "target_url"],
      "extraction relation",
    );
    if (
      typeof record.relation_type !== "string" ||
      !EXTRACTION_RELATION_TYPES.has(
        record.relation_type as ExtractionRelation["relation_type"],
      )
    ) {
      return protocolDefect("extraction relation type is unsupported");
    }
    return {
      relation_type:
        record.relation_type as ExtractionRelation["relation_type"],
      target_url: extractionUrl(record.target_url, "relation target URL"),
    };
  });
}

function parseFailureDetail(value: unknown): ExtractionFailureDetail {
  const record = extractionRecord(
    value,
    ["failure_class", "retryable", "message", "evidence"],
    "extraction failure",
  );
  if (
    typeof record.failure_class !== "string" ||
    !EXTRACTION_FAILURE_CLASSES.has(
      record.failure_class as ExtractionFailureClass,
    )
  ) {
    return protocolDefect("extraction failure class is unsupported");
  }
  if (typeof record.retryable !== "boolean") {
    return protocolDefect("extraction retry advice is invalid");
  }
  return {
    failure_class: record.failure_class as ExtractionFailureClass,
    retryable: record.retryable,
    message: extractionString(
      record.message,
      "extraction failure message",
      200,
    ),
    evidence: extractionString(
      record.evidence,
      "extraction failure evidence",
      1024,
      1,
    ),
  };
}

export function validateExtractionEnvelope(
  value: unknown,
  expectedUrl: string,
  options: { maxContentBytes?: number; maxRelations?: number } = {},
): ExtractionEnvelope {
  const maxContentBytes = positiveInteger(
    options.maxContentBytes ?? SCRAPECTL_DEFAULT_MARKDOWN_MAX_BYTES,
    "max extraction content bytes",
    SCRAPECTL_DEFAULT_MARKDOWN_MAX_BYTES,
  );
  const maxRelations = nonnegativeInteger(
    options.maxRelations ?? SCRAPECTL_DEFAULT_MAX_RELATIONS,
    "max extraction relations",
    SCRAPECTL_DEFAULT_MAX_RELATIONS,
  );
  const record = extractionRecord(
    value,
    [
      "schema_version",
      "status",
      "requested_url",
      "final_url",
      "extractor",
      "artifacts",
      "metadata",
      "relations",
      "failure",
    ],
    "extraction envelope",
  );
  if (record.schema_version !== SCRAPECTL_EXTRACTION_SCHEMA_VERSION) {
    return protocolDefect("extraction schema version is unsupported");
  }
  const requestedUrl = extractionUrl(
    record.requested_url,
    "extraction requested URL",
  );
  if (!requestEvidenceMatches(expectedUrl, requestedUrl)) {
    return protocolDefect("extraction requested URL does not match the job");
  }
  const extractor = parseExtractor(record.extractor);

  if (record.status === "success") {
    const finalUrl = extractionUrl(record.final_url, "extraction final URL");
    if (!Array.isArray(record.artifacts) || record.artifacts.length !== 1) {
      return protocolDefect("successful extraction must contain one artifact");
    }
    const artifactRecord = extractionRecord(
      record.artifacts[0],
      [
        "artifact_type",
        "media_type",
        "encoding",
        "content",
        "size_bytes",
        "sha256",
      ],
      "extraction artifact",
    );
    if (
      artifactRecord.artifact_type !== "document" ||
      artifactRecord.media_type !== "text/markdown" ||
      artifactRecord.encoding !== "utf-8"
    ) {
      return protocolDefect("extraction artifact descriptor is unsupported");
    }
    const content = extractionString(
      artifactRecord.content,
      "extraction content",
      maxContentBytes,
      1,
    );
    if (!content.trim()) {
      return protocolDefect("successful extraction content is empty");
    }
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (contentBytes > maxContentBytes) {
      return protocolDefect("extraction content exceeds its byte bound");
    }
    if (
      !Number.isSafeInteger(artifactRecord.size_bytes) ||
      artifactRecord.size_bytes !== contentBytes
    ) {
      return protocolDefect("extraction artifact size does not match content");
    }
    if (
      typeof artifactRecord.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(artifactRecord.sha256) ||
      createHash("sha256").update(content, "utf8").digest("hex") !==
        artifactRecord.sha256
    ) {
      return protocolDefect(
        "extraction artifact digest does not match content",
      );
    }
    if (record.failure !== null) {
      return protocolDefect("successful extraction contains failure details");
    }
    const metadata = parseMetadata(record.metadata);
    const relations = parseRelations(record.relations, maxRelations);
    return {
      schema_version: "1",
      status: "success",
      requested_url: requestedUrl,
      final_url: finalUrl,
      extractor,
      artifacts: [
        {
          artifact_type: "document",
          media_type: "text/markdown",
          encoding: "utf-8",
          content,
          size_bytes: contentBytes,
          sha256: artifactRecord.sha256,
        },
      ],
      metadata,
      relations,
      failure: null,
    };
  }

  if (record.status !== "failure") {
    return protocolDefect("extraction status is unsupported");
  }
  if (
    !Array.isArray(record.artifacts) ||
    record.artifacts.length !== 0 ||
    record.metadata !== null ||
    !Array.isArray(record.relations) ||
    record.relations.length !== 0
  ) {
    return protocolDefect("failed extraction contains success data");
  }
  const finalUrl =
    record.final_url === null
      ? null
      : extractionUrl(record.final_url, "extraction final URL");
  return {
    schema_version: "1",
    status: "failure",
    requested_url: requestedUrl,
    final_url: finalUrl,
    extractor,
    artifacts: [],
    metadata: null,
    relations: [],
    failure: parseFailureDetail(record.failure),
  };
}

function envelopeFailure(detail: ExtractionFailureDetail): never {
  const summary = sanitizeExternalError(
    `${detail.message}: ${detail.evidence}`,
  );
  const message = `scrapectl extraction failed (${detail.failure_class}): ${summary}`;
  if (detail.failure_class === "cancelled") {
    throw new ScrapectlExtractionError(message, "cancelled", "cancellation");
  }
  if (detail.failure_class === "authentication_required") {
    throw new ScrapectlExtractionError(message, "auth_config", "auth_config");
  }
  if (detail.failure_class === "invalid_request") {
    throw new ScrapectlExtractionError(message, "permanent", "policy");
  }
  if (
    detail.retryable &&
    new Set([
      "timeout",
      "browser_error",
      "provider_error",
      "upstream_unavailable",
    ]).has(detail.failure_class)
  ) {
    throw new ScrapectlExtractionError(message, "item_transient", "item");
  }
  throw new ScrapectlExtractionError(message, "permanent", "permanent");
}

export async function extractWithScrapectl(
  inputUrl: string,
  options: ExtractionOptions = {},
): Promise<ExtractionSuccess> {
  const requestedUrl = normalizedWebUrl(inputUrl);
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? SCRAPECTL_DEFAULT_TIMEOUT_MS,
    "scrapectl timeout",
    SCRAPECTL_TIMEOUT_MAX_MS,
  );
  const maxContentBytes = positiveInteger(
    options.maxContentBytes ?? SCRAPECTL_DEFAULT_MARKDOWN_MAX_BYTES,
    "scrapectl max content bytes",
    SCRAPECTL_DEFAULT_MARKDOWN_MAX_BYTES,
  );
  const maxRelations = nonnegativeInteger(
    options.maxRelations ?? SCRAPECTL_DEFAULT_MAX_RELATIONS,
    "scrapectl max relations",
    SCRAPECTL_DEFAULT_MAX_RELATIONS,
  );
  const maxOutputBytes = Math.min(
    positiveInteger(
      options.maxOutputBytes ?? SCRAPECTL_OUTPUT_MAX_BYTES,
      "scrapectl max output bytes",
    ),
    SCRAPECTL_OUTPUT_MAX_BYTES,
  );
  if (options.signal?.aborted) {
    throw new ScrapectlExtractionError(
      "scrapectl extraction was cancelled",
      "cancelled",
      "cancellation",
    );
  }
  const executable = findExecutable("scrapectl");
  if (executable === null) {
    throw new ScrapectlExtractionError(
      "scrapectl extraction infrastructure is unavailable",
      "infra",
      "infrastructure",
    );
  }
  const args = [
    "fetch-markdown",
    requestedUrl,
    "--envelope",
    "--max-content-bytes",
    String(maxContentBytes),
    "--max-relations",
    String(maxRelations),
  ];

  let result: CommandResult;
  try {
    result = await runCommand(
      executable,
      args,
      timeoutMs,
      maxOutputBytes,
      options.signal,
    );
  } catch (error) {
    throw new ScrapectlExtractionError(
      `scrapectl extraction infrastructure failed: ${sanitizeExternalError(error)}`,
      "infra",
      "infrastructure",
    );
  }
  if (result.aborted) {
    throw new ScrapectlExtractionError(
      "scrapectl extraction was cancelled",
      "cancelled",
      "cancellation",
    );
  }
  if (result.outputExceeded) {
    return protocolDefect("extraction command output exceeded its bound");
  }
  if (result.timedOut) {
    throw new ScrapectlExtractionError(
      `scrapectl extraction timed out after ${timeoutMs}ms`,
      "item_transient",
      "item",
    );
  }
  if (result.spawnError !== undefined) {
    throw new ScrapectlExtractionError(
      `scrapectl extraction infrastructure failed: ${sanitizeExternalError(result.spawnError)}`,
      "infra",
      "infrastructure",
    );
  }
  if (result.signal !== null) {
    const cancelled = new Set(["SIGHUP", "SIGINT", "SIGTERM"]).has(
      result.signal,
    );
    throw new ScrapectlExtractionError(
      `scrapectl extraction terminated by ${result.signal}`,
      cancelled ? "cancelled" : "infra",
      cancelled ? "cancellation" : "infrastructure",
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(result.stdout) as unknown;
  } catch {
    return protocolDefect("extraction command returned malformed JSON");
  }
  const envelope = validateExtractionEnvelope(decoded, requestedUrl, {
    maxContentBytes,
    maxRelations,
  });
  if (envelope.status === "success") {
    if (result.status !== 0) {
      return protocolDefect("successful extraction exited nonzero");
    }
    return envelope;
  }
  if (result.status === 0) {
    return protocolDefect("failed extraction exited successfully");
  }
  return envelopeFailure(envelope.failure);
}
