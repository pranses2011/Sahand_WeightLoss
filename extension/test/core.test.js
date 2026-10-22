import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  downloadChangedFiles,
  getCommit,
  makeArchiveName,
  parseCommitInput,
} from "../lib/github.js";
import { createZip, sanitizeZipPath } from "../lib/zip.js";

const execFileAsync = promisify(execFile);
const fullSha = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d";

test("parses a regular GitHub commit URL", () => {
  assert.deepEqual(
    parseCommitInput(`https://github.com/octocat/Hello-World/commit/${fullSha}?diff=split`),
    { owner: "octocat", repo: "Hello-World", sha: fullSha },
  );
});

test("parses API URLs and shorthand syntax", () => {
  assert.deepEqual(
    parseCommitInput(`https://api.github.com/repos/octocat/Hello-World/commits/${fullSha}`),
    { owner: "octocat", repo: "Hello-World", sha: fullSha },
  );
  assert.deepEqual(
    parseCommitInput("octocat/Hello-World@7fd1a60"),
    { owner: "octocat", repo: "Hello-World", sha: "7fd1a60" },
  );
});

test("uses the current repository when only a SHA is given", () => {
  assert.deepEqual(
    parseCommitInput("7fd1a60", "https://github.com/octocat/Hello-World/issues"),
    { owner: "octocat", repo: "Hello-World", sha: "7fd1a60" },
  );
});

test("rejects malformed input", () => {
  assert.throws(() => parseCommitInput("not a commit"), /فرمت ورودی معتبر نیست/);
  assert.throws(() => parseCommitInput("7fd1a60"), /صفحه همان مخزن/);
});

test("builds a safe archive filename", () => {
  assert.equal(
    makeArchiveName("some owner", "repo/unsafe", fullSha),
    "some-owner-repo-unsafe-7fd1a60-changed-files.zip",
  );
});

test("sanitizes traversal and Windows separators", () => {
  assert.equal(sanitizeZipPath("/src\\nested/../index.js"), "src/nested/__parent__/index.js");
  assert.throws(() => sanitizeZipPath("/./"));
});

test("paginates GitHub commit files and sends the token", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const page = new URL(url).searchParams.get("page");
    const body = page === "1"
      ? { sha: fullSha, commit: { message: "Test" }, files: [{ filename: "one.txt", status: "added" }] }
      : { sha: fullSha, files: [{ filename: "two.txt", status: "modified" }] };
    const headers = page === "1"
      ? { link: '<https://api.github.com/example?page=2>; rel="next"' }
      : {};
    return new Response(JSON.stringify(body), { status: 200, headers });
  };

  try {
    const commit = await getCommit(
      { owner: "octocat", repo: "Hello-World", sha: fullSha },
      { token: "test-token" },
    );
    assert.deepEqual(commit.files.map((file) => file.filename), ["one.txt", "two.txt"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.headers.Authorization, "Bearer test-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("falls back to the blobs API and excludes deleted files", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://raw.githubusercontent.com/")) {
      throw new TypeError("simulated raw host failure");
    }
    return new Response(new Uint8Array([0, 1, 2, 255]), { status: 200 });
  };

  try {
    const result = await downloadChangedFiles({
      owner: "octocat",
      repo: "Hello-World",
      commitSha: fullSha,
      files: [
        { filename: "assets/data.bin", status: "modified", sha: "a".repeat(40) },
        { filename: "removed.txt", status: "removed", sha: "b".repeat(40) },
      ],
    });
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].name, "assets/data.bin");
    assert.deepEqual([...result.entries[0].data], [0, 1, 2, 255]);
    assert.equal(result.removedCount, 1);
    assert.equal(calls.length, 2);
    assert.match(calls[1], /api\.github\.com\/repos\/octocat\/Hello-World\/git\/blobs\//);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("creates a valid UTF-8 ZIP whose files can be extracted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "commitzip-test-"));
  const zipPath = join(directory, "archive.zip");
  const extractPath = join(directory, "out");

  try {
    const zip = createZip([
      { name: "src/index.js", data: new TextEncoder().encode("console.log('ok');\n") },
      { name: "راهنما.txt", data: new TextEncoder().encode("سلام از CommitZip\n") },
      { name: "assets/empty.bin", data: new Uint8Array() },
    ], { modifiedAt: new Date("2026-10-22T10:30:00Z") });

    await writeFile(zipPath, new Uint8Array(await zip.arrayBuffer()));
    await execFileAsync("unzip", ["-t", zipPath]);
    await execFileAsync("unzip", ["-qq", zipPath, "-d", extractPath]);

    assert.equal(await readFile(join(extractPath, "src/index.js"), "utf8"), "console.log('ok');\n");
    assert.equal(await readFile(join(extractPath, "راهنما.txt"), "utf8"), "سلام از CommitZip\n");
    assert.equal((await readFile(join(extractPath, "assets/empty.bin"))).byteLength, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
