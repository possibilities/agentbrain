import { spawn } from "node:child_process";
import { findExecutable } from "./executable";
import { sanitizeExternalError } from "./sanitize";
import { codePointLength } from "./text";
import { normalizedWebUrl } from "./url";

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

type CancellationSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

type ProviderTerminator = () => void;

const activeProviderTerminators = new Set<ProviderTerminator>();
const CANCELLATION_EXIT_CODES: Record<CancellationSignal, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

function exitForCancellation(signal: CancellationSignal): never {
  for (const terminate of [...activeProviderTerminators]) {
    try {
      terminate();
    } catch {
      // Cancellation cleanup is best effort; the parent must still exit.
    }
  }
  process.exit(CANCELLATION_EXIT_CODES[signal]);
}

const cancellationHandlers: Record<CancellationSignal, () => never> = {
  SIGHUP: () => exitForCancellation("SIGHUP"),
  SIGINT: () => exitForCancellation("SIGINT"),
  SIGTERM: () => exitForCancellation("SIGTERM"),
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
    let spawnError: unknown;
    let terminationStarted = false;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;

    const signalAttempt = (signal: NodeJS.Signals): void => {
      if (useProcessGroup && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall through if the child failed before its process group existed.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // The attempt has already exited.
      }
    };
    const terminateOnParentExit = (): void => signalAttempt("SIGKILL");
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
      if (escalationTimer !== undefined) {
        clearTimeout(escalationTimer);
        // The direct process may exit while descendants still hold no pipes.
        signalAttempt("SIGKILL");
      }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        status,
        signal,
        ...(spawnError === undefined ? {} : { spawnError }),
        timedOut,
        outputExceeded,
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
