import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import {
  decodeHtmlEntities,
  extractDocxBytes,
  extractEpubBytes,
  extractFile,
  extractUrl,
} from "../src/extract";
import { ingestSource } from "../src/ingest";
import { ResearchStore } from "../src/store";
import {
  fetchPublicUrl,
  isPublicAddress,
  type PinnedTransport,
} from "../src/url-safety";

const dirs: string[] = [];
const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentbrain-ingest-"));
  dirs.push(dir);
  return dir;
}

test("generic text, HTML file, and directory ingestion preserve statuses and secret skips", async () => {
  const dir = tempDir();
  const store = new ResearchStore(join(dir, "research.db"));
  const created = await ingestSource(store, {
    source: "A pasted 🧠 note",
    sourceType: "text",
    tags: "Notes, Brain",
  });
  expect(created).toMatchObject({ status: "created", source_type: "text" });
  const unchanged = await ingestSource(store, {
    source: "A pasted 🧠 note",
    sourceType: "text",
    tags: "Notes, Brain",
  });
  expect(unchanged).toMatchObject({ status: "unchanged" });

  const htmlPath = join(dir, "page.html");
  writeFileSync(
    htmlPath,
    "<html><title>Fixture &amp; Title</title><script>secret noise</script><body><h1>Hello</h1><p>Useful body</p></body></html>",
  );
  const html = await ingestSource(store, {
    source: htmlPath,
    sourceType: "file",
  });
  expect(html).toMatchObject({ title: "Fixture & Title", source_type: "file" });

  const root = join(dir, "files");
  mkdirSync(root);
  writeFileSync(join(root, "one.md"), "one document");
  writeFileSync(join(root, ".env"), "PASSWORD=nope");
  writeFileSync(join(root, "ignored.bin"), new Uint8Array([0, 1, 2]));
  const directory = await ingestSource(store, {
    source: root,
    sourceType: "directory",
    tags: ["collection"],
  });
  expect(directory).toMatchObject({
    status: "directory_ingested",
    scanned_candidate_files: 1,
    ingested_count: 1,
    errors_count: 0,
  });
  store.close();
});

test("DOCX and EPUB ZIP containers extract bounded text", () => {
  const docx = zipSync({
    "word/document.xml": strToU8(
      "<w:document><w:body><w:p><w:r><w:t>Hello 🧠</w:t></w:r></w:p><w:p><w:r><w:t>World</w:t></w:r></w:p></w:body></w:document>",
    ),
  });
  expect(extractDocxBytes(docx, 100_000)).toContain("Hello 🧠\nWorld");

  const epub = zipSync({
    "OEBPS/02.xhtml": strToU8(
      "<html><body><p>Second chapter</p></body></html>",
    ),
    "OEBPS/01.xhtml": strToU8("<html><body><p>First chapter</p></body></html>"),
  });
  expect(extractEpubBytes(epub, 100_000)).toBe(
    "First chapter\n\nSecond chapter",
  );
  expect(() => extractEpubBytes(epub, 5)).toThrow("larger than max_bytes");

  const underreportedAggregate = zipSync(
    {
      "OEBPS/a.xhtml": strToU8("aaaa"),
      "OEBPS/b.xhtml": strToU8("bbbb"),
    },
    { level: 0 },
  );
  const view = new DataView(
    underreportedAggregate.buffer,
    underreportedAggregate.byteOffset,
    underreportedAggregate.byteLength,
  );
  let centralEntries = 0;
  for (let index = 0; index < underreportedAggregate.length - 28; index += 1) {
    if (view.getUint32(index, true) !== 0x02014b50) continue;
    view.setUint32(index + 24, 1, true);
    centralEntries += 1;
  }
  expect(centralEntries).toBe(2);
  expect(() => extractEpubBytes(underreportedAggregate, 5)).toThrow(
    "larger than max_bytes",
  );
});

