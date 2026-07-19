import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractWithScrapectl,
  ScrapectlExtractionError,
  scrapeWithScrapectl,
  validateExtractionEnvelope,
} from "../src/scrapectl";

const dirs: string[] = [];
const originalPath = process.env.PATH;
const originalInitialDelay = process.env.AGENTBRAIN_SCRAPECTL_RETRY_INITIAL_MS;
const originalMaxDelay = process.env.AGENTBRAIN_SCRAPECTL_RETRY_MAX_MS;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalInitialDelay === undefined) {
    delete process.env.AGENTBRAIN_SCRAPECTL_RETRY_INITIAL_MS;
  } else {
    process.env.AGENTBRAIN_SCRAPECTL_RETRY_INITIAL_MS = originalInitialDelay;
  }
  if (originalMaxDelay === undefined) {
    delete process.env.AGENTBRAIN_SCRAPECTL_RETRY_MAX_MS;
  } else {
    process.env.AGENTBRAIN_SCRAPECTL_RETRY_MAX_MS = originalMaxDelay;
  }
  delete process.env.LOG;
  delete process.env.COUNT_FILE;
  delete process.env.CHILD_PID_FILE;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentbrain-scrapectl-"));
  dirs.push(dir);
  return dir;
}

function executablePath(dir: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  process.env.PATH = `${bin}:${originalPath}`;
  return join(bin, "scrapectl");
}

