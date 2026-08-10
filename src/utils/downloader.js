/**
 * Download planning (pure) + chrome.downloads execution (with fallback to the
 * next-best candidate when a derived/original URL 404s).
 */
(function (global) {
  'use strict';
  const IMGDL = (global.IMGDL = global.IMGDL || {});
  if (IMGDL.downloader) return;
  const C = IMGDL.C;
  const N = IMGDL.normalizer;
  const F = IMGDL.filenames;
  const D = IMGDL.dedupe;

  /* ------------------------------------------------------------------ *
   * Planning (pure — unit tested)
   * ------------------------------------------------------------------ */

  /**
   * Turn selected groups into concrete download tasks.
   *
   * @param {Array} groups groups produced by dedupe.groupCandidates
   * @param {Object} settings
   * @param {{title?: string, url?: string}} pageInfo
   * @returns {Array<{url:string, fallbacks:string[], filename:string, path:string,
   *                  sourceFormat:string, targetFormat:string, needsBytes:boolean}>}
   */
  function planDownloads(groups, settings, pageInfo) {
    const config = Object.assign({}, C.DEFAULT_SETTINGS, settings || {});
    const page = pageInfo || {};
    const used = new Set();
    const folders = [];
    if (config.downloadFolder) folders.push(config.downloadFolder);
    if (config.folderPerPage) folders.push(F.folderNameFromPage(page.title, page.url));

    return groups.map((group, index) => {
      // group.best already reflects the "prefer highest quality" setting,
      // so the card and the file that lands on disk can never disagree.
      const best = group.best || group;
      const ranked = group.candidates ? D.rankCandidates(group) : [best];
      const sourceFormat = best.format || N.guessFormat(best.url);
      const wantsConvert = config.format && config.format !== 'original' &&
        IMGDL.converter.needsConversion(sourceFormat, config.format);
      const targetFormat = wantsConvert ? config.format : sourceFormat;

      const baseName = config.naming === 'smart'
        ? F.smartFilename({
          url: best.url,
          alt: group.alt || best.alt,
          title: group.title || best.title,
          pageTitle: page.title,
          width: group.width,
          height: group.height,
          format: targetFormat,
          index
        })
        : F.ensureExtension(F.filenameFromUrl(best.url, sourceFormat), targetFormat);

      const filename = F.uniquify(F.sanitize(baseName), used);
      const path = F.joinPath(folders.join('/'), filename);

      return {
        id: group.id || best.url,
        url: best.url,
        fallbacks: ranked.map((candidate) => candidate.url).filter((url) => url !== best.url).slice(0, 3),
        filename,
        path,
        sourceFormat,
        targetFormat,
        needsBytes: wantsConvert || Boolean(config.zip),
        width: group.width || 0,
        height: group.height || 0,
        svgSource: group.svgSource || best.svgSource || ''
      };
    });
  }

  /**
   * The narrowest match pattern that lets the extension fetch this image.
   * Returns '' for data:/blob:/anything not http(s) — those need no permission.
   */
  function originPattern(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return parsed.origin + '/*';
    } catch (_) {
      return '';
    }
  }

  /**
   * Distinct origin patterns for a batch, skipping the page's own origin —
   * the content script can already read those without any extension
   * permission, so asking the user for them would be noise.
   */
  function distinctOrigins(urls, skipPattern) {
    const out = [];
    for (const url of urls || []) {
      const pattern = originPattern(url);
      if (!pattern || pattern === skipPattern) continue;
      if (out.indexOf(pattern) === -1) out.push(pattern);
    }
    return out;
  }

  /**
   * The name a file gets inside a ZIP.
   *
   * In "Original format" mode the bytes are stored untouched, so the extension
   * must describe what they actually are — a CDN serving AVIF from a ".jpg"
   * URL would otherwise produce an archive full of files that no viewer opens.
   * When the user asked for a conversion the encoder already decided the
   * format, so the planned extension is correct by construction.
   *
   * @param {string} plannedName filename from the download plan
   * @param {{extension: string}|null} detected result of normalizer.detectImageFormat
   * @param {{converted?: boolean}} [options]
   */
  function archiveEntryName(plannedName, detected, options) {
    const name = String(plannedName || 'image');
    if (options && options.converted) return name;
    if (!detected || !detected.extension) return name;
    return F.ensureExtension(name, detected.extension);
  }

  /* ------------------------------------------------------------------ *
   * Execution
   * ------------------------------------------------------------------ */

  function downloadOnce(options) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (listener) chrome.downloads.onChanged.removeListener(listener);
        clearTimeout(timer);
        fn(value);
      };

      let listener = null;
      let timer = null;
      let downloadId = null;

      listener = (delta) => {
        if (downloadId == null || delta.id !== downloadId) return;
        if (delta.error && delta.error.current) {
          finish(reject, new Error(delta.error.current));
        } else if (delta.state && delta.state.current === 'complete') {
          finish(resolve, downloadId);
        } else if (delta.state && delta.state.current === 'interrupted') {
          finish(reject, new Error('interrupted'));
        }
      };
      chrome.downloads.onChanged.addListener(listener);

      chrome.downloads.download(options, (id) => {
        if (chrome.runtime.lastError || id == null) {
          finish(reject, new Error(chrome.runtime.lastError
            ? chrome.runtime.lastError.message
            : 'Download was not started.'));
          return;
        }
        downloadId = id;
        // Some downloads never emit a terminal state (e.g. handed to a viewer);
        // treat "started and still alive" as success after a grace period.
        timer = setTimeout(() => finish(resolve, id), 20000);
      });
    });
  }

  /**
   * Download a task's URL, retrying with progressively lower-ranked candidate
   * URLs when the preferred one fails (derived "original" URLs can 404).
   */
  async function downloadWithFallback(task, extra) {
    const urls = [task.url].concat(task.fallbacks || []);
    let lastError = null;
    for (const url of urls) {
      try {
        return await downloadOnce(Object.assign({
          url,
          filename: task.path || task.filename,
          conflictAction: 'uniquify',
          saveAs: false
        }, extra || {}));
      } catch (error) {
        lastError = error;
        // The user cancelling or the disk refusing the write are decisions, not
        // transport failures — retrying the same image would fight the user.
        if (isTerminalError(error)) break;
      }
    }
    throw lastError || new Error('Download failed.');
  }

  function isTerminalError(error) {
    return /USER_CANCELED|USER_SHUTDOWN|FILE_ACCESS_DENIED|FILE_NO_SPACE|FILE_TOO_LARGE/i
      .test(String((error && error.message) || error));
  }

  /** Run tasks with bounded concurrency; never rejects, reports per-task status. */
  async function runQueue(tasks, worker, concurrency) {
    const limit = Math.max(1, concurrency || C.LIMITS.DOWNLOAD_CONCURRENCY);
    const results = new Array(tasks.length);
    let cursor = 0;

    async function pump() {
      while (cursor < tasks.length) {
        const index = cursor++;
        try {
          results[index] = { ok: true, value: await worker(tasks[index], index) };
        } catch (error) {
          results[index] = { ok: false, error: (error && error.message) || String(error) };
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, pump));
    return results;
  }

  IMGDL.downloader = {
    archiveEntryName, distinctOrigins, downloadOnce, downloadWithFallback, isTerminalError,
    originPattern, planDownloads, runQueue
  };
})(typeof self !== 'undefined' ? self : globalThis);
