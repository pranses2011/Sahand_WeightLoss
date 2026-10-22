import {
  GitHubError,
  downloadChangedFiles,
  getCommit,
  makeArchiveName,
  parseCommitInput,
} from "./lib/github.js";
import { createZip } from "./lib/zip.js";

const elements = {
  form: document.querySelector("#download-form"),
  input: document.querySelector("#commit-input"),
  inputWrap: document.querySelector("#input-wrap"),
  clearInput: document.querySelector("#clear-input"),
  pageDetected: document.querySelector("#page-detected"),
  formatHint: document.querySelector("#format-hint"),
  tokenPanel: document.querySelector("#token-panel"),
  tokenInput: document.querySelector("#token-input"),
  tokenOptional: document.querySelector(".optional"),
  rememberToken: document.querySelector("#remember-token"),
  toggleToken: document.querySelector("#toggle-token"),
  downloadButton: document.querySelector("#download-button"),
  downloadButtonText: document.querySelector("#download-button span"),
  cancelButton: document.querySelector("#cancel-button"),
  errorMessage: document.querySelector("#error-message"),
  errorTitle: document.querySelector("#error-title"),
  errorText: document.querySelector("#error-text"),
  errorFiles: document.querySelector("#error-files"),
  commitCard: document.querySelector("#commit-card"),
  commitSha: document.querySelector("#commit-sha"),
  commitMessage: document.querySelector("#commit-message"),
  commitAuthor: document.querySelector("#commit-author"),
  commitDate: document.querySelector("#commit-date"),
  fileStats: document.querySelector("#file-stats"),
  truncateWarning: document.querySelector("#truncate-warning"),
  progressCard: document.querySelector("#progress-card"),
  progressKicker: document.querySelector("#progress-kicker"),
  progressTitle: document.querySelector("#progress-title"),
  progressPercent: document.querySelector("#progress-percent"),
  progressBar: document.querySelector("#progress-bar"),
  progressTrack: document.querySelector(".progress-track"),
  progressDetail: document.querySelector("#progress-detail"),
  progressSize: document.querySelector("#progress-size"),
  successMessage: document.querySelector("#success-message"),
  successText: document.querySelector("#success-text"),
};

let currentTabUrl = "";
let detectedUrl = "";
let activeController = null;

function formatNumber(value) {
  return Number(value || 0).toLocaleString("fa-IR");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** index);
  return `${new Intl.NumberFormat("fa-IR", { maximumFractionDigits: index ? 1 : 0 }).format(value)} ${units[index]}`;
}

function setInputState() {
  const hasValue = Boolean(elements.input.value.trim());
  elements.inputWrap.classList.toggle("has-value", hasValue);
  const isDetected = Boolean(detectedUrl) && elements.input.value.trim() === detectedUrl;
  elements.pageDetected.hidden = !isDetected;
  elements.formatHint.hidden = isDetected;
}

function hideMessages() {
  elements.errorMessage.hidden = true;
  elements.successMessage.hidden = true;
  elements.inputWrap.classList.remove("invalid");
}

function showError(error) {
  elements.progressCard.hidden = true;
  elements.successMessage.hidden = true;
  elements.errorMessage.hidden = false;
  elements.errorTitle.textContent = error?.code === "invalid_input" || error?.code === "missing_repository"
    ? "ورودی را بررسی کنید"
    : "عملیات کامل نشد";
  elements.errorText.textContent = error?.message || "خطای پیش‌بینی‌نشده‌ای رخ داد. دوباره تلاش کنید.";

  const failures = error?.failures || (Array.isArray(error?.details) ? error.details : []);
  elements.errorFiles.replaceChildren();
  if (failures.length) {
    for (const failure of failures.slice(0, 4)) {
      const item = document.createElement("li");
      item.textContent = failure.filename;
      elements.errorFiles.append(item);
    }
    if (failures.length > 4) {
      const item = document.createElement("li");
      item.textContent = `… و ${formatNumber(failures.length - 4)} فایل دیگر`;
      item.dir = "rtl";
      elements.errorFiles.append(item);
    }
    elements.errorFiles.hidden = false;
  } else {
    elements.errorFiles.hidden = true;
  }

  if (error?.code === "invalid_input" || error?.code === "missing_repository") {
    elements.inputWrap.classList.add("invalid");
    elements.input.focus();
  }
}

