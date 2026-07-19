import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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
    /\bBun\.(?:connect|udpSocket|serve)\s*\(/,
    /\bDeno\.(?:connect|serve|listen)\s*\(/,
    /\b(?:new\s+)?(?:WebSocket|EventSource|XMLHttpRequest)\b/,
    /\b(?:http|https)Request\b/,
  ];
  const violations: string[] = [];
  for (const path of sourceFiles(root)) {
    const text = readFileSync(path, "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(text)) violations.push(`${path}: ${pattern}`);
    }
  }
  expect(violations).toEqual([]);
});

test("production source outside the Scrapectl adapter has no browser or preset hooks", () => {
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
    if (path.endsWith(`${join("src", "scrapectl.ts")}`)) continue;
    const text = readFileSync(path, "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(text)) violations.push(`${path}: ${pattern}`);
    }
  }
  expect(violations).toEqual([]);
});

test("durable URL worker has no Scrapectl Markdown fallback seam", () => {
  const root = join(import.meta.dir, "..", "src");
  const text = readFileSync(join(root, "worker.ts"), "utf8");
  expect(text).toContain("extractWithScrapectl");
  const forbidden = [
    /\bscrapeWithScrapectl\b/,
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
