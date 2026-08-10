/**
 * Shared constants + default settings.
 *
 * Every file in this extension is a *classic* script that attaches itself to a
 * single `IMGDL` namespace on the global object. That keeps one copy of the
 * logic usable from all three worlds without a bundler:
 *   - service worker  -> importScripts('/src/utils/...')
 *   - extension pages -> <script src="../utils/...">
 *   - content scripts -> chrome.scripting.executeScript({ files: [...] })
 */
(function (global) {
  'use strict';
  const IMGDL = (global.IMGDL = global.IMGDL || {});
  if (IMGDL.C) return;

  /** Runtime message types. */
  const MSG = {
    // panel/background -> content
    PING: 'imgdl:ping',
    SCAN: 'imgdl:scan',
    MEASURE: 'imgdl:measure',
    GET_ALTERNATES: 'imgdl:get-alternates',
    FETCH_BYTES: 'imgdl:fetch-bytes',
    PICK_START: 'imgdl:pick-start',
    PICK_STOP: 'imgdl:pick-stop',

    // content -> background/panel
    CANDIDATES: 'imgdl:candidates',
    PICKED: 'imgdl:picked',
    PICK_ENDED: 'imgdl:pick-ended',

    // panel <-> background
    GET_TAB_STATE: 'imgdl:get-tab-state',
    ENSURE_INJECTED: 'imgdl:ensure-injected',
    DOWNLOAD: 'imgdl:download',
    TAB_CHANGED: 'imgdl:tab-changed',
    SETTINGS_CHANGED: 'imgdl:settings-changed',
    OPEN_OPTIONS: 'imgdl:open-options'
  };

  /** Where a candidate URL was discovered. Used for provenance + scoring. */
  const SOURCE = {
    IMG: 'img',
    CURRENT_SRC: 'currentSrc',
    SRCSET: 'srcset',
    PICTURE: 'picture',
    LAZY: 'lazy',
    CSS: 'css',
    LINK: 'link',
    PRELOAD: 'preload',
    META: 'meta',
    SVG_INLINE: 'svg-inline',
    SVG_USE: 'svg-use',
    NETWORK: 'network',
    UNWRAPPED: 'unwrapped',
    PICKED: 'picked'
  };

  const CATEGORY = {
    PHOTO: 'photo',
    GRAPHIC: 'graphic',
    SVG: 'svg',
    GIF: 'gif'
  };

  const DEFAULT_SETTINGS = {
    minWidth: 100,
    minHeight: 100,
    hideTiny: true,
    groupDuplicates: true,
    preferHighestQuality: true,
    measureUnknown: true,
    sort: 'largest', // largest | smallest | page | filesize
    format: 'original', // original | jpg | png | webp
    jpgQuality: 92,
    naming: 'original', // original | smart
    folderPerPage: false,
    zip: false,
    downloadFolder: ''
  };

  /** Query params that only describe a *rendering* of an image, not its identity. */
  const RESIZE_PARAMS = new Set([
    'w', 'h', 'width', 'height', 'maxwidth', 'maxheight', 'max-w', 'max-h',
    'mw', 'mh', 'size', 'sz', 's', 'fit', 'crop', 'q', 'quality', 'auto',
    'format', 'fm', 'dpr', 'resize', 'rs', 'tr', 'wid', 'hei', 'sw', 'sh',
    'scale', 'zoom', 'ar', 'output', 'strip', 'lossless', 'compress', 'px',
    'imwidth', 'imageview2', 'x-oss-process', 'thumbnail', 'thumb', 'name',
    'cropmode', 'anchor', 'rect', 'rotate', 'blur', 'sharp', 'bg', 'pad'
  ]);

  /** Params that change per request but never change the bytes' identity. */
  const CACHE_PARAMS = new Set([
    'v', 'ver', 'version', 't', 'ts', 'time', 'cache', 'cb', 'rev', '_',
    'sig', 'signature', 'token', 'expires', 'se', 'st', 'hash', 'etag',
    'x-amz-algorithm', 'x-amz-credential', 'x-amz-date', 'x-amz-expires',
    'x-amz-signedheaders', 'x-amz-signature', 'x-amz-security-token',
    'x-goog-algorithm', 'x-goog-credential', 'x-goog-date', 'x-goog-expires',
    'x-goog-signedheaders', 'x-goog-signature'
  ]);

  /** Attributes lazy-loaders stash real URLs in. */
  const LAZY_URL_ATTRS = [
    'data-src', 'data-original', 'data-original-src', 'data-lazy', 'data-lazy-src',
    'data-url', 'data-image', 'data-img', 'data-full', 'data-full-src',
    'data-large', 'data-large-src', 'data-hi-res', 'data-hires', 'data-highres',
    'data-zoom', 'data-zoom-src', 'data-zoom-image', 'data-big', 'data-echo',
    'data-defer-src', 'data-delayed-url', 'data-actualsrc', 'data-real-src',
    'data-thumb', 'data-flickity-lazyload', 'data-bg', 'data-background',
    'data-background-image', 'data-src-large', 'data-orig-file', 'data-large-file',
    'data-medium-file', 'data-cfsrc', 'lazy-src', 'nitro-lazy-src'
  ];

  const LAZY_SRCSET_ATTRS = [
    'data-srcset', 'data-lazy-srcset', 'data-original-set', 'data-srcset-large',
    'data-flickity-lazyload-srcset', 'nitro-lazy-srcset'
  ];

  /** Higher = better source when everything else ties. */
  const FORMAT_QUALITY_RANK = {
    svg: 6, png: 5, avif: 4, webp: 3, jpg: 2, heic: 2, tiff: 5, bmp: 4,
    gif: 1, ico: 0, unknown: 0
  };

  const IMAGE_EXTENSIONS = [
    'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'apng', 'webp', 'avif', 'gif',
    'svg', 'svgz', 'bmp', 'ico', 'cur', 'tif', 'tiff', 'heic', 'heif'
  ];

  /** Hard caps so a hostile/huge page can never lock up the scanner. */
  const LIMITS = {
    MAX_CANDIDATES: 6000,
    MAX_ELEMENTS_SCANNED: 20000,
    ELEMENT_CHUNK: 600,
    SCAN_DEBOUNCE_MS: 350,
    MAX_SCAN_MS: 900,
    MEASURE_CONCURRENCY: 4,
    MEASURE_TIMEOUT_MS: 10000,
    MAX_INLINE_SVG_BYTES: 512 * 1024,
    MAX_FETCH_BYTES: 40 * 1024 * 1024,
    DOWNLOAD_CONCURRENCY: 4,
    RENDER_CHUNK: 60,
    MAX_FILENAME_LENGTH: 100
  };

  IMGDL.C = {
    MSG, SOURCE, CATEGORY, DEFAULT_SETTINGS, RESIZE_PARAMS, CACHE_PARAMS,
    LAZY_URL_ATTRS, LAZY_SRCSET_ATTRS, FORMAT_QUALITY_RANK, IMAGE_EXTENSIONS,
    LIMITS
  };
})(typeof self !== 'undefined' ? self : globalThis);
