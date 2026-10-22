const GITHUB_API = "https://api.github.com";
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

export class GitHubError extends Error {
  constructor(message, { status = 0, code = "github_error", details = null } = {}) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function cleanRepoName(repo) {
  return repo.toLowerCase().endsWith(".git") ? repo.slice(0, -4) : repo;
}

function validateParts(owner, repo, sha) {
  const cleanOwner = decodeURIComponent(owner || "").trim();
  const cleanRepo = cleanRepoName(decodeURIComponent(repo || "").trim());
  const cleanSha = decodeURIComponent(sha || "").trim();

  if (!cleanOwner || !cleanRepo || !SHA_PATTERN.test(cleanSha)) {
    return null;
  }
  return { owner: cleanOwner, repo: cleanRepo, sha: cleanSha };
}

function parseGitHubUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  const path = url.pathname.split("/").filter(Boolean);

  if ((hostname === "github.com" || hostname === "www.github.com")
      && path.length >= 4 && path[2] === "commit") {
    return validateParts(path[0], path[1], path[3]);
  }

  if (hostname === "api.github.com"
      && path.length >= 5 && path[0] === "repos" && path[3] === "commits") {
    return validateParts(path[1], path[2], path[4]);
  }

  return null;
}

function repositoryFromUrl(input) {
  try {
    const url = new URL(input);
    if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) {
      return null;
    }
    const path = url.pathname.split("/").filter(Boolean);
    if (path.length < 2) return null;
    return {
      owner: decodeURIComponent(path[0]),
      repo: cleanRepoName(decodeURIComponent(path[1])),
    };
  } catch {
    return null;
  }
}

/**
 * Supported forms:
 *   https://github.com/owner/repo/commit/sha
 *   owner/repo@sha
 *   owner/repo/commit/sha
 *   sha (when the current tab points to the repository)
 */
