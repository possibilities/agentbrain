import { expect, test } from "bun:test";
import { normalizeSearchQuery, parseTags, truncateContent } from "../src/query";

test("normalizes any queries into quoted OR atoms", () => {
  expect(normalizeSearchQuery("agent memory systems", "any")).toBe(
    '"agent" OR "memory" OR "systems"',
  );
});

test("normalizes all queries into quoted AND atoms and keeps phrases", () => {
  expect(normalizeSearchQuery('"agent memory" systems', "all")).toBe(
    '"agent memory" AND "systems"',
  );
});

test("raw queries pass through", () => {
  expect(normalizeSearchQuery("agent NEAR memory", "raw")).toBe(
    "agent NEAR memory",
  );
});

test("parseTags tolerates malformed JSON", () => {
  expect(parseTags('["a","b",3]')).toEqual(["a", "b"]);
  expect(parseTags("not-json")).toEqual([]);
});

test("truncateContent uses head/tail windows", () => {
  const input = "a".repeat(1000) + "b".repeat(1000);
  const out = truncateContent(input, 1000);
  expect(out.omitted).toBe(1000);
  expect(out.content).toContain("omitted 1000 chars");
  expect(out.content.endsWith("b".repeat(350))).toBe(true);
});
