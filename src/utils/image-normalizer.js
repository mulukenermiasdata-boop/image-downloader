/**
 * URL-level image intelligence: format detection, srcset/CSS parsing,
 * dimension hints, CDN/proxy unwrapping and the identity key used to decide
 * "these two URLs are the same picture at different sizes".
 *
 * Everything here is pure (no DOM, no chrome APIs) so it can be unit tested.
 */
(function (global) {
  'use strict';
  const IMGDL = (global.IMGDL = global.IMGDL || {});
  if (IMGDL.normalizer) return;
  const C = IMGDL.C;

  const EXT_ALIAS = {
    jpg: 'jpg', jpeg: 'jpg', jpe: 'jpg', jfif: 'jpg',
    png: 'png', apng: 'png',
    webp: 'webp', avif: 'avif', gif: 'gif',
    svg: 'svg', svgz: 'svg',
    bmp: 'bmp', ico: 'ico', cur: 'ico',
    tif: 'tiff', tiff: 'tiff',
    heic: 'heic', heif: 'heic'
  };

  const MIME_TO_EXT = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg',
    'image/png': 'png', 'image/apng': 'png',
    'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif',
    'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/x-ms-bmp': 'bmp',
    'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
    'image/tiff': 'tiff', 'image/heic': 'heic', 'image/heif': 'heic'
  };

  const EXT_TO_MIME = {
    jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif',
    gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
    tiff: 'image/tiff', heic: 'image/heic'
  };

  /* ------------------------------------------------------------------ *
   * Basics
   * ------------------------------------------------------------------ */

  function absoluteUrl(raw, base) {
    if (!raw) return '';
    const value = String(raw).trim();
    if (!value) return '';
    if (/^(javascript|about|mailto|tel):/i.test(value)) return '';
    if (/^data:/i.test(value)) return /^data:image\//i.test(value) ? value : '';
    if (/^blob:/i.test(value)) return value;
    try {
      return new URL(value, base || undefined).href;
    } catch (_) {
      return '';
    }
  }

  function splitExtension(filename) {
    const match = /^(.*?)\.([A-Za-z0-9]{1,5})$/.exec(filename || '');
    if (!match) return { base: filename || '', ext: '' };
    return { base: match[1], ext: match[2].toLowerCase() };
  }

  function pathnameOf(url) {
    try {
      return new URL(url).pathname;
    } catch (_) {
      return String(url || '').split(/[?#]/)[0];
    }
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./i, '');
    } catch (_) {
      return '';
    }
  }

  function dataUrlMime(url) {
    const match = /^data:([^;,]+)/i.exec(url || '');
    return match ? match[1].toLowerCase() : '';
  }

  /** Best-effort file format, normalised to a short lowercase token. */
  function guessFormat(url, mimeHint) {
    if (mimeHint && MIME_TO_EXT[String(mimeHint).toLowerCase()]) {
      return MIME_TO_EXT[String(mimeHint).toLowerCase()];
    }
    if (!url) return 'unknown';
    if (/^data:/i.test(url)) return MIME_TO_EXT[dataUrlMime(url)] || 'unknown';

    const path = pathnameOf(url);
    const { ext } = splitExtension(decodeURIComponentSafe(path.split('/').pop() || ''));
    if (EXT_ALIAS[ext]) return EXT_ALIAS[ext];

    // Extension can hide inside the path (…/image.jpg/large) or a query param.
    const inPath = /\.(jpe?g|png|webp|avif|gif|svgz?|bmp|ico|tiff?|hei[cf])(?=[/?#]|$)/i.exec(path);
    if (inPath) return EXT_ALIAS[inPath[1].toLowerCase()];

    try {
      const params = new URL(url).searchParams;
      for (const key of ['format', 'fm', 'output', 'ext', 'type']) {
        const value = (params.get(key) || '').toLowerCase();
        if (EXT_ALIAS[value]) return EXT_ALIAS[value];
        if (MIME_TO_EXT[value]) return MIME_TO_EXT[value];
      }
    } catch (_) { /* not a parseable URL */ }

    return 'unknown';
  }

  function decodeURIComponentSafe(value) {
    try {
      return decodeURIComponent(value);
    } catch (_) {
      return value;
    }
  }

  function mimeForFormat(format) {
    return EXT_TO_MIME[format] || 'application/octet-stream';
  }

  function looksLikeImageUrl(url) {
    if (!url) return false;
    if (/^data:image\//i.test(url)) return true;
    const path = pathnameOf(url).toLowerCase();
    return new RegExp('\\.(' + C.IMAGE_EXTENSIONS.join('|') + ')(?=[/?#]|$)').test(path);
  }

  /* ------------------------------------------------------------------ *
   * Content sniffing
   * ------------------------------------------------------------------ */

  function toBytes(source) {
    if (!source) return new Uint8Array(0);
    if (source instanceof Uint8Array) return source;
    if (typeof ArrayBuffer !== 'undefined' && source instanceof ArrayBuffer) return new Uint8Array(source);
    if (source.buffer) return new Uint8Array(source.buffer, source.byteOffset || 0, source.byteLength);
    return new Uint8Array(0);
  }

  function ascii(bytes, offset, length) {
    if (offset + length > bytes.length) return '';
    let out = '';
    for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
    return out;
  }

  /** ISO base-media brands, read from the ftyp box (major + compatible). */
  function isoBrands(bytes) {
    const brands = [ascii(bytes, 8, 4)];
    const boxSize = bytes.length >= 4
      ? ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
      : 0;
    const end = Math.min(bytes.length, boxSize > 16 ? boxSize : bytes.length, 8 + 256);
    for (let i = 16; i + 4 <= end; i += 4) brands.push(ascii(bytes, i, 4));
    return brands;
  }

  const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'];

  function looksLikeSvg(bytes) {
    if (typeof TextDecoder === 'undefined') return false;
    let head;
    try {
      head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 1024));
    } catch (_) {
      return false;
    }
    let text = head.replace(/^\uFEFF/, '').replace(/^\s+/, '');
    // Strip anything legally allowed to precede the root element.
    for (let i = 0; i < 6; i++) {
      const stripped = text
        .replace(/^<\?xml[^>]*\?>/i, '')
        .replace(/^<!--[\s\S]*?-->/, '')
        .replace(/^<!DOCTYPE[^>]*>/i, '')
        .replace(/^\s+/, '');
      if (stripped === text) break;
      text = stripped;
    }
    return /^<svg[\s/>]/i.test(text);
  }

  /** Magic-byte identification. Returns '' when the bytes say nothing. */
  function sniffSignature(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
      bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png';
    const gif = ascii(bytes, 0, 6);
    if (gif === 'GIF87a' || gif === 'GIF89a') return 'gif';
    if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
    if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
      const brands = isoBrands(bytes);
      if (brands.indexOf('avif') !== -1 || brands.indexOf('avis') !== -1) return 'avif';
      for (const brand of HEIF_BRANDS) if (brands.indexOf(brand) !== -1) return 'heic';
    }
    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
    if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return 'ico';
    if (bytes.length >= 4 &&
      ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
        (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))) return 'tiff';
    if (looksLikeSvg(bytes)) return 'svg';
    return '';
  }

  /**
   * Work out what an image actually *is*, rather than what its URL claims.
   *
   * A CDN happily serves AVIF bytes from a ".jpg" path, so the magic bytes are
   * authoritative; the HTTP Content-Type is only consulted when the bytes are
   * inconclusive.
   *
   * @param {ArrayBuffer|Uint8Array} source
   * @param {string} [contentType] HTTP Content-Type / Blob.type
   * @returns {{extension: string, mimeType: string}} extension is '' if unknown
   */
  function detectImageFormat(source, contentType) {
    const bytes = toBytes(source);
    const sniffed = sniffSignature(bytes);
    if (sniffed) {
      return { extension: sniffed, mimeType: EXT_TO_MIME[sniffed] || 'application/octet-stream' };
    }
    const declared = String(contentType || '').split(';')[0].trim().toLowerCase();
    const fromType = MIME_TO_EXT[declared];
    if (fromType) return { extension: fromType, mimeType: EXT_TO_MIME[fromType] || declared };
    return { extension: '', mimeType: declared || 'application/octet-stream' };
  }

  /* ------------------------------------------------------------------ *
   * srcset + CSS parsing
   * ------------------------------------------------------------------ */

  /**
   * Parse a srcset attribute into { url, w, d } entries.
   * Handles commas inside URLs (common with Cloudinary transforms) by only
   * splitting on commas that are followed by a descriptor-or-URL boundary.
   */
  function parseSrcset(value) {
    const out = [];
    if (!value) return out;
    const input = String(value);
    let i = 0;
    const len = input.length;

    while (i < len) {
      while (i < len && /[\s,]/.test(input[i])) i++;
      if (i >= len) break;

      let start = i;
      while (i < len && !/\s/.test(input[i])) i++;
      let url = input.slice(start, i);
      // A trailing comma belongs to the separator, not the URL.
      while (url.endsWith(',')) url = url.slice(0, -1);

      // Descriptor part runs until the next comma.
      while (i < len && /\s/.test(input[i])) i++;
      let descriptor = '';
      if (i < len && input[i] !== ',') {
        const dStart = i;
        while (i < len && input[i] !== ',') i++;
        descriptor = input.slice(dStart, i).trim();
      }
      if (i < len && input[i] === ',') i++;

      if (!url) continue;
      const entry = { url, w: 0, d: 0 };
      const wMatch = /(^|\s)(\d+(?:\.\d+)?)w(\s|$)/.exec(descriptor);
      const dMatch = /(^|\s)(\d+(?:\.\d+)?)x(\s|$)/.exec(descriptor);
      if (wMatch) entry.w = Math.round(parseFloat(wMatch[2]));
      if (dMatch) entry.d = parseFloat(dMatch[2]);
      out.push(entry);
    }
    return out;
  }

  /** Pull every url(...) out of a CSS value such as background-image. */
  function extractCssUrls(cssValue) {
    const out = [];
    if (!cssValue || cssValue === 'none') return out;
    const re = /url\(\s*(?:'([^']*)'|"([^"]*)"|([^)]*))\s*\)/gi;
    let match;
    while ((match = re.exec(cssValue))) {
      const url = (match[1] || match[2] || match[3] || '').trim();
      if (url) out.push(url);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Proxy / CDN unwrapping
   * ------------------------------------------------------------------ */

  /**
   * Many sites serve images through a resizing proxy that carries the *real*
   * URL inside itself. Recovering it is a safe, non-speculative way to reach
   * the original: the URL is literally present in the page markup.
   *
   * Returns the inner URL, or '' when this is not a recognised proxy.
   */
  function unwrapProxy(rawUrl, base) {
    if (!rawUrl || /^data:|^blob:/i.test(rawUrl)) return '';
    let url;
    try {
      url = new URL(rawUrl, base || undefined);
    } catch (_) {
      return '';
    }
    const host = url.hostname.toLowerCase();
    const path = url.pathname;

    // Next.js / Nuxt / Vercel image optimiser: /_next/image?url=…&w=…
    if (/\/_next\/image$/.test(path) || /\/_vercel\/image$/.test(path) || /\/_nuxt\/image$/.test(path)) {
      const inner = url.searchParams.get('url');
      if (inner) return absoluteUrl(inner, url.origin);
    }

    // Nuxt image module: /_ipx/<modifiers>/<path>
    const ipx = /^\/_ipx\/[^/]+\/(.+)$/.exec(path);
    if (ipx) return absoluteUrl('/' + ipx[1], url.origin);

    // images.weserv.nl / wsrv.nl: ?url=…
    if (host === 'images.weserv.nl' || host === 'wsrv.nl') {
      const inner = url.searchParams.get('url');
      if (inner) {
        return absoluteUrl(/^https?:\/\//i.test(inner) ? inner : 'https://' + inner);
      }
    }

    // Jetpack Photon: i0.wp.com/example.com/path.jpg
    if (/^i[0-9]\.wp\.com$/.test(host) || host === 'i.wp.com') {
      const inner = path.replace(/^\//, '');
      if (inner.includes('/')) return absoluteUrl('https://' + inner);
    }

    // Cloudflare Images resizing: /cdn-cgi/image/<options>/<rest>
    const cfMatch = /^\/cdn-cgi\/image\/[^/]+\/(.+)$/.exec(path);
    if (cfMatch) {
      const inner = cfMatch[1];
      return /^https?(:|%3A)/i.test(inner)
        ? absoluteUrl(decodeURIComponentSafe(inner))
        : absoluteUrl('/' + inner, url.origin);
    }

    // Cloudinary fetch/remote delivery: /image/fetch/<options>/<encoded url>
    const cloudinary = /\/image\/(?:fetch|remote)\/(?:[^/]+\/)*?(https?(?::|%3A).+)$/i.exec(path);
    if (cloudinary) return absoluteUrl(decodeURIComponentSafe(cloudinary[1]));

    // WordPress.com / generic "?url=" style proxies where the value is a full URL.
    const generic = url.searchParams.get('url') || url.searchParams.get('u') || url.searchParams.get('image_url');
    if (generic && /^https?(:|%3A)\/\//i.test(generic) && host !== hostOf(generic)) {
      return absoluteUrl(decodeURIComponentSafe(generic));
    }

    return '';
  }

  /* ------------------------------------------------------------------ *
   * Dimension hints
   * ------------------------------------------------------------------ */

  const PLAUSIBLE_MIN = 16;
  const PLAUSIBLE_MAX = 30000;

  function plausible(n) {
    return Number.isFinite(n) && n >= PLAUSIBLE_MIN && n <= PLAUSIBLE_MAX;
  }

  /**
   * Read dimensions that the URL itself advertises. Only patterns that are
   * unambiguous are accepted — we never guess from a bare number, because
   * `photo-2019.jpg` is a year, not a width.
   *
   * @returns {{width:number, height:number, confidence:number}} confidence 0 = none.
   */
  function dimensionsFromUrl(rawUrl) {
    const none = { width: 0, height: 0, confidence: 0 };
    if (!rawUrl || /^data:|^blob:/i.test(rawUrl)) return none;

    let url;
    try {
      url = new URL(rawUrl);
    } catch (_) {
      return none;
    }
    const path = decodeURIComponentSafe(url.pathname);
    const filename = path.split('/').pop() || '';

    // 1. filename suffix: name-1200x800.jpg / name_1200x800.jpg
    let m = /[-_.](\d{2,5})x(\d{2,5})(?:[-_.][a-z0-9]+)?\.[a-z0-9]{2,5}$/i.exec(filename);
    if (m && plausible(+m[1]) && plausible(+m[2])) {
      return { width: +m[1], height: +m[2], confidence: 2 };
    }

    // 2. explicit query params
    const params = url.searchParams;
    const qw = firstNumber(params, ['w', 'width', 'wid', 'sw', 'imwidth', 'maxwidth', 'mw']);
    const qh = firstNumber(params, ['h', 'height', 'hei', 'sh', 'maxheight', 'mh']);
    if (plausible(qw) && plausible(qh)) return { width: qw, height: qh, confidence: 2 };
    if (plausible(qw)) return { width: qw, height: 0, confidence: 2 };
    if (plausible(qh)) return { width: 0, height: qh, confidence: 2 };

    // 3. Cloudinary / imgproxy style transform segment: /w_1200,h_800,c_fill/
    m = /(?:^|\/)(?:[a-z]{1,3}_[^,/]+,)*w_(\d{2,5})(?:,[^/]*?h_(\d{2,5}))?(?:,[^/]*)?\//i.exec(path);
    if (m && plausible(+m[1])) {
      return { width: +m[1], height: plausible(+m[2]) ? +m[2] : 0, confidence: 2 };
    }
    m = /(?:^|\/)h_(\d{2,5})(?:,|\/)/i.exec(path);
    if (m && plausible(+m[1])) return { width: 0, height: +m[1], confidence: 2 };

    // 4. path segment: /1200x800/ or /resize/1200x800/ or /fit-in/1200x800/
    m = /\/(?:resize|thumb|thumbs|thumbnail|fit-in|crop|size|s)?\/?(\d{2,5})x(\d{2,5})(?=\/)/i.exec(path);
    if (m && plausible(+m[1]) && plausible(+m[2])) {
      return { width: +m[1], height: +m[2], confidence: 2 };
    }

    // 5. width-only filename suffix: name-1200w.jpg
    m = /[-_.](\d{2,5})w\.[a-z0-9]{2,5}$/i.exec(filename);
    if (m && plausible(+m[1])) return { width: +m[1], height: 0, confidence: 2 };

    // 6. Google user content: …=s1600 / =w1200-h800 / =s0 (s0 means original)
    if (/googleusercontent\.com$|ggpht\.com$|blogspot\.com$/i.test(url.hostname)) {
      const tail = /=([-a-z0-9]+)$/i.exec(path);
      if (tail) {
        const opts = tail[1].toLowerCase();
        const sw = /(?:^|-)w(\d{2,5})(?:-|$)/.exec(opts);
        const sh = /(?:^|-)h(\d{2,5})(?:-|$)/.exec(opts);
        const ss = /(?:^|-)s(\d{2,5})(?:-|$)/.exec(opts);
        if (sw || sh) {
          return { width: sw ? +sw[1] : 0, height: sh ? +sh[1] : 0, confidence: 2 };
        }
        if (ss && plausible(+ss[1])) return { width: +ss[1], height: 0, confidence: 1 };
      }
    }

    // 7. Thumbor-ish /1200x/ (width only)
    m = /\/(\d{3,5})x\//.exec(path);
    if (m && plausible(+m[1])) return { width: +m[1], height: 0, confidence: 1 };

    return none;
  }

  function firstNumber(params, keys) {
    for (const key of keys) {
      const raw = params.get(key);
      if (raw == null) continue;
      const n = Math.round(parseFloat(raw));
      if (Number.isFinite(n)) return n;
    }
    return 0;
  }

  /* ------------------------------------------------------------------ *
   * Identity key — the core of duplicate grouping
   * ------------------------------------------------------------------ */

  const SIZE_WORDS = 'thumb|thumbs|thumbnail|thumbnails|small|medium|large|grande|compact|preview|resized|scaled|cropped|square|mobile|tablet|desktop|retina|lowres|low-res|hidpi';

  const GENERIC_NAMES = new Set([
    'image', 'images', 'img', 'photo', 'photos', 'picture', 'pic', 'thumb',
    'default', 'logo', 'icon', 'avatar', 'banner', 'hero', 'placeholder',
    'cover', 'bg', 'background', 'file', 'download', 'media', 'asset', 'main',
    'index', 'untitled', 'blank', 'spacer', 'pixel'
  ]);

  /** Remove CDN transform segments that describe a resize, not a location. */
  function stripTransformSegments(path) {
    let out = path;
    out = out.replace(/\/cdn-cgi\/image\/[^/]+\//i, '/');
    out = out.replace(/\/(?:resize|fit-in|crop|smart)\/\d{2,5}x\d{2,5}\//gi, '/');
    out = out.replace(/\/\d{2,5}x\d{2,5}\//g, '/');
    out = out.replace(/\/\d{2,5}x\//g, '/');
    // Cloudinary-style comma option groups: /w_800,h_600,c_fill/
    out = out.replace(/\/(?:[a-z]{1,3}_[^,/]+)(?:,[a-z]{1,3}_[^,/]+)*\//gi, (segment) => {
      return /(?:^|,|\/)(?:w|h|c|q|f|dpr|ar|e|g|x|y|z|bo|r)_/i.test(segment) ? '/' : segment;
    });
    out = out.replace(/\/(?:thumbs?|thumbnails?|previews?|resized|scaled)\/(?=[^/]+$)/gi, '/');
    out = out.replace(/\/+/g, '/');
    return out;
  }

  /** Strip size-ish tokens from a bare filename (no extension). */
  function stripSizeTokens(base) {
    let out = base;
    let previous;
    const sizeWordRe = new RegExp('[-_.](?:' + SIZE_WORDS + ')$', 'i');
    do {
      previous = out;
      out = out.replace(/[-_.](\d{2,5})x(\d{2,5})$/i, (match, w, h) =>
        plausible(+w) && plausible(+h) ? '' : match);
      out = out.replace(/[-_.](\d{2,5})w$/i, (match, w) => (plausible(+w) ? '' : match));
      out = out.replace(/@\d+(?:\.\d+)?x$/i, '');
      out = out.replace(/[-_.]scaled$/i, '');
      out = out.replace(/[-_.]e\d{10,}$/i, ''); // WordPress "edited" stamp
      // Only drop a size word when a meaningful name remains.
      const shortened = out.replace(sizeWordRe, '');
      if (shortened.length >= 4) out = shortened;
      out = out.replace(/[-_.]+$/, '');
    } while (out !== previous && out.length > 0);
    return out;
  }

  function isGenericName(base) {
    const normalized = String(base || '').toLowerCase();
    if (normalized.length <= 2) return true;
    if (/^\d{1,4}$/.test(normalized)) return true;
    return GENERIC_NAMES.has(normalized);
  }

  function normalizeHost(hostname) {
    let host = hostname.toLowerCase().replace(/^www\./, '');
    host = host.replace(/^i[0-9]+\.wp\.com$/, 'wp.com');
    // img1.example.com / cdn3.example.com -> img.example.com / cdn.example.com
    host = host.replace(/^((?:img|image|images|static|cdn|media|assets|s|c|i|p|t)\d+)\./i, (m, part) =>
      part.replace(/\d+$/, '') + '.');
    return host;
  }

  function stableHash(value) {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      h1 = (h1 ^ code) >>> 0;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = (h2 + code) >>> 0;
      h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    }
    return (h1.toString(36) + h2.toString(36));
  }

  /**
   * A key that is equal for two URLs when they are very likely the same
   * picture at different sizes / formats / CDN settings.
   */
  function identityKey(rawUrl) {
    if (!rawUrl) return '';
    if (/^data:/i.test(rawUrl)) return 'data:' + stableHash(rawUrl);
    if (/^blob:/i.test(rawUrl)) return rawUrl;

    const unwrapped = unwrapProxy(rawUrl);
    const target = unwrapped || rawUrl;

    let url;
    try {
      url = new URL(target);
    } catch (_) {
      return String(target);
    }

    const host = normalizeHost(url.hostname);
    let path = decodeURIComponentSafe(url.pathname);

    // Google user content resize suffix is a transform, not an identity.
    path = path.replace(/=[-a-z0-9]{2,40}$/i, (match) =>
      /googleusercontent|ggpht|blogspot/i.test(url.hostname) ? '' : match);

    path = stripTransformSegments(path);

    const segments = path.split('/');
    const filename = segments.pop() || '';
    const { base, ext } = splitExtension(filename);
    let stripped = stripSizeTokens(base);
    if (!stripped) stripped = base;

    // Format variants of one picture should group; but for a name that carries
    // no information of its own ("1", "image"), the extension is the only thing
    // keeping unrelated files apart, so keep it.
    const generic = isGenericName(stripped);
    const namePart = generic && ext ? stripped + '.' + ext : stripped;

    const kept = [];
    url.searchParams.forEach((value, rawKey) => {
      const key = rawKey.toLowerCase();
      if (C.RESIZE_PARAMS.has(key) || C.CACHE_PARAMS.has(key)) return;
      kept.push(key + '=' + value);
    });
    kept.sort();

    const dir = segments.join('/');
    const key = host + dir + '/' + namePart + (kept.length ? '?' + kept.join('&') : '');
    // Degenerate result (everything stripped away) — fall back to the full URL
    // so we never merge two unrelated images into one bucket.
    if (!namePart || key.length < 4) return url.href.toLowerCase();
    return key.toLowerCase();
  }

  /**
   * Detect a bare trailing number that *might* be a size: product-2400.jpg.
   * On its own this is far too weak to group on (DSC_1234.jpg is not a size),
   * so it only reports the family; duplicate-detector.js decides whether the
   * surrounding evidence justifies a merge.
   *
   * @returns {{familyKey: string, number: number, stem: string}|null}
   */
  function numericVariant(rawUrl) {
    if (!rawUrl || /^data:|^blob:/i.test(rawUrl)) return null;
    let url;
    try {
      url = new URL(rawUrl);
    } catch (_) {
      return null;
    }
    const path = decodeURIComponentSafe(url.pathname);
    const filename = path.split('/').pop() || '';
    if (!filename) return null;
    const { base, ext } = splitExtension(filename);
    const stripped = stripSizeTokens(base);
    const match = /^(.*[^\d])[-_.](\d{2,5})$/.exec(stripped);
    if (!match) return null;

    const stem = match[1].replace(/[-_.]+$/, '');
    const number = parseInt(match[2], 10);
    if (!plausible(number) || stem.length < 2) return null;

    const rebuilt = new URL(url.href);
    rebuilt.pathname = path.slice(0, path.length - filename.length) + stem + (ext ? '.' + ext : '');
    return { familyKey: identityKey(rebuilt.href), number, stem };
  }

  /* ------------------------------------------------------------------ *
   * Originality scoring
   * ------------------------------------------------------------------ */

  const DOWNSCALE_HINTS = /(thumb|thumbnail|small|mini|tiny|preview|resize|resized|scaled|cropped|compact|low|lores|lowres|placeholder|blur|icon|avatar|sprite|mobile)/i;
  const ORIGINAL_HINTS = /(original|originals|full|fullsize|full-size|raw|source|master|hires|hi-res|highres|large|max|orig|uploads|download)/i;

  /**
   * How much a URL "looks like" the untouched original. Higher is better.
   * Only used to break ties between candidates of equal pixel area.
   */
  function originalityScore(rawUrl) {
    if (!rawUrl) return 0;
    if (/^data:/i.test(rawUrl)) return -2;
    let score = 0;
    let url;
    try {
      url = new URL(rawUrl);
    } catch (_) {
      return 0;
    }
    const path = decodeURIComponentSafe(url.pathname);
    const filename = path.split('/').pop() || '';

    const hasDimensionSuffix = /[-_.]\d{2,5}x\d{2,5}(?:[-_.][a-z0-9]+)?\.[a-z0-9]{2,5}$/i.test(filename) ||
      /[-_.]\d{2,5}w\.[a-z0-9]{2,5}$/i.test(filename) ||
      /@\d+(?:\.\d+)?x\.[a-z0-9]{2,5}$/i.test(filename);
    if (!hasDimensionSuffix) score += 2;

    let hasResizeParam = false;
    url.searchParams.forEach((_value, key) => {
      if (C.RESIZE_PARAMS.has(key.toLowerCase())) hasResizeParam = true;
    });
    if (!hasResizeParam) score += 2;

    if (!/\/\d{2,5}x\d{2,5}\//.test(path) && !/\/[a-z]{1,3}_\d{2,5}[,/]/i.test(path)) score += 1;
    if (ORIGINAL_HINTS.test(path)) score += 1;
    if (DOWNSCALE_HINTS.test(path)) score -= 2;
    if (/[-_.]scaled\.[a-z0-9]{2,5}$/i.test(filename)) score -= 1;
    if (unwrapProxy(rawUrl)) score -= 1;
    return score;
  }

  /* ------------------------------------------------------------------ *
   * Classification
   * ------------------------------------------------------------------ */

  const GRAPHIC_HINTS = /(logo|icon|sprite|badge|button|arrow|avatar|emoji|flag|star|rating|separator|divider|pattern|bullet|favicon|watermark)/i;

  /** Lightweight local heuristic — no network, no model, deliberately cheap. */
  function classify(candidate) {
    const format = candidate.format || guessFormat(candidate.url);
    if (format === 'svg') return C.CATEGORY.SVG;
    if (format === 'gif') return C.CATEGORY.GIF;

    const width = candidate.width || candidate.hintWidth || candidate.displayWidth || 0;
    const height = candidate.height || candidate.hintHeight || candidate.displayHeight || 0;
    const area = width * height;
    const url = candidate.url || '';

    if (format === 'ico' || format === 'bmp') return C.CATEGORY.GRAPHIC;
    if (GRAPHIC_HINTS.test(pathnameOf(url))) return C.CATEGORY.GRAPHIC;

    if (format === 'png') {
      // Big PNGs are usually screenshots/photos; small ones are UI chrome.
      return area >= 400 * 400 ? C.CATEGORY.PHOTO : C.CATEGORY.GRAPHIC;
    }
    if (format === 'jpg' || format === 'webp' || format === 'avif' || format === 'heic' || format === 'tiff') {
      return area && area < 120 * 120 ? C.CATEGORY.GRAPHIC : C.CATEGORY.PHOTO;
    }
    return area >= 200 * 200 ? C.CATEGORY.PHOTO : C.CATEGORY.GRAPHIC;
  }

  /**
   * 1x1 beacons, spacer GIFs and other things nobody wants to download.
   *
   * Deliberately conservative: "we could not measure it" is NOT evidence of a
   * tracking pixel — most srcset entries, lazy-load URLs and linked originals
   * have never been rendered, and hiding those would gut the whole feature.
   */
  function isLikelyTracker(candidate) {
    const width = candidate.width || 0;
    const height = candidate.height || 0;
    // A URL that advertises a real size is not a beacon.
    if ((candidate.hintWidth || 0) >= 16 || (candidate.hintHeight || 0) >= 16) return false;
    if (width > 0 && height > 0 && width <= 2 && height <= 2) return true;
    if (candidate.bytes > 0 && candidate.bytes < 100 && width > 0 && width <= 4) return true;
    if (/(^|[/._-])(pixel|beacon|tracker|tracking|analytics|impression|spacer|blank|1x1|transparent)([/._-]|$)/i
      .test(pathnameOf(candidate.url || ''))) {
      return width === 0 || (width <= 4 && height <= 4);
    }
    return false;
  }

  IMGDL.normalizer = {
    absoluteUrl,
    classify,
    dataUrlMime,
    decodeURIComponentSafe,
    detectImageFormat,
    dimensionsFromUrl,
    extractCssUrls,
    guessFormat,
    hostOf,
    identityKey,
    isGenericName,
    isLikelyTracker,
    looksLikeImageUrl,
    mimeForFormat,
    normalizeHost,
    numericVariant,
    originalityScore,
    parseSrcset,
    pathnameOf,
    splitExtension,
    stableHash,
    stripSizeTokens,
    stripTransformSegments,
    unwrapProxy
  };
})(typeof self !== 'undefined' ? self : globalThis);
