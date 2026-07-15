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
    /\b(?:globalThis\.)?fetch\s*\(/,
    /\bBun\.(?:connect|udpSocket)\s*\(/,
    /\bnew\s+(?:WebSocket|EventSource)\b/,
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