function writeExecutable(path: string, script: string): void {
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function installScrapectl(script: string): { dir: string; executable: string } {
  const dir = tempDir();
  const executable = executablePath(dir);
  writeExecutable(executable, script);
  return { dir, executable };
}

function extractionEnvelope(
  requestedUrl: string,
  content = "# Extracted\n\nBody",
): Record<string, unknown> {
  return {
    schema_version: "1",
    status: "success",
    requested_url: requestedUrl,
    final_url: `${requestedUrl}/final`,
    extractor: {
      name: "scrapectl",
      version: "1.2.3",
      implementation: "generic-page",
      implementation_version: "1",
    },
    artifacts: [
      {
        artifact_type: "document",
        media_type: "text/markdown",
        encoding: "utf-8",
        content,
        size_bytes: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ],
    metadata: {
      content_type: "web_page",
      title: "Extracted",
      author_name: "",
      author_handle: "",
      published_at: "",
      source_id: "",
      warnings: [],
    },
    relations: [
      {
        relation_type: "content_link",
        target_url: "https://reference.example/item",
      },
    ],
    failure: null,
  };
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const SCRAPECTL_CONTRACT_FIXTURE =
  process.env.SCRAPECTL_CONTRACT_FIXTURE ??
  "/Users/mike/code/arthack/apps/scrapectl/tests/fixtures/extraction-generic.expected.json";

function assertCompatibleFixture(
  label: string,
  path: string,
  expectedUrl: string,
): void {
  if (!existsSync(path)) {
    throw new Error(`${label} contract fixture is missing: ${path}`);
  }
  const payload = JSON.parse(readFileSync(path, "utf8")) as unknown;
  try {
    const envelope = validateExtractionEnvelope(payload, expectedUrl);
    expect(envelope.status).toBe("success");
  } catch (error) {
    throw new Error(
      `${label} contract fixture is incompatible with Agentbrain: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

test("recorded Scrapectl extraction fixtures match Agentbrain's envelope contract", () => {
  assertCompatibleFixture(
    "Scrapectl generic",
    SCRAPECTL_CONTRACT_FIXTURE,
    "https://example.com/start",
  );
  assertCompatibleFixture(
    "Agentbrain X post",
    join(import.meta.dir, "fixtures", "prescraped_x_tweet.json"),
    "https://twitter.com/original_handle/status/123?ref=timeline",
  );
  assertCompatibleFixture(
    "Agentbrain X article",
    join(import.meta.dir, "fixtures", "prescraped_x_article.json"),
    "https://twitter.com/writer/article/987?utm_source=timeline",
  );
});

test("incompatible extraction envelope changes are protocol defects", () => {
  const url = "https://example.com/contract";
  const base = extractionEnvelope(url);
  const missingFailure = { ...base };
  delete (missingFailure as Record<string, unknown>).failure;
  const cases: Array<[string, Record<string, unknown>, string]> = [
    [
      "schema version",
      { ...base, schema_version: "2" },
      "extraction schema version is unsupported",
    ],
    [
      "provider fields",
      { ...base, status_code: 200 },
      "extraction envelope has unknown or missing fields",
    ],
    [
      "extractor identity",
      {
        ...base,
        extractor: {
          ...(base.extractor as Record<string, unknown>),
          name: "browserctl",
        },
      },
      "extractor name is unsupported",
    ],
    [
      "missing failure sentinel",
      missingFailure,
      "extraction envelope has unknown or missing fields",
    ],
  ];
  for (const [label, payload, message] of cases) {
    try {
      expect(() => validateExtractionEnvelope(payload, url)).toThrow(
        `scrapectl protocol defect: ${message}`,
      );
    } catch (error) {
      throw new Error(
        `${label} did not fail as a clear protocol defect: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
});

test("versioned extraction uses explicit argv and validates the success envelope", async () => {
  const url = "https://example.com/article";
  const envelope = extractionEnvelope(url);
  const { dir } = installScrapectl(`#!/bin/sh
printf '%s\\n' "$@" > "$LOG"
printf '%s' ${shellLiteral(JSON.stringify(envelope))}
`);
  const log = join(dir, "extraction-argv.txt");
  process.env.LOG = log;

  const result = await extractWithScrapectl(url, {
    maxContentBytes: 1000,
    maxRelations: 3,
  });

  expect(readFileSync(log, "utf8")).toBe(
    "fetch-markdown\nhttps://example.com/article\n--envelope\n--max-content-bytes\n1000\n--max-relations\n3\n",
  );
  expect(result).toMatchObject({
    status: "success",
    final_url: "https://example.com/article/final",
    metadata: { title: "Extracted" },
  });
});

test("classified extraction failures map without parsing stderr", async () => {
  const url = "https://example.com/failure";
  const { executable } = installScrapectl("#!/bin/sh\nexit 1\n");
  const cases = [
    ["upstream_unavailable", true, "item_transient", "item", 1],
    ["authentication_required", false, "auth_config", "auth_config", 2],
    ["provider_error", false, "permanent", "permanent", 1],
    ["invalid_request", false, "permanent", "policy", 1],
    ["cancelled", false, "cancelled", "cancellation", 130],
  ] as const;

  for (const [
    failureClass,
    retryable,
    disposition,
    outcome,
    exitCode,
  ] of cases) {
    const envelope = {
      ...extractionEnvelope(url),
      status: "failure",
      final_url: null,
      artifacts: [],
      metadata: null,
      relations: [],
      failure: {
        failure_class: failureClass,
        retryable,
        message: "classified failure",
        evidence: "Cookie: secret-value",
      },
    };
    writeExecutable(
      executable,
      `#!/bin/sh\nprintf '%s\\n' 'stderr must not classify this' >&2\nprintf '%s' ${shellLiteral(JSON.stringify(envelope))}\nexit ${exitCode}\n`,
    );
    let caught: unknown;
    try {
      await extractWithScrapectl(url);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ScrapectlExtractionError);
    expect(caught).toMatchObject({ disposition, outcome });
    expect(String(caught)).not.toContain("secret-value");
    expect(String(caught)).not.toContain("stderr must not classify");
  }
});

test("malformed and unknown envelopes are visible protocol defects", async () => {
  const { executable } = installScrapectl(`#!/bin/sh
printf '%s' '{"schema_version":"99"}'
`);
  await expect(
    extractWithScrapectl("https://example.com/protocol"),
  ).rejects.toMatchObject({ disposition: "permanent", outcome: "protocol" });

  writeExecutable(executable, "#!/bin/sh\nprintf '%s' 'not-json'\n");
  await expect(
    extractWithScrapectl("https://example.com/protocol"),
  ).rejects.toThrow("protocol defect");

  const url = "https://example.com/unsupported-relation";
  const unsupported = {
    ...extractionEnvelope(url),
    relations: [
      {
        relation_type: "reply",
        target_url: "https://x.com/i/status/123",
      },
    ],
  };
  writeExecutable(
    executable,
    `#!/bin/sh\nprintf '%s' ${shellLiteral(JSON.stringify(unsupported))}\n`,
  );
  await expect(extractWithScrapectl(url)).rejects.toThrow(
    "relation type is unsupported",
  );
});

test("Scrapectl adapter resolves PATH and requests final Markdown with explicit argv", async () => {
  const { dir } = installScrapectl(`#!/bin/sh
printf '%s\n' "$@" > "$LOG"
printf '%s\n' '# Provider markdown'
`);
  const log = join(dir, "argv.txt");
  process.env.LOG = log;

  const result = await scrapeWithScrapectl(
    "https://twitter.com/person/status/123?from=request#section",
    { maxMarkdownBytes: 1000, maxMarkdownCodePoints: 1000 },
  );

  expect(readFileSync(log, "utf8")).toBe(
    "fetch-markdown\n--markdown\nhttps://twitter.com/person/status/123?from=request\n",
  );
  expect(result).toMatchObject({
    url: "https://twitter.com/person/status/123?from=request",
    requested_url: "https://twitter.com/person/status/123?from=request",
    markdown: "# Provider markdown\n",
  });
});

test("Scrapectl Markdown stdout is accepted without provider-schema parsing", async () => {
  installScrapectl(`#!/bin/sh
printf '%s\n' '# Article title' '' 'Final **Markdown** from Scrapectl.'
`);

  const result = await scrapeWithScrapectl("https://example.com/article");
  expect(result.markdown).toBe(
    "# Article title\n\nFinal **Markdown** from Scrapectl.\n",
  );
  expect(result.content).toBe(result.markdown);
});

test("transient provider failures retry with bounded exponential delays and resume", async () => {
  const { dir } = installScrapectl(`#!/bin/sh
count=0
if [ -f "$COUNT_FILE" ]; then count=$(cat "$COUNT_FILE"); fi
count=$((count + 1))
printf '%s' "$count" > "$COUNT_FILE"
if [ "$count" -eq 1 ]; then
  printf '%s\n' 'failed to acquire browser from browserctl' >&2
  exit 7
fi
if [ "$count" -eq 2 ]; then
  printf '%s\n' 'browser backend unavailable token=retry-secret' >&2
  exit 7
fi
printf '%s\n' 'resumed markdown'
`);
  const countFile = join(dir, "count");
  process.env.COUNT_FILE = countFile;
  const delays: number[] = [];
  const diagnostics: string[] = [];

  const result = await scrapeWithScrapectl("https://example.com/resumed", {
    retry: {
      maxAttempts: 4,
      initialDelayMs: 5,
      maxDelayMs: 8,
      sleep: (delay) => {
        delays.push(delay);
      },
      writeDiagnostic: (message) => diagnostics.push(message),
    },
  });

  expect(result.markdown).toBe("resumed markdown\n");
  expect(readFileSync(countFile, "utf8")).toBe("3");
  expect(delays).toEqual([5, 8]);
  expect(diagnostics).toHaveLength(2);
  expect(diagnostics.join(" ")).not.toContain("retry-secret");
  expect(diagnostics.join(" ")).not.toContain("token=");
  expect(diagnostics.join(" ")).not.toContain("backend unavailable");
});

test("retry delay environment overrides are bounded away from hot loops and overflow", async () => {
  const dir = tempDir();
  process.env.PATH = join(dir, "missing-bin");
  process.env.AGENTBRAIN_SCRAPECTL_RETRY_INITIAL_MS = "0";
  process.env.AGENTBRAIN_SCRAPECTL_RETRY_MAX_MS = "999999999999999999999";
  const fallbackDelays: number[] = [];

  await expect(
    scrapeWithScrapectl("https://example.com/down", {
      retry: {
        maxAttempts: 2,
        sleep: (delay) => {
          fallbackDelays.push(delay);
        },
        writeDiagnostic: () => {},
      },
    }),
  ).rejects.toThrow("not installed on PATH");
  expect(fallbackDelays).toEqual([1000]);

  process.env.AGENTBRAIN_SCRAPECTL_RETRY_INITIAL_MS = "100";
  process.env.AGENTBRAIN_SCRAPECTL_RETRY_MAX_MS = "3600000";
  const configuredDelays: number[] = [];
  await expect(
    scrapeWithScrapectl("https://example.com/down", {
      retry: {
        maxAttempts: 2,
        sleep: (delay) => {
          configuredDelays.push(delay);
        },
        writeDiagnostic: () => {},
      },
    }),
  ).rejects.toThrow("not installed on PATH");
  expect(configuredDelays).toEqual([100]);
});

test("a real Scrapectl agent-browser timeout is retried", async () => {
  const { dir } = installScrapectl(`#!/bin/sh
count=0
if [ -f "$COUNT_FILE" ]; then count=$(cat "$COUNT_FILE"); fi
count=$((count + 1))
printf '%s' "$count" > "$COUNT_FILE"
if [ "$count" -eq 1 ]; then
  printf '%s\n' 'Browser error: agent-browser timed out after 30s' >&2
  exit 1
fi
printf '%s\n' 'recovered after browser timeout'
`);
  const countFile = join(dir, "count");
  process.env.COUNT_FILE = countFile;
  const delays: number[] = [];

  const result = await scrapeWithScrapectl("https://example.com/timeout", {
    retry: {
      maxAttempts: 2,
      initialDelayMs: 7,
      maxDelayMs: 7,
      sleep: (delay) => {
        delays.push(delay);
      },
      writeDiagnostic: () => {},
    },
  });
  expect(result.markdown).toBe("recovered after browser timeout\n");
  expect(readFileSync(countFile, "utf8")).toBe("2");
  expect(delays).toEqual([7]);
});

test("an executable initially absent is found on a later retry", async () => {
  const dir = tempDir();
  const executable = executablePath(dir);
  process.env.PATH = join(dir, "bin");
  const delays: number[] = [];

  const result = await scrapeWithScrapectl("https://example.com/appeared", {
    retry: {
      maxAttempts: 2,
      initialDelayMs: 0,
      maxDelayMs: 0,
      sleep: async (delay) => {
        delays.push(delay);
        writeExecutable(
          executable,
          "#!/bin/sh\nprintf '%s\\n' 'provider appeared'\n",
        );
        await Bun.sleep(1);
      },
      writeDiagnostic: () => {},
    },
  });

  expect(result.markdown).toBe("provider appeared\n");
  expect(delays).toEqual([0]);
});

test("permanent auth and input failures do not retry", async () => {
  const { dir } = installScrapectl(`#!/bin/sh
printf x >> "$COUNT_FILE"
printf '%s\n' 'authentication required: Authorization: Bearer top.secret' >&2
exit 7
`);
  const countFile = join(dir, "count");
  process.env.COUNT_FILE = countFile;
  const delays: number[] = [];

  await expect(
    scrapeWithScrapectl("https://example.com/failure", {
      retry: {
        maxAttempts: 5,
        sleep: (delay) => {
          delays.push(delay);
        },
        writeDiagnostic: () => {},
      },
    }),
  ).rejects.toThrow("scrapectl provider failed");
  expect(readFileSync(countFile, "utf8")).toBe("x");
  expect(delays).toEqual([]);

  writeExecutable(
    join(dir, "bin", "scrapectl"),
    `#!/bin/sh\nprintf x >> "$COUNT_FILE"\nprintf '%s\\n' 'invalid input URL' >&2\nexit 2\n`,
  );
  await expect(
    scrapeWithScrapectl("https://example.com/failure", {
      retry: { maxAttempts: 5, sleep: () => {}, writeDiagnostic: () => {} },
    }),
  ).rejects.toThrow("invalid input");
  expect(readFileSync(countFile, "utf8")).toBe("xx");
});

test("per-attempt timeout is transient and obeys the injected attempt cap", async () => {
  const { dir } = installScrapectl(`#!/bin/sh
printf x >> "$COUNT_FILE"
exec sleep 1
`);
  const countFile = join(dir, "count");
  process.env.COUNT_FILE = countFile;
  const delays: number[] = [];

  await expect(
    scrapeWithScrapectl("https://example.com/slow", {
      timeoutMs: 1_000,
      retry: {
        maxAttempts: 2,
        initialDelayMs: 1,
        maxDelayMs: 1,
        sleep: (delay) => {
          delays.push(delay);
        },
        writeDiagnostic: () => {},
      },
    }),
  ).rejects.toThrow("timed out");
  expect(readFileSync(countFile, "utf8")).toBe("xx");
  expect(delays).toEqual([1]);
});

test("provider timeout terminates the Scrapectl process group", async () => {
  const { dir } = installScrapectl(`#!/bin/sh
sh -c 'trap "" TERM; exec sleep 30' &
printf '%s' "$!" > "$CHILD_PID_FILE"
wait
`);
  const pidFile = join(dir, "child.pid");
  process.env.CHILD_PID_FILE = pidFile;

  await expect(
    scrapeWithScrapectl("https://example.com/process-tree", {
      timeoutMs: 500,
      retry: { maxAttempts: 1, writeDiagnostic: () => {} },
    }),
  ).rejects.toThrow("timed out");

  const descendantPid = Number(readFileSync(pidFile, "utf8"));
  expect(Number.isInteger(descendantPid)).toBe(true);
  let alive = true;
  for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
    try {
      process.kill(descendantPid, 0);
      await Bun.sleep(10);
    } catch {
      alive = false;
    }
  }
  if (alive) {
    try {
      process.kill(descendantPid, "SIGKILL");
    } catch {
      // It exited between the final probe and cleanup.
    }
  }
  expect(alive).toBe(false);
});

test("extraction abort kills detached Scrapectl descendants", async () => {
  if (process.platform === "win32") return;
  const { dir } = installScrapectl(`#!/bin/sh
sh -c 'trap "" HUP INT TERM; exec sleep 30' &
printf '%s' "$!" > "$CHILD_PID_FILE"
wait
`);
  const pidFile = join(dir, "extraction-child.pid");
  process.env.CHILD_PID_FILE = pidFile;
  const controller = new AbortController();
  const pending = extractWithScrapectl("https://example.com/cancel", {
    signal: controller.signal,
    timeoutMs: 30_000,
  });

  for (let attempt = 0; attempt < 1_000 && !existsSync(pidFile); attempt += 1) {
    await Bun.sleep(10);
  }
  if (!existsSync(pidFile)) {
    controller.abort();
    await pending.catch(() => {});
    throw new Error(
      "provider fixture did not start for extraction cancellation",
    );
  }
  const descendantPid = Number(readFileSync(pidFile, "utf8"));
  controller.abort();
  await expect(pending).rejects.toMatchObject({
    disposition: "cancelled",
    outcome: "cancellation",
  });

  let alive = true;
  for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
    try {
      process.kill(descendantPid, 0);
      await Bun.sleep(10);
    } catch {
      alive = false;
    }
  }
  if (alive) {
    try {
      process.kill(descendantPid, "SIGKILL");
    } catch {
      // It exited between the final probe and cleanup.
    }
  }
  expect(alive).toBe(false);
}, 10_000);

test("parent cancellation kills detached Scrapectl descendants and preserves signal exits", async () => {
  if (process.platform === "win32") return;
  const { dir } = installScrapectl(`#!/bin/sh
sh -c 'trap "" HUP INT TERM; exec sleep 30' &
printf '%s' "$!" > "$CHILD_PID_FILE"
wait
`);

  const parentScript = join(dir, "provider-parent.ts");
  writeFileSync(
    parentScript,
    `import { scrapeWithScrapectl } from ${JSON.stringify(join(import.meta.dir, "..", "src", "scrapectl.ts"))};\nawait scrapeWithScrapectl("https://example.com/cancel");\n`,
  );

  for (const [signal, expectedExitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    const pidFile = join(dir, `${signal}.pid`);
    process.env.CHILD_PID_FILE = pidFile;
    const parent = Bun.spawn({
      cmd: ["bun", parentScript],
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, PATH: process.env.PATH },
      stdout: "ignore",
      stderr: "pipe",
    });

    for (
      let attempt = 0;
      attempt < 1_000 && !existsSync(pidFile);
      attempt += 1
    ) {
      await Bun.sleep(10);
    }
    if (!existsSync(pidFile)) {
      parent.kill("SIGKILL");
      await parent.exited;
      throw new Error(`provider fixture did not start for ${signal}`);
    }
    const descendantPid = Number(readFileSync(pidFile, "utf8"));
    parent.kill(signal);
    const exitCode = await parent.exited;

    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
      try {
        process.kill(descendantPid, 0);
        await Bun.sleep(10);
      } catch {
        alive = false;
      }
    }
    if (alive) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // It exited between the final probe and cleanup.
      }
    }
    expect(exitCode).toBe(expectedExitCode);
    expect(alive).toBe(false);
  }
}, 20_000);

