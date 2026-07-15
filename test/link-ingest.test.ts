import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalizeSource,
  extractOutboundLinks,
  ingestPrescrapedLink,
  LINKED_FAN_OUT_LIMIT,
  type ScrapedLink,
} from "../src/link-ingest";
import { ResearchStore } from "../src/store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function setup(): { store: ResearchStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "agentbrain-link-"));
  dirs.push(dir);
  const path = join(dir, "research.db");
  return { store: new ResearchStore(path), path };
}

async function fixture(name: string): Promise<Record<string, unknown>> {
  return Bun.file(join(import.meta.dir, "fixtures", name)).json();
}

function scraped(url: string): ScrapedLink {
  return {
    success: true,
    url,
    requested_url: url,
    markdown: `# Child\n\nContent from ${url}`,
    content: `# Child\n\nContent from ${url}`,
    size_chars: 20,
  };
}

test("X status and article URL forms canonicalize to stable native identities", () => {
  expect(
    canonicalizeSource("https://twitter.com/old/status/123?ref=home"),
  ).toEqual(["tweet", "https://x.com/i/status/123"]);
  expect(canonicalizeSource("https://x.com/writer/articles/987")).toEqual([
    "tweet_article",
    "https://x.com/i/article/987",
  ]);
});

test("generic completed root commits directly without root or child scraping", async () => {
  const { store, path } = setup();
  let calls = 0;
  const result = await ingestPrescrapedLink(
    store,
    {
      url: "https://Example.COM/reference#section",
      markdown:
        "# Generic reference\n\nA useful body with https://fallback.example/ignored.",
      structured: {
        kind: "page",
        links: [{ url: "https://child.example/ignored" }],
      },
      source: "botctl",
    },
    {
      scrape: async () => {
        calls += 1;
        throw new Error("must not scrape generic roots");
      },
    },
  );
  expect(result).toMatchObject({ success: true, linked_count: 0 });
  expect(result.root).toMatchObject({
    source_type: "scraped_url",
    source_uri: "https://example.com/reference",
  });
  expect(calls).toBe(0);
  store.close();

  const db = new Database(path, { readonly: true });
  const row = db.query("SELECT tags, notes FROM documents").get() as {
    tags: string;
    notes: string;
  };
  expect(JSON.parse(row.tags)).toContain("source-botctl");
  expect(JSON.parse(row.notes).source).toBe("botctl");
  db.close();
});

test("article fixture preserves structured metadata and source origin", async () => {
  const { store, path } = setup();
  const payload = await fixture("prescraped_x_article.json");
  const result = await ingestPrescrapedLink(store, payload as never);
  expect(result.root).toMatchObject({
    source_type: "tweet_article",
    source_uri: "https://x.com/i/article/987",
    title: "A Structured X Article",
  });
  store.close();
  const db = new Database(path, { readonly: true });
  const row = db.query("SELECT tags, notes FROM documents").get() as {
    tags: string;
    notes: string;
  };
  expect(JSON.parse(row.tags)).toEqual(
    expect.arrayContaining([
      "tweet-article",
      "source-linkctl",
      "author-writer",
    ]),
  );
  expect(JSON.parse(row.notes).structured_metadata).toEqual({
    title: "A Structured X Article",
    author: { name: "Writer Name", handle: "writer" },
    published_at: "2026-07-14T12:30:00Z",
  });
  db.close();
});

test("nested structured links override Markdown, deduplicate, and stop after one hop", async () => {
  const { store, path } = setup();
  const scrapeCalls: string[] = [];
  const payload = await fixture("prescraped_x_tweet.json");
  const result = await ingestPrescrapedLink(store, payload as never, {
    scrape: async (url) => {
      scrapeCalls.push(url);
      return scraped(url);
    },
  });
  expect(scrapeCalls).toEqual([
    "https://example.com/story",
    "https://x.com/original_handle",
    "https://twitter.com/writer/articles/987",
    "https://twitter.com/peer/status/456",
  ]);
  expect(scrapeCalls).not.toContain("https://fallback.example/ignored");
  expect(result).toMatchObject({ success: true, linked_count: 4 });
  store.close();

  const db = new Database(path, { readonly: true });
  expect(
    db.query("SELECT COUNT(*) AS count FROM document_links").get(),
  ).toEqual({ count: 4 });
  expect(db.query("SELECT COUNT(*) AS count FROM documents").get()).toEqual({
    count: 5,
  });
  db.close();
});