function setBusy(busy) {
  elements.downloadButton.disabled = busy;
  elements.input.disabled = busy;
  elements.tokenInput.disabled = busy;
  elements.clearInput.disabled = busy;
  elements.cancelButton.hidden = !busy;
  elements.downloadButtonText.textContent = busy ? "در حال آماده‌سازی…" : "ساخت و دانلود ZIP";
}

function setProgress({ kicker, title, percent = null, detail = "", bytes = 0, indeterminate = false }) {
  elements.progressCard.hidden = false;
  elements.progressCard.classList.toggle("indeterminate", indeterminate);
  elements.progressKicker.textContent = kicker;
  elements.progressTitle.textContent = title;
  elements.progressDetail.textContent = detail;
  elements.progressDetail.dir = detail.includes("/") || detail.includes(".") ? "ltr" : "rtl";
  elements.progressSize.textContent = formatBytes(bytes);

  const safePercent = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  elements.progressPercent.textContent = percent === null ? "—" : `${formatNumber(Math.round(safePercent))}٪`;
  elements.progressBar.style.width = indeterminate ? "" : `${safePercent}%`;
  elements.progressTrack.setAttribute("aria-valuenow", String(Math.round(safePercent)));
}

function countStatuses(files) {
  const counts = { added: 0, modified: 0, renamed: 0, removed: 0 };
  for (const file of files) {
    if (file.status === "removed") counts.removed += 1;
    else if (file.status === "renamed") counts.renamed += 1;
    else if (file.status === "added" || file.status === "copied") counts.added += 1;
    else counts.modified += 1;
  }
  return counts;
}

function showCommit(commit) {
  const author = commit.commit?.author?.name || commit.author?.login || "نویسنده نامشخص";
  const rawDate = commit.commit?.author?.date;
  const date = rawDate ? new Date(rawDate) : null;
  const message = commit.commit?.message?.split("\n")[0] || "بدون پیام";

  elements.commitSha.textContent = commit.sha.slice(0, 7);
  elements.commitMessage.textContent = message;
  elements.commitAuthor.textContent = author;
  elements.commitDate.textContent = date && !Number.isNaN(date.valueOf())
    ? new Intl.DateTimeFormat("fa-IR", { year: "numeric", month: "short", day: "numeric" }).format(date)
    : "تاریخ نامشخص";
  if (date) elements.commitDate.dateTime = date.toISOString();

  const labels = {
    added: "افزوده",
    modified: "ویرایش‌شده",
    renamed: "تغییرنام",
    removed: "حذف‌شده",
  };
  elements.fileStats.replaceChildren();
  const counts = countStatuses(commit.files || []);
  for (const [status, count] of Object.entries(counts)) {
    if (!count) continue;
    const stat = document.createElement("span");
    stat.className = `stat ${status}`;
    stat.textContent = `${formatNumber(count)} ${labels[status]}`;
    elements.fileStats.append(stat);
  }
  elements.truncateWarning.hidden = !commit.filesMayBeTruncated;
  elements.commitCard.hidden = false;
}

async function saveTokenPreference(token) {
  if (elements.rememberToken.checked && token) {
    await chrome.storage.local.set({ githubToken: token });
  } else {
    await chrome.storage.local.remove("githubToken");
  }
}

function startDownload(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: true }, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(downloadId);
    });
  });
}

