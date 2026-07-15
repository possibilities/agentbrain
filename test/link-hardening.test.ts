import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestPrescrapedLink, type ScrapedLink } from "../src/link-ingest";
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
    preset: "x-tweet",
    markdown: "X child",
    content: "X child",
    structured: {},
    links: null,
    size_chars: 7,
  };
}

test("external children use safe extraction while only canonical X children use browser scraping", async () => {
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
      ensurePublicUrl: async (url) => routes.push(`preflight:${url}`),
      extractExternal: async (url) => {
        routes.push(`safe:${url}`);
        return {
          source_type: "url",
          source_uri: url,
          title: "External",
          content: "externally fetched text",
        };
      },
      scrapeX: async (url) => {
        routes.push(`browser:${url}`);
        return xScrape(url);
      },
    },
  );
  expect(result.success).toBe(true);
  expect(routes).toEqual([
    "safe:https://example.com/story",
    "preflight:https://twitter.com/child/status/2",
    "browser:https://twitter.com/child/status/2",
  ]);
  research.close();
});

test("X browser result must canonicalize to the same requested item", async () => {
  const research = store();
  const result = await ingestPrescrapedLink(
    research,
    {
      url: "https://x.com/root/status/1",
      markdown: "root",
      structured: { links: [{ url: "https://x.com/child/status/2" }] },
    },
    {
      ensurePublicUrl: async () => undefined,
      scrapeX: async (url) => xScrape(url, "https://x.com/attacker/status/3"),
    },
  );
  expect(result).toMatchObject({
    success: false,
    root_success: true,
    linked_failed_count: 1,
  });
  expect(result.linked_results[0].error).toContain(
    "did not match the requested canonical X item",
  );
  expect(result.linked_results[0].relation).toMatchObject({ status: "failed" });
  research.close();
});

test("identical completed-link replay is unchanged and does not churn chunks", async () => {
  const research = store();
  const payload = {
    url: "https://example.com/idempotent",
    markdown: "# Stable root\n\nStable body",
    source: "botctl",
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

test("child failures persist and emit only sanitized bounded errors", async () => {
  const research = store();
  const result = await ingestPrescrapedLink(
    research,
    {
      url: "https://x.com/root/status/9",
      markdown: "root",
      structured: { links: [{ url: "https://example.com/failure" }] },
    },
    {
      extractExternal: async () => {
        throw new Error(
          `Authorization: Bearer persist.secret token=db-secret ${"z".repeat(1000)} secret=tail-secret`,
        );
      },
    },
  );
  const failure = result.linked_results[0];
  expect(failure.error).not.toContain("persist.secret");
  expect(failure.error).not.toContain("db-secret");
  expect(failure.error).not.toContain("tail-secret");
  expect(failure.error?.length ?? 0).toBeLessThanOrEqual(601);
  expect(failure.relation).toMatchObject({ error: failure.error });
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