test("empty nested links are authoritative over Markdown fallback", () => {
  expect(
    extractOutboundLinks(
      "https://x.com/a/status/1",
      "fallback https://example.com/ignored",
      { data: { links: [] } },
    ),
  ).toEqual([]);
});

test("root-first partial failure persists provenance and retries relation in place", async () => {
  const { store, path } = setup();
  const payload = {
    url: "https://x.com/writer/articles/777",
    markdown: "# Root article",
    structured: {
      title: "Root article",
      links: [
        { label: "works", url: "https://ok.example/page" },
        { label: "fails", url: "https://fail.example/page" },
      ],
    },
    source: "linkctl",
  };
  let fail = true;
  const dependencies = {
    scrape: async (url: string) => {
      if (fail && url.includes("fail.example"))
        throw new Error("fixture destination failed");
      return scraped(url);
    },
  };
  const first = await ingestPrescrapedLink(store, payload, dependencies);
  expect(first).toMatchObject({
    success: false,
    root_success: true,
    linked_failed_count: 1,
  });
  expect(first.linked_results.map((item) => item.success)).toEqual([
    true,
    false,
  ]);
  expect(
    store.db.query("SELECT status FROM document_links ORDER BY id").all(),
  ).toEqual([{ status: "success" }, { status: "failed" }]);

  fail = false;
  const second = await ingestPrescrapedLink(store, payload, dependencies);
  expect(second).toMatchObject({ success: true, linked_failed_count: 0 });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM document_links").get(),
  ).toEqual({ count: 2 });
  expect(
    store.db
      .query(
        "SELECT COUNT(*) AS count FROM document_links WHERE status='success'",
      )
      .get(),
  ).toEqual({ count: 2 });
  store.close();

  const db = new Database(path, { readonly: true });
  expect(db.query("SELECT COUNT(*) AS count FROM documents").get()).toEqual({
    count: 3,
  });
  db.close();
});

test("one-hop fan-out attempts only the first 25 discoveries without omitted relations", async () => {
  const { store } = setup();
  const discovered = Array.from(
    { length: LINKED_FAN_OUT_LIMIT + 5 },
    (_, index) => `https://child.example/story-${index + 1}`,
  );
  const calls: string[] = [];
  const result = await ingestPrescrapedLink(
    store,
    {
      url: "https://x.com/person/status/500",
      markdown: "root",
      structured: { links: discovered.map((url) => ({ url })) },
    },
    {
      scrape: async (url) => {
        calls.push(url);
        return scraped(url);
      },
    },
  );

  expect(result).toMatchObject({
    success: false,
    root_success: true,
    linked_count: LINKED_FAN_OUT_LIMIT,
    linked_failed_count: 0,
    linked_truncated: true,
    linked_discovered_count: discovered.length,
  });
  expect(calls).toEqual(discovered.slice(0, LINKED_FAN_OUT_LIMIT));
  expect(result.linked_results.map((item) => item.url)).toEqual(calls);
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM document_links").get(),
  ).toEqual({ count: LINKED_FAN_OUT_LIMIT });
  expect(
    store.db
      .query(
        "SELECT COUNT(*) AS count FROM document_links WHERE discovered_url = ?",
      )
      .get(discovered[discovered.length - 1] as string),
  ).toEqual({ count: 0 });
  store.close();
});

test("two parents reuse one shared child document while retaining both relations", async () => {
  const { store } = setup();
  const deps = {
    scrape: async (url: string) => ({
      ...scraped(url),
      markdown: "shared child",
      content: "shared child",
    }),
  };
  for (const id of [1, 2]) {
    await ingestPrescrapedLink(
      store,
      {
        url: `https://x.com/person/status/${id}`,
        markdown: `root ${id}`,
        structured: { links: [{ url: "https://shared.example/story" }] },
      },
      deps,
    );
  }
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM documents").get(),
  ).toEqual({ count: 3 });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM document_links").get(),
  ).toEqual({ count: 2 });
  const targetCount = store.db
    .query("SELECT COUNT(DISTINCT to_document_id) AS count FROM document_links")
    .get();
  expect(targetCount).toEqual({ count: 1 });
  store.close();
});
