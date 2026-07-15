import { expect, test } from "bun:test";
import {
  COMPLETED_LINK_STDIN_MAX_BYTES,
  readCompletedLinkPayload,
  validateCompletedLinkPayload,
} from "../src/completed-link-input";

test("completed-link reader enforces the raw byte cap while streaming", async () => {
  const bytes = new Uint8Array(COMPLETED_LINK_STDIN_MAX_BYTES + 1);
  bytes.fill(0x20);
  await expect(
    readCompletedLinkPayload(new Blob([bytes]).stream()),
  ).rejects.toThrow("stdin JSON exceeds");
});

test("completed-link reader rejects malformed UTF-8", async () => {
  const bytes = new Uint8Array([0x7b, 0xff, 0x7d]);
  await expect(
    readCompletedLinkPayload(new Blob([bytes]).stream()),
  ).rejects.toThrow("valid UTF-8");
});

test("completed-link validation checks URLs and every typed optional field", () => {
  expect(() =>
    validateCompletedLinkPayload({ url: "file:///tmp/nope", markdown: "body" }),
  ).toThrow("http(s) URL");

  for (const [field, value] of [
    ["title", 42],
    ["category", null],
    ["summary", {}],
    ["notes", []],
    ["preset", true],
    ["tags", ["valid", 42]],
    ["save_markdown_copy", "yes"],
    ["scrape_linked", 1],
  ] as const) {
    expect(() =>
      validateCompletedLinkPayload({
        url: "https://example.com",
        markdown: "body",
        [field]: value,
      }),
    ).toThrow(`payload field '${field}'`);
  }
});