async function handleSubmit(event) {
  event.preventDefault();
  if (activeController) return;

  hideMessages();
  elements.commitCard.hidden = true;

  let target;
  try {
    target = parseCommitInput(elements.input.value, currentTabUrl);
  } catch (error) {
    showError(error);
    return;
  }

  const token = elements.tokenInput.value.trim();
  activeController = new AbortController();
  setBusy(true);

  try {
    await saveTokenPreference(token);
    setProgress({
      kicker: "مرحله ۱ از ۳",
      title: "دریافت اطلاعات کامیت…",
      detail: `${target.owner}/${target.repo}`,
      indeterminate: true,
    });

    const commit = await getCommit(target, {
      token,
      signal: activeController.signal,
    });
    showCommit(commit);

    const availableFiles = commit.files.filter((file) => file.status !== "removed");
    if (!availableFiles.length) {
      throw new GitHubError(
        commit.files.length
          ? "این کامیت فقط شامل فایل‌های حذف‌شده است و فایلی از نسخه نهایی برای ZIP وجود ندارد."
          : "این کامیت فایل تغییرکرده‌ای ندارد.",
        { code: "no_downloadable_files" },
      );
    }

    setProgress({
      kicker: "مرحله ۲ از ۳",
      title: "دریافت فایل‌های تغییرکرده…",
      percent: 0,
      detail: `۰ از ${formatNumber(availableFiles.length)} فایل`,
    });

    const downloaded = await downloadChangedFiles(
      {
        owner: target.owner,
        repo: target.repo,
        commitSha: commit.sha,
        files: commit.files,
      },
      {
        token,
        signal: activeController.signal,
        concurrency: 4,
        onProgress: ({ completed, total, totalBytes, current }) => {
          const percent = total ? (completed / total) * 92 : 92;
          setProgress({
            kicker: "مرحله ۲ از ۳",
            title: completed === total ? "دریافت فایل‌ها کامل شد" : "دریافت فایل‌های تغییرکرده…",
            percent,
            detail: current || `${formatNumber(completed)} از ${formatNumber(total)} فایل`,
            bytes: totalBytes,
          });
        },
      },
    );

    setProgress({
      kicker: "مرحله ۳ از ۳",
      title: "ساخت فایل ZIP…",
      percent: 96,
      detail: `${formatNumber(downloaded.entries.length)} فایل`,
      bytes: downloaded.totalBytes,
    });

    // Yield once so the final progress state is painted before ZIP headers and
    // checksums are generated for large files.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const commitDate = new Date(commit.commit?.author?.date || Date.now());
    const archive = createZip(downloaded.entries, { modifiedAt: commitDate });
    const archiveUrl = URL.createObjectURL(archive);
    const filename = makeArchiveName(target.owner, target.repo, commit.sha);

    try {
      await startDownload(archiveUrl, filename);
    } finally {
      setTimeout(() => URL.revokeObjectURL(archiveUrl), 60_000);
    }

    setProgress({
      kicker: "کامل شد",
      title: "ZIP برای دانلود فرستاده شد",
      percent: 100,
      detail: filename,
      bytes: archive.size,
    });

    const removedNote = downloaded.removedCount
      ? ` ${formatNumber(downloaded.removedCount)} فایل حذف‌شده، چون در نسخه نهایی وجود ندارد، کنار گذاشته شد.`
      : "";
    elements.successText.textContent = `${formatNumber(downloaded.entries.length)} فایل با ساختار اصلی پوشه‌ها آماده شد.${removedNote}`;
    elements.successMessage.hidden = false;
  } catch (error) {
    if (error?.name === "AbortError") {
      showError(new GitHubError("عملیات به درخواست شما لغو شد.", { code: "cancelled" }));
    } else {
      showError(error);
    }
  } finally {
    activeController = null;
    setBusy(false);
  }
}

async function initialize() {
  elements.form.addEventListener("submit", handleSubmit);
  elements.input.addEventListener("input", () => {
    elements.inputWrap.classList.remove("invalid");
    elements.errorMessage.hidden = true;
    setInputState();
  });
  elements.clearInput.addEventListener("click", () => {
    elements.input.value = "";
    detectedUrl = "";
    setInputState();
    elements.input.focus();
  });
  elements.cancelButton.addEventListener("click", () => activeController?.abort());
  elements.toggleToken.addEventListener("click", () => {
    const visible = elements.tokenInput.type === "text";
    elements.tokenInput.type = visible ? "password" : "text";
    elements.toggleToken.classList.toggle("visible", !visible);
    elements.toggleToken.setAttribute("aria-label", visible ? "نمایش توکن" : "پنهان کردن توکن");
  });

  try {
    const stored = await chrome.storage.local.get("githubToken");
    if (stored.githubToken) {
      elements.tokenInput.value = stored.githubToken;
      elements.rememberToken.checked = true;
      elements.tokenOptional.textContent = "ذخیره‌شده";
    }
  } catch {
    // Storage is a convenience; the core flow works without it.
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabUrl = tab?.url || "";
    const parsed = parseCommitInput(currentTabUrl, currentTabUrl);
    if (parsed) {
      detectedUrl = currentTabUrl;
      elements.input.value = currentTabUrl;
    }
  } catch {
    // The current page is not a GitHub commit, so leave the input empty.
  }

  setInputState();
  if (!elements.input.value) elements.input.focus();
}

initialize();
