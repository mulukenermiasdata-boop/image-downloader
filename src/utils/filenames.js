/**
 * Filename generation + sanitising for chrome.downloads.
 * Pure functions; unit tested in test/run-tests.mjs.
 */
(function (global) {
  'use strict';
  const IMGDL = (global.IMGDL = global.IMGDL || {});
  if (IMGDL.filenames) return;
  const C = IMGDL.C;
  const N = IMGDL.normalizer;

  const MAX_LEN = C.LIMITS.MAX_FILENAME_LENGTH;
  // Windows reserved device names; Chrome refuses these on every platform.
  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'by',
    'with', 'image', 'images', 'photo', 'picture', 'png', 'jpg', 'jpeg', 'webp'
  ]);

  /** Make one path segment safe. Never returns an empty string. */
  function sanitize(value, maxLength) {
    const limit = maxLength || MAX_LEN;
    let out = String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/[\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/-{2,}/g, '-')
      .trim()
      .replace(/^[.\-\s]+/, '')
      .replace(/[.\-\s]+$/, '');
    if (RESERVED.test(out)) out = '_' + out;
    if (out.length > limit) out = out.slice(0, limit).replace(/[.\-\s]+$/, '');
    return out || 'image';
  }

  /**
   * Sanitise a *filename*, keeping its extension intact when the name has to
   * be shortened. Plain sanitize() truncates blindly, which silently turns
   * "long-title.zip" into "long-titl" and leaves the OS with no file type.
   */
  function sanitizeFilename(value, maxLength) {
    const limit = maxLength || MAX_LEN;
    const raw = String(value == null ? '' : value);
    const match = /^(.*)\.([A-Za-z0-9]{1,5})$/.exec(raw);
    if (!match || !match[1]) return sanitize(raw, limit);
    const ext = match[2].toLowerCase();
    const base = sanitize(match[1], Math.max(1, limit - ext.length - 1));
    return base + '.' + ext;
  }

  /**
   * The single place a ZIP archive gets its name. Always returns a sanitised
   * name ending in ".zip" — never left to the blob URL, the page title or any
   * browser inference.
   */
  function archiveName(pageTitle, pageUrl) {
    let base = sanitizeFilename(String(pageTitle || '').trim(), MAX_LEN - 4);
    if (!base || base === 'image') {
      base = sanitize(N.hostOf(pageUrl || '') || 'images', MAX_LEN - 4);
    }
    base = base.replace(/\.zip$/i, '').replace(/[.\s]+$/, '');
    if (!base) base = 'images';
    return base + '.zip';
  }

  function slugify(value, maxWords) {
    const words = String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/['\u2019\u02bc]/g, '')
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const kept = [];
    for (const word of words) {
      if (kept.length >= (maxWords || 8)) break;
      if (STOP_WORDS.has(word) && kept.length) continue;
      if (STOP_WORDS.has(word) && !kept.length && words.length > 1) continue;
      kept.push(word);
    }
    return kept.join('-');
  }

  function extensionFor(format) {
    if (!format || format === 'unknown') return '';
    return format === 'jpg' ? 'jpg' : format;
  }

  /** Replace/append the extension implied by `format`. */
  function ensureExtension(name, format) {
    const ext = extensionFor(format);
    const base = sanitize(name.replace(/\.[A-Za-z0-9]{1,5}$/, ''), MAX_LEN - (ext.length + 1));
    if (!ext) return base;
    return base + '.' + ext;
  }

  /** The filename the server would have given you. */
  function filenameFromUrl(url, format) {
    // data: and blob: URLs have no path to take a name from. Parsing them as
    // one yields garbage like "svg+xml;charset=utf-8,%3Csvg.svg", so name them
    // from a stable hash of the source instead.
    const scheme = /^(data|blob):/i.exec(String(url || ''));
    if (scheme) {
      const resolved = format || N.guessFormat(url);
      const stem = 'image-' + N.stableHash(String(url)).slice(0, 8);
      return resolved && resolved !== 'unknown' ? ensureExtension(stem, resolved) : sanitize(stem);
    }

    let raw = '';
    try {
      const parsed = new URL(url);
      raw = N.decodeURIComponentSafe(parsed.pathname.split('/').filter(Boolean).pop() || '');
    } catch (_) {
      raw = String(url || '').split(/[?#]/)[0].split('/').pop() || '';
    }
    raw = raw.replace(/=[-a-z0-9]{2,40}$/i, ''); // googleusercontent transform suffix
    const { base } = N.splitExtension(raw);
    const clean = sanitize(base || 'image');
    if (!clean || clean === 'image') {
      const fallback = 'image-' + N.stableHash(String(url)).slice(0, 6);
      return ensureExtension(fallback, format || N.guessFormat(url));
    }
    return ensureExtension(clean, format || N.guessFormat(url));
  }

  /**
   * A descriptive name built from what the page already tells us.
   * Priority: alt text -> title -> a meaningful URL filename -> page title.
   */
  function smartFilename(info) {
    const data = info || {};
    const format = data.format || N.guessFormat(data.url);
    const parts = [];

    const altSlug = slugify(data.alt, 8);
    const titleSlug = slugify(data.title, 8);
    const urlSlug = slugify(rawUrlBase(data.url), 8);
    const pageSlug = slugify(data.pageTitle, 4);

    if (altSlug.length >= 3) parts.push(altSlug);
    else if (titleSlug.length >= 3) parts.push(titleSlug);
    else if (urlSlug.length >= 4 && !isOpaque(urlSlug)) parts.push(urlSlug);
    else if (data.nearbyText) parts.push(slugify(data.nearbyText, 6));

    if (!parts.length && pageSlug) parts.push(pageSlug);
    if (!parts.length) parts.push('image');

    // Disambiguate names that carry no information of their own.
    const joined = parts.join('-');
    const needsDetail = joined.length < 6 || N.isGenericName(joined);
    if (needsDetail && pageSlug && !joined.includes(pageSlug)) parts.unshift(pageSlug);
    if (needsDetail && data.width && data.height) parts.push(data.width + 'x' + data.height);
    if (data.index != null && data.forceIndex) parts.push(String(data.index + 1).padStart(2, '0'));

    return ensureExtension(parts.filter(Boolean).join('-'), format);
  }

  function rawUrlBase(url) {
    try {
      const parsed = new URL(url);
      const file = N.decodeURIComponentSafe(parsed.pathname.split('/').filter(Boolean).pop() || '');
      return N.stripSizeTokens(N.splitExtension(file).base);
    } catch (_) {
      return '';
    }
  }

  /** Hex blobs and hashes make terrible filenames. */
  function isOpaque(slug) {
    const compact = slug.replace(/-/g, '');
    if (compact.length >= 16 && /^[0-9a-f]+$/i.test(compact)) return true;
    if (/^[0-9]+$/.test(compact)) return true;
    const letters = compact.replace(/[^a-z]/gi, '').length;
    const digits = compact.replace(/[^0-9]/g, '').length;
    return compact.length >= 12 && digits >= letters;
  }

  /** Turn a page title into a folder name. */
  function folderNameFromPage(pageTitle, pageUrl) {
    const slug = sanitize(String(pageTitle || '').slice(0, 60), 60);
    if (slug && slug !== 'image') return slug;
    const host = N.hostOf(pageUrl || '');
    return sanitize(host || 'images', 60);
  }

  /**
   * Append " (1)", " (2)"… so a batch never silently overwrites itself.
   * Matches the style Chrome itself uses for download conflicts, so files that
   * land via chrome.downloads and files inside a ZIP are named the same way.
   */
  function uniquify(name, used) {
    if (!used.has(name)) { used.add(name); return name; }
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let counter = 1;
    let attempt;
    do {
      attempt = base + ' (' + counter + ')' + ext;
      counter++;
    } while (used.has(attempt) && counter < 10000);
    used.add(attempt);
    return attempt;
  }

  /**
   * Join sanitised segments into a chrome.downloads-safe relative path.
   * Directory segments are capped short; the final segment is treated as a
   * filename so shortening can never strip its extension.
   */
  function joinPath() {
    const parts = [];
    for (let i = 0; i < arguments.length; i++) {
      const raw = arguments[i];
      if (!raw) continue;
      for (const part of String(raw).split('/')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        // "." and ".." must never survive into a download path.
        if (/^\.+$/.test(trimmed)) continue;
        parts.push(part);
      }
    }
    if (!parts.length) return '';
    const file = sanitizeFilename(parts.pop(), MAX_LEN);
    const dirs = parts.map((part) => sanitize(part, 60)).filter(Boolean);
    return dirs.concat(file).join('/');
  }

  /**
   * Replace the extension on a relative download path without disturbing its
   * folders. Routing through joinPath also re-sanitises, so a name derived
   * from a remote URL can never climb out of the download directory.
   */
  function pathWithExtension(path, extension) {
    const raw = String(path == null ? '' : path);
    const slash = raw.lastIndexOf('/');
    const dir = slash >= 0 ? raw.slice(0, slash) : '';
    const file = slash >= 0 ? raw.slice(slash + 1) : raw;
    return joinPath(dir, extension ? ensureExtension(file, extension) : file);
  }

  /** uniquify() applied to the filename part of a path, leaving folders alone. */
  function uniquePath(path, used) {
    const raw = String(path == null ? '' : path);
    const slash = raw.lastIndexOf('/');
    const dir = slash >= 0 ? raw.slice(0, slash) : '';
    const file = slash >= 0 ? raw.slice(slash + 1) : raw;
    return joinPath(dir, uniquify(sanitizeFilename(file, MAX_LEN), used));
  }

  IMGDL.filenames = {
    archiveName,
    ensureExtension,
    extensionFor,
    filenameFromUrl,
    folderNameFromPage,
    isOpaque,
    joinPath,
    pathWithExtension,
    sanitize,
    sanitizeFilename,
    slugify,
    smartFilename,
    uniquePath,
    uniquify
  };
})(typeof self !== 'undefined' ? self : globalThis);
