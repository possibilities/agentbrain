import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../src/errors";
import {
  bearerToken,
  extractFirstUrl,
  generateShareToken,
  parseShareRequest,
  readShareToken,
  resolveShare,
  resolveSharePort,
  SHARE_DEFAULT_COLLECTION,
  SHARE_DEFAULT_PORT,
  tokenMatches,
  writeShareToken,
} from "../src/share";

function resolved(body: unknown) {
  return resolveShare(parseShareRequest(body));
}

test("a bare URL share resolves to a URL intent", () => {
  const share = resolved({
    client: "chrome-extension",
    url: "https://example.com/post",
    title: "Post",
  });
  expect(share.kind).toBe("url");
  expect(share.source).toBe("https://example.com/post");
  expect(share.title).toBe("Post");
  expect(share.extractedFromText).toBe(false);
  expect(share.ingress).toBe("chrome-extension");
});

test("shares default to the saved-links collection", () => {
  expect(
    resolved({ client: "android-share", url: "https://example.com/a" })
      .collections,
  ).toEqual([SHARE_DEFAULT_COLLECTION]);
  expect(
    resolved({
      client: "android-share",
      url: "https://example.com/a",
      collections: ["research"],
    }).collections,
  ).toEqual(["research"]);
});

test("free text containing a URL resolves to that URL", () => {
  const share = resolved({
    client: "android-share",
    text: "great read https://example.com/deep-dive worth your time",
  });
  expect(share.kind).toBe("url");
  expect(share.source).toBe("https://example.com/deep-dive");
  expect(share.extractedFromText).toBe(true);
});

test("free text without a URL resolves to a text intent", () => {
  const share = resolved({ client: "android-share", text: "a plain note" });
  expect(share.kind).toBe("text");
  expect(share.source).toBe("a plain note");
  expect(share.extractedFromText).toBe(false);
});

test("an explicit url wins over accompanying text", () => {
  const share = resolved({
    client: "chrome-extension",
    url: "https://example.com/canonical",
    text: "see https://example.com/other",
  });
  expect(share.source).toBe("https://example.com/canonical");
  expect(share.extractedFromText).toBe(false);
});

test("URL extraction strips trailing prose punctuation", () => {
  expect(extractFirstUrl("see https://example.com/a.")).toBe(
    "https://example.com/a",
  );
  expect(extractFirstUrl("see https://example.com/a, then")).toBe(
    "https://example.com/a",
  );
  expect(extractFirstUrl("see https://example.com/a!")).toBe(
    "https://example.com/a",
  );
});

test("URL extraction keeps balanced parentheses but drops unbalanced ones", () => {
  expect(extractFirstUrl("see (https://example.com/a)")).toBe(
    "https://example.com/a",
  );
  expect(extractFirstUrl("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe(
    "https://en.wikipedia.org/wiki/Foo_(bar)",
  );
});

test("URL extraction takes the first usable locator and tolerates a bad one", () => {
  expect(extractFirstUrl("https://a.example/1 and https://b.example/2")).toBe(
    "https://a.example/1",
  );
  // A scheme with no host must not mask the valid URL that follows it.
  expect(extractFirstUrl("https:// then https://real.example/x")).toBe(
    "https://real.example/x",
  );
});

test("URL extraction ignores non-http schemes and finds nothing in plain prose", () => {
  expect(extractFirstUrl("ftp://example.com/file")).toBeNull();
  expect(extractFirstUrl("no links here at all")).toBeNull();
  expect(extractFirstUrl("mailto:someone@example.com")).toBeNull();
});

test("malformed payloads are rejected with actionable codes", () => {
  const cases: Array<[unknown, string]> = [
    ["not an object", "bad_payload"],
    [null, "bad_payload"],
    [["array"], "bad_payload"],
    [{ url: "https://example.com/a" }, "bad_payload"],
    [{ client: "curl", url: "https://example.com/a" }, "bad_payload"],
    [{ client: "chrome-extension" }, "bad_payload"],
    [{ client: "chrome-extension", url: 42 }, "bad_payload"],
    [{ client: "chrome-extension", tags: "reading" }, "bad_payload"],
    [{ client: "chrome-extension", version: 2 }, "unsupported_version"],
  ];
  for (const [body, code] of cases) {
    let thrown: unknown;
    try {
      resolved(body);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).code).toBe(code);
  }
});

