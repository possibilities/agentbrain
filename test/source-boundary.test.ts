import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { probeShareIngress } from "../src/share-liveness";

function sourceFiles(root: string): string[] {
  const output: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) output.push(...sourceFiles(path));
    else if (path.endsWith(".ts")) output.push(path);
  }
  return output;
}

/**
 * The one module authorized to bind a socket, per ADR 0017. Outbound network
 * clients remain forbidden everywhere, including here.
 */
const SHARE_INGRESS_FILE = join("src", "share-server.ts");

/**
 * The one module authorized to make a request, per ADR 0021, and only to the
 * ingress this machine registered for itself. It is a liveness proof, not a
 * content read: no locator from a job, a payload, or the database can reach
 * it, so Agentscrape remains the only fetcher of anything published (ADR 0002).
 */
const SHARE_LIVENESS_FILE = join("src", "share-liveness.ts");

test("production source has no direct DNS/HTTP client boundary", () => {
  const root = join(import.meta.dir, "..", "src");
  expect(existsSync(join(root, "url-safety.ts"))).toBe(false);
  const forbidden = [
    /from\s+["']node:(?:dns(?:\/promises)?|http|https|http2|net|tls|dgram)["']/,
    /import\(["']node:(?:dns(?:\/promises)?|http|https|http2|net|tls|dgram)["']\)/,
    /require\(["']node:(?:dns(?:\/promises)?|http|https|http2|net|tls|dgram)["']\)/,
    /from\s+["'](?:undici|axios|got|node-fetch|request|superagent|playwright|puppeteer|selenium-webdriver)["']/,
    /import\(["'](?:undici|axios|got|node-fetch|request|superagent|playwright|puppeteer|selenium-webdriver)["']\)/,
    /require\(["'](?:undici|axios|got|node-fetch|request|superagent|playwright|puppeteer|selenium-webdriver)["']\)/,
    /\b(?:globalThis\.)?fetch\s*\(/,
    /\bBun\.(?:connect|udpSocket)\s*\(/,
    /\bDeno\.(?:connect|serve|listen)\s*\(/,
    /\b(?:new\s+)?(?:WebSocket|EventSource|XMLHttpRequest)\b/,
    /\b(?:http|https)Request\b/,
  ];
  // Inbound binding is allowed only in the share ingress authorized by ADR 0017.
  const inboundBinding = /\bBun\.serve\s*\(/;
  const violations: string[] = [];
  for (const path of sourceFiles(root)) {
    const text = readFileSync(path, "utf8");
    for (const pattern of forbidden) {
      const exempt =
        path.endsWith(SHARE_LIVENESS_FILE) && pattern.source.includes("fetch");
      if (!exempt && pattern.test(text)) violations.push(`${path}: ${pattern}`);
    }
    if (!path.endsWith(SHARE_INGRESS_FILE) && inboundBinding.test(text)) {
      violations.push(`${path}: ${inboundBinding}`);
    }
  }
  expect(violations).toEqual([]);
});

test("only the ADR 0017 share ingress binds a socket", () => {
  const root = join(import.meta.dir, "..", "src");
  const binding = sourceFiles(root)
    .filter((path) => /\bBun\.serve\s*\(/.test(readFileSync(path, "utf8")))
    .map((path) => path.slice(path.indexOf(join("src", ""))));
  expect(binding).toEqual([SHARE_INGRESS_FILE]);
});

test("the share ingress performs no outbound network work", () => {
  const text = readFileSync(
    join(import.meta.dir, "..", SHARE_INGRESS_FILE),
    "utf8",
  );
  // Agentscrape remains the only URL fetcher (ADR 0002); the ingress is
  // inbound only and must never acquire an egress path.
  for (const pattern of [
    /\b(?:globalThis\.)?fetch\s*\(/,
    /\bBun\.connect\s*\(/,
    /from\s+["']node:(?:dns(?:\/promises)?|http|https|net|tls|dgram)["']/,
  ]) {
    expect(pattern.test(text)).toBe(false);
  }
});

test("the liveness probe is one request, to the ingress's own health path", async () => {
  const text = readFileSync(
    join(import.meta.dir, "..", SHARE_LIVENESS_FILE),
    "utf8",
  );
  // One call site, and no other egress seam smuggled in beside it.
  expect(text.match(/\bfetch\s*\(/g)?.length).toBe(1);
  for (const pattern of [
    /\bBun\.connect\s*\(/,
    /\bBun\.serve\s*\(/,
    /from\s+["']node:(?:dns(?:\/promises)?|http|https|net|tls|dgram)["']/,
  ]) {
    expect(pattern.test(text)).toBe(false);
  }

  // And behaviourally: it asks the address it was handed for /v1/health, with
  // no redirect following and nothing else requested.
  const seen: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      seen.push(new URL(request.url).pathname);
      return Response.json({ ok: true });
    },
  });
  try {
    const probe = await probeShareIngress(
      `http://127.0.0.1:${server.port}`,
      "0123456789abcdef",
    );
    expect(probe.ok).toBe(true);
    expect(seen).toEqual(["/v1/health"]);
  } finally {
    server.stop(true);
  }
});

test("production source outside the Agentscrape adapter has no browser or preset hooks", () => {
  const root = join(import.meta.dir, "..", "src");
  const forbidden = [
    /\bbrowserctl\b/,
    /\bagent-browser\b/,
    /\b(?:playwright|puppeteer|selenium-webdriver)\b/,
    /--preset\b/,
    /--selector\b/,
    /fetch-markdown/,
    /--markdown/,
  ];
  const violations: string[] = [];
  for (const path of sourceFiles(root)) {
    if (path.endsWith(`${join("src", "agentscrape.ts")}`)) continue;
    const text = readFileSync(path, "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(text)) violations.push(`${path}: ${pattern}`);
    }
  }
  expect(violations).toEqual([]);
});

test("durable URL worker has no Agentscrape Markdown fallback seam", () => {
  const root = join(import.meta.dir, "..", "src");
  const text = readFileSync(join(root, "worker.ts"), "utf8");
  expect(text).toContain("extractWithAgentscrape");
  const forbidden = [
    /\bscrapeWithAgentscrape\b/,
    /\bScrapeProvider\b/,
    /\bscrape\??:\s*ScrapeProvider\b/,
    /fetch-markdown/,
    /--markdown/,
  ];
  const violations = forbidden
    .filter((pattern) => pattern.test(text))
    .map((pattern) => String(pattern));
  expect(violations).toEqual([]);
});

test("package dependencies do not add network or browser clients", () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
  ) as Record<string, Record<string, string> | undefined>;
  const forbidden = new Set([
    "undici",
    "axios",
    "got",
    "node-fetch",
    "request",
    "superagent",
    "playwright",
    "puppeteer",
    "selenium-webdriver",
  ]);
  const declared = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ];
  expect(declared.filter((name) => forbidden.has(name))).toEqual([]);
});