test("PDF uses a PATH-resolved pdftotext executable with explicit argv", () => {
  const dir = tempDir();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "args.txt");
  const executable = join(bin, "pdftotext");
  writeFileSync(
    executable,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\nprintf 'Extracted PDF text\\n'\n`,
  );
  chmodSync(executable, 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  const pdf = join(dir, "paper.pdf");
  writeFileSync(pdf, "%PDF fixture");
  expect(extractFile(pdf).content).toBe("Extracted PDF text");
  expect(readFileSync(log, "utf8")).toBe(`-layout\n${realpathSync(pdf)}\n-\n`);
});

test("pdftotext failures redact secrets and collapse the resolved input path", () => {
  const dir = tempDir();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const executable = join(bin, "pdftotext");
  writeFileSync(
    executable,
    "#!/bin/sh\nprintf 'failed reading %s token=pdf-secret' \"$2\" >&2\nexit 9\n",
  );
  chmodSync(executable, 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  const pdf = join(dir, "private-paper.pdf");
  writeFileSync(pdf, "%PDF fixture");
  const resolvedPdf = realpathSync(pdf);

  expect(() => extractFile(pdf)).toThrow("private-paper.pdf");
  try {
    extractFile(pdf);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain(resolvedPdf);
    expect(message).not.toContain("pdf-secret");
    expect(message).toContain("token=[REDACTED]");
  }
});

test("public URL transport pins the resolver-approved endpoint and revalidates redirects", async () => {
  const resolved: string[] = [];
  const resolver = async (host: string): Promise<string[]> => {
    resolved.push(host);
    return [host === "first.example" ? "93.184.216.34" : "1.1.1.1"];
  };
  const fetched: Array<{
    url: string;
    address: string;
    headers: Record<string, string>;
  }> = [];
  const transport: PinnedTransport = async (request) => {
    fetched.push({
      url: request.url.toString(),
      address: request.address,
      headers: request.headers,
    });
    if (request.url.hostname === "first.example") {
      return {
        status: 302,
        headers: {
          location: "https://second.example/final",
        } as Record<string, string>,
        data: new Uint8Array(),
        remoteAddress: request.address,
      };
    }
    return {
      status: 200,
      headers: {
        "content-type": "text/html",
      } as Record<string, string>,
      data: new TextEncoder().encode(
        "<title>Final</title><p>redirect body</p>",
      ),
      remoteAddress: request.address,
    };
  };

  const result = await extractUrl("https://first.example/start", {
    resolver,
    transport,
  });
  expect(resolved).toEqual(["first.example", "second.example"]);
  expect(fetched.map(({ url, address }) => ({ url, address }))).toEqual([
    { url: "https://first.example/start", address: "93.184.216.34" },
    { url: "https://second.example/final", address: "1.1.1.1" },
  ]);
  expect(fetched[0].headers).toMatchObject({
    host: "first.example",
    "accept-encoding": "identity",
  });
  expect(result).toMatchObject({
    source_uri: "https://second.example/final",
    title: "Final",
    content: "Final \nredirect body",
  });
});

test("DNS safety rejects one private answer before transport and remote mismatch after it", async () => {
  let transported = false;
  const transport: PinnedTransport = async (request) => {
    transported = true;
    return {
      status: 200,
      headers: {},
      data: new Uint8Array(),
      remoteAddress: request.address,
    };
  };
  const mixed = fetchPublicUrl("https://mixed.example", {
    maxBytes: 1000,
    resolver: async () => ["1.1.1.1", "127.0.0.1"],
    transport,
  });
  await expect(mixed).rejects.toThrow("private/internal address blocked");
  expect(transported).toBe(false);

  const rebound = fetchPublicUrl("https://rebind.example", {
    maxBytes: 1000,
    resolver: async () => ["1.1.1.1"],
    transport: async () => ({
      status: 200,
      headers: {},
      data: new Uint8Array(),
      remoteAddress: "127.0.0.1",
    }),
  });
  await expect(rebound).rejects.toThrow("did not match the vetted endpoint");
});

test("address policy blocks transition, NAT64, mapped, and private IPv6 ranges", () => {
  for (const address of [
    "2001::1",
    "2002:0808:0808::1",
    "64:ff9b::808:808",
    "64:ff9b:1::808:808",
    "::ffff:10.0.0.1",
    "fc00::1",
    "fe80::1",
  ]) {
    expect(isPublicAddress(address)).toBe(false);
  }
  expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
});

test("numeric HTML entities are bounds checked", () => {
  expect(decodeHtmlEntities("ok &#x1F9E0;")).toBe("ok 🧠");
  expect(decodeHtmlEntities("bad &#x110000; and &#999999999999;")).toBe(
    "bad &#x110000; and &#999999999999;",
  );
});