export function parseCommitInput(input, currentTabUrl = "") {
  const value = String(input || "").trim();
  if (!value) {
    throw new GitHubError("لینک یا شناسه کامیت را وارد کنید.", { code: "invalid_input" });
  }

  const asUrl = parseGitHubUrl(value);
  if (asUrl) return asUrl;

  const shorthand = value.match(/^([^/@\s]+)\/([^@\s/]+)@([0-9a-f]{7,40})$/i);
  if (shorthand) {
    return validateParts(shorthand[1], shorthand[2], shorthand[3]);
  }

  const pathForm = value.match(/^([^/\s]+)\/([^/\s]+)\/commit\/([0-9a-f]{7,40})(?:[/?#].*)?$/i);
  if (pathForm) {
    return validateParts(pathForm[1], pathForm[2], pathForm[3]);
  }

  if (SHA_PATTERN.test(value)) {
    const repository = repositoryFromUrl(currentTabUrl);
    if (repository) {
      return { ...repository, sha: value };
    }
    throw new GitHubError(
      "برای شناسه کوتاه، افزونه را داخل صفحه همان مخزن باز کنید یا لینک کامل کامیت را بدهید.",
      { code: "missing_repository" },
    );
  }

  throw new GitHubError(
    "فرمت ورودی معتبر نیست. یک لینک کامل کامیت گیت‌هاب وارد کنید.",
    { code: "invalid_input" },
  );
}

function headers(token, accept = "application/vnd.github+json") {
  const result = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

async function errorFromResponse(response) {
  let apiMessage = "";
  try {
    const body = await response.clone().json();
    apiMessage = body.message || "";
  } catch {
    // A raw response may not be JSON.
  }

  if (response.status === 401) {
    return new GitHubError("توکن گیت‌هاب نامعتبر یا منقضی شده است.", {
      status: 401,
      code: "bad_token",
      details: apiMessage,
    });
  }
  if (response.status === 404) {
    return new GitHubError(
      "کامیت پیدا نشد. آدرس را بررسی کنید؛ برای مخزن خصوصی نیز توکن لازم است.",
      { status: 404, code: "not_found", details: apiMessage },
    );
  }
  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const message = remaining === "0"
      ? "محدودیت درخواست گیت‌هاب تمام شده است. کمی بعد تلاش کنید یا یک توکن اضافه کنید."
      : "گیت‌هاب اجازه این درخواست را نداد. دسترسی توکن و مخزن را بررسی کنید.";
    return new GitHubError(message, {
      status: response.status,
      code: remaining === "0" ? "rate_limit" : "forbidden",
      details: apiMessage,
    });
  }
  if (response.status === 422) {
    return new GitHubError("شناسه کامیت معتبر نیست.", {
      status: 422,
      code: "unprocessable",
      details: apiMessage,
    });
  }

  return new GitHubError(`خطای گیت‌هاب (${response.status})؛ دوباره تلاش کنید.`, {
    status: response.status,
    code: "http_error",
    details: apiMessage,
  });
}

function hasNextPage(linkHeader) {
  if (!linkHeader) return false;
  return linkHeader.split(",").some((part) => /rel="next"/.test(part));
}

export async function getCommit({ owner, repo, sha }, { token = "", signal } = {}) {
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const encodedSha = encodeURIComponent(sha);
  const endpoint = `${GITHUB_API}/repos/${encodedOwner}/${encodedRepo}/commits/${encodedSha}`;

  let page = 1;
  let commit = null;
  const files = [];

  do {
    const response = await fetch(`${endpoint}?per_page=100&page=${page}`, {
      headers: headers(token),
      signal,
    });
    if (!response.ok) throw await errorFromResponse(response);

    const data = await response.json();
    if (!commit) commit = data;
    if (Array.isArray(data.files)) files.push(...data.files);

    if (!hasNextPage(response.headers.get("link"))) break;
    page += 1;
  } while (page <= 30); // GitHub documents a maximum of 3,000 files here.

  const uniqueFiles = [...new Map(files.map((file) => [file.filename, file])).values()];
  return {
    ...commit,
    files: uniqueFiles,
    filesMayBeTruncated: uniqueFiles.length >= 3000,
  };
}

function rawContentUrl(owner, repo, commitSha, filename) {
  const path = filename.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(commitSha)}/${path}`;
}

async function fetchBlobViaApi({ owner, repo, file }, { token, signal }) {
  const endpoint = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(file.sha)}`;
  const response = await fetch(endpoint, {
    headers: headers(token, "application/vnd.github.raw+json"),
    signal,
  });
  if (!response.ok) throw await errorFromResponse(response);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchFile({ owner, repo, commitSha, file }, { token, signal }) {
  // Authenticated API requests work for private repositories. For public
  // repositories without a token, raw.githubusercontent.com avoids spending
  // one API rate-limit unit for every file.
  if (token) {
    return fetchBlobViaApi({ owner, repo, file }, { token, signal });
  }

  try {
    const response = await fetch(rawContentUrl(owner, repo, commitSha, file.filename), {
      signal,
      redirect: "follow",
    });
    if (response.ok) return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    // Cancellation must remain immediate. Network/CORS failures, however, can
    // still succeed through the Git blobs API below.
    if (error?.name === "AbortError") throw error;
  }

  // Fallback handles uncommon raw-host, network, or CORS failures while
  // retaining a useful, localized GitHub API error.
  return fetchBlobViaApi({ owner, repo, file }, { token: "", signal });
}

/** Download changed files with a small worker pool to avoid browser/API spikes. */
export async function downloadChangedFiles(
  { owner, repo, commitSha, files },
  { token = "", signal, concurrency = 4, onProgress = () => {} } = {},
) {
  const downloadable = files.filter((file) => file.status !== "removed");
  const entries = new Array(downloadable.length);
  const failures = [];
  let nextIndex = 0;
  let completed = 0;
  let totalBytes = 0;

  async function worker() {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const index = nextIndex;
      nextIndex += 1;
      if (index >= downloadable.length) return;

      const file = downloadable[index];
      onProgress({ completed, total: downloadable.length, totalBytes, current: file.filename });
      try {
        const data = await fetchFile(
          { owner, repo, commitSha, file },
          { token, signal },
        );
        entries[index] = { name: file.filename, data };
        totalBytes += data.byteLength;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        failures.push({ filename: file.filename, error });
      } finally {
        completed += 1;
        onProgress({ completed, total: downloadable.length, totalBytes, current: file.filename });
      }
    }
  }

  const workerCount = Math.min(concurrency, Math.max(1, downloadable.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (failures.length) {
    const error = new GitHubError(
      `دریافت ${failures.length.toLocaleString("fa-IR")} فایل ناموفق بود و ZIP ناقص ساخته نشد.`,
      { code: "file_download_failed", details: failures },
    );
    error.failures = failures;
    throw error;
  }

  return {
    entries: entries.filter(Boolean),
    totalBytes,
    removedCount: files.length - downloadable.length,
  };
}

export function makeArchiveName(owner, repo, sha) {
  const clean = (value) => String(value).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return `${clean(owner)}-${clean(repo)}-${clean(sha).slice(0, 7)}-changed-files.zip`;
}