test("non-http locators are rejected as bad sources", () => {
  expect(() =>
    resolved({ client: "chrome-extension", url: "file:///etc/passwd" }),
  ).toThrow(/http\(s\)/);
  expect(() =>
    resolved({
      client: "chrome-extension",
      url: "https://user:pw@example.com",
    }),
  ).toThrow(/credentialed/);
});

test("oversized text is refused rather than silently truncated", () => {
  expect(() =>
    resolved({ client: "android-share", text: "x".repeat(100_001) }),
  ).toThrow(/exceeds 100000 characters/);
});

test("tags are normalized and blank collections dropped", () => {
  const share = resolved({
    client: "chrome-extension",
    url: "https://example.com/a",
    tags: ["Reading List", "#ai"],
    collections: ["", "research"],
  });
  expect(share.tags).toEqual(["reading-list", "ai"]);
  expect(share.collections).toEqual(["research"]);
});

test("token files are written with owner-only permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbrain-share-token-"));
  try {
    const path = join(root, "nested", "share-token");
    const token = generateShareToken();
    writeShareToken(path, token);
    expect(readShareToken(path)).toBe(token);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing token file reports how to create one", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbrain-share-token-"));
  try {
    expect(() => readShareToken(join(root, "absent"))).toThrow(
      /share token not found/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("token comparison rejects mismatches of every shape", () => {
  const token = generateShareToken();
  expect(tokenMatches(token, token)).toBe(true);
  expect(tokenMatches(token, `${token}x`)).toBe(false);
  expect(tokenMatches(token, token.slice(0, -1))).toBe(false);
  expect(tokenMatches(token, "")).toBe(false);
});

test("bearer parsing accepts only a well-formed header", () => {
  expect(bearerToken("Bearer abc123")).toBe("abc123");
  expect(bearerToken("bearer abc123")).toBe("abc123");
  expect(bearerToken("Basic abc123")).toBeNull();
  expect(bearerToken("abc123")).toBeNull();
  expect(bearerToken(null)).toBeNull();
});

test("the listening port is --port, then PORT, then the fixed default", () => {
  // The flag is highest precedence and wins even when a supervisor supplied one.
  expect(resolveSharePort(9001, { PORT: "4321" })).toEqual({
    port: 9001,
    source: "flag",
  });
  // PORT is the fallback a port-allocating supervisor (Portless) fills in.
  expect(resolveSharePort(undefined, { PORT: "4321" })).toEqual({
    port: 4321,
    source: "env:PORT",
  });
  // With neither, the documented port the device clients are configured against.
  expect(resolveSharePort(undefined, {})).toEqual({
    port: SHARE_DEFAULT_PORT,
    source: "default",
  });
});

test("an absent PORT is absent and a malformed PORT is refused", () => {
  // An inherited empty value must not break the direct path.
  for (const value of ["", "   "]) {
    expect(resolveSharePort(undefined, { PORT: value }).source).toBe("default");
  }

  // Silently falling back would bind 8787 while the supervisor proxied
  // elsewhere, so the ingress would answer on a port nothing points at.
  for (const value of ["http", "0", "65536", "80.5", "-1"]) {
    expect(() => resolveSharePort(undefined, { PORT: value })).toThrow(
      CliError,
    );
    try {
      resolveSharePort(undefined, { PORT: value });
    } catch (error) {
      expect((error as CliError).code).toBe("bad_port");
      expect((error as CliError).hint).toContain("--port always wins");
    }
  }

  for (const value of [0, 65_536, 8787.5]) {
    expect(() => resolveSharePort(value, {})).toThrow(CliError);
  }
});
