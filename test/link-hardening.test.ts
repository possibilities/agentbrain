import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ingestPrescrapedLink,
  planQueuedUrlFanout,
  type ScrapedLink,
} from "../src/link-ingest";
import { sanitizeExternalError } from "../src/sanitize";
import { ResearchStore } from "../src/store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function store(): ResearchStore {
  const dir = mkdtempSync(join(tmpdir(), "agentbrain-link-hardening-"));
  dirs.push(dir);
  return new ResearchStore(join(dir, "research.db"));
}

function xScrape(requested: string, reported = requested): ScrapedLink {
  return {
    success: true,
    url: reported,
    requested_url: requested,
    markdown: "X child",
    content: "X child",
    size_chars: 7,
  };
}

test("the completed-link compatibility adapter never performs child extraction", async () => {
  const research = store();
  const routes: string[] = [];
  const result = await ingestPrescrapedLink(
    research,
    {
      url: "https://x.com/root/status/1",
      markdown: "root",
      structured: {
        links: [
          { url: "https://example.com/story" },
          { url: "https://twitter.com/child/status/2" },
        ],
      },
    },
    {
      scrape: async (url) => {
        routes.push(url);
        return xScrape(url);
      },
    },
  );
  expect(result).toMatchObject({ success: true, linked_count: 0 });
  expect(routes).toEqual([]);
  research.close();
});

test("generic completed roots never trigger child scraping", async () => {
  const research = store();
  const calls: string[] = [];
  const result = await ingestPrescrapedLink(
    research,
    {
      url: "https://example.com/root",
      markdown: "already scraped root with https://fallback.example/ignored",
      structured: {
        links: [
          { url: "https://child.example/ignored" },
          { url: "https://x.com/child/status/8" },
        ],
      },
    },
    {
      scrape: async (url) => {
        calls.push(url);
        return xScrape(url);
      },
    },
  );
  expect(result).toMatchObject({ success: true, linked_count: 0 });
  expect(calls).toEqual([]);
  research.close();
});

test("queued child identity uses the requested canonical provider identity", () => {
  const plan = planQueuedUrlFanout("https://x.com/root/status/1", [
    {
      relation_type: "references",
      target_url: "https://twitter.com/child/status/2?ref=timeline",
    },
  ]);
  expect(plan.discoveries[0]).toMatchObject({
    canonicalUrl: "https://x.com/i/status/2",
    resourceKey: { type: "x:status", value: "2" },
    relationType: "content_link",
    suppressionReason: null,
  });
});

test("identical completed-link replay is unchanged and does not churn chunks", async () => {
  const research = store();
  const payload = {
    url: "https://example.com/idempotent",
    markdown: "# Stable root\n\nStable body",
    source: "agentbot",
  };
  const first = await ingestPrescrapedLink(research, payload);
  const chunksBefore = research.db
    .query("SELECT id FROM chunks ORDER BY id")
    .all();
  const second = await ingestPrescrapedLink(research, payload);
  const chunksAfter = research.db
    .query("SELECT id FROM chunks ORDER BY id")
    .all();
  expect(first.root.status).toBe("created");
  expect(second.root.status).toBe("unchanged");
  expect(chunksAfter).toEqual(chunksBefore);
  research.close();
});

test("artifact failure is root-success partial and adds metadata only on failure", async () => {
  const research = store();
  const result = await ingestPrescrapedLink(
    research,
    {
      url: "https://example.com/artifact",
      markdown: "root remains committed",
      save_markdown_copy: true,
    },
    {
      writeArtifact: () => {
        throw new Error("artifact disk failed");
      },
    },
  );
  expect(result).toMatchObject({
    success: false,
    root_success: true,
    artifact_path: null,
    artifact_error: "artifact disk failed",
  });
  expect(
    research.db.query("SELECT COUNT(*) AS count FROM documents").get(),
  ).toEqual({
    count: 1,
  });
  research.close();
});

test("legacy child provider failures cannot make root completion partial", async () => {
  const research = store();
  let calls = 0;
  const result = await ingestPrescrapedLink(
    research,
    {
      url: "https://x.com/root/status/9",
      markdown: "root",
      structured: { links: [{ url: "https://example.com/failure" }] },
    },
    {
      scrape: async () => {
        calls += 1;
        throw new Error("must not synchronously extract a child");
      },
    },
  );
  expect(result).toMatchObject({
    success: true,
    root_success: true,
    linked_count: 0,
    linked_failed_count: 0,
  });
  expect(calls).toBe(0);
  research.close();
});

test("external error sanitizer redacts secrets before truncating hostile tails", () => {
  const sanitized = sanitizeExternalError(
    `Authorization: Bearer top.secret token=abc123 password=hunter2 ${"x".repeat(1000)} tail_secret=never`,
  );
  expect(sanitized).not.toContain("top.secret");
  expect(sanitized).not.toContain("abc123");
  expect(sanitized).not.toContain("hunter2");
  expect(sanitized).not.toContain("never");
  expect(sanitized.length).toBeLessThanOrEqual(601);
});