test("empty and oversized Markdown plus oversized command output fail without retry", async () => {
  const { dir, executable } = installScrapectl(`#!/bin/sh
printf x >> "$COUNT_FILE"
printf '   '
`);
  const countFile = join(dir, "count");
  process.env.COUNT_FILE = countFile;
  const retry = {
    maxAttempts: 4,
    sleep: () => {},
    writeDiagnostic: () => {},
  };

  await expect(
    scrapeWithScrapectl("https://example.com/empty", { retry }),
  ).rejects.toThrow("empty markdown");
  expect(readFileSync(countFile, "utf8")).toBe("x");

  writeExecutable(
    executable,
    `#!/bin/sh\nprintf x >> "$COUNT_FILE"\nprintf '0123456789'\n`,
  );
  await expect(
    scrapeWithScrapectl("https://example.com/large", {
      maxMarkdownBytes: 5,
      maxMarkdownCodePoints: 5,
      retry,
    }),
  ).rejects.toThrow("exceeds max_bytes");
  expect(readFileSync(countFile, "utf8")).toBe("xx");

  writeExecutable(
    executable,
    `#!/bin/sh\nprintf x >> "$COUNT_FILE"\nprintf '%0200d' 0\n`,
  );
  await expect(
    scrapeWithScrapectl("https://example.com/output", {
      maxOutputBytes: 32,
      retry,
    }),
  ).rejects.toThrow("max_output_bytes");
  expect(readFileSync(countFile, "utf8")).toBe("xxx");
});
