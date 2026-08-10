/**
 * Local, canvas-based format conversion. Nothing leaves the browser.
 * Works in both extension pages (HTMLCanvasElement path) and workers
 * (OffscreenCanvas path).
 */
(function (global) {
  'use strict';
  const IMGDL = (global.IMGDL = global.IMGDL || {});
  if (IMGDL.converter) return;
  const N = IMGDL.normalizer;

  const TARGET_MIME = {
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp'
  };

  /** Formats we are willing to emit. */
  function isConvertibleTarget(format) {
    return Object.prototype.hasOwnProperty.call(TARGET_MIME, format);
  }

  /** Formats the browser can reliably decode for us. */
  function isDecodable(format) {
    return ['jpg', 'png', 'webp', 'avif', 'gif', 'bmp', 'ico', 'svg'].includes(format);
  }

  function needsConversion(sourceFormat, targetFormat) {
    if (!targetFormat || targetFormat === 'original') return false;
    if (!isConvertibleTarget(targetFormat)) return false;
    return sourceFormat !== targetFormat;
  }

  async function decode(blob) {
    // SVG (and anything createImageBitmap refuses) goes through an <img>.
    const type = blob.type || '';
    if (!/svg/i.test(type) && typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(blob);
      } catch (_) { /* fall through to the DOM decoder */ }
    }
    if (typeof document === 'undefined' || typeof Image === 'undefined') {
      throw new Error('Cannot decode this image for conversion.');
    }
    const url = URL.createObjectURL(blob);
    try {
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('Image could not be decoded.'));
        element.src = url;
      });
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!width || !height) throw new Error('Image has no intrinsic size.');
      return { width, height, source: image, close() {} };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function makeCanvas(width, height) {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    }
    throw new Error('No canvas implementation available.');
  }

  async function canvasToBlob(canvas, mime, quality) {
    if (typeof canvas.convertToBlob === 'function') {
      return canvas.convertToBlob({ type: mime, quality });
    }
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Canvas export failed.'))),
        mime,
        quality
      );
    });
  }

  /**
   * @param {Blob} blob source bytes
   * @param {string} targetFormat 'jpg' | 'png' | 'webp'
   * @param {number} quality 1-100 (only used for lossy targets)
   * @returns {Promise<Blob>}
   */
  async function convertBlob(blob, targetFormat, quality) {
    const mime = TARGET_MIME[targetFormat];
    if (!mime) throw new Error('Unsupported target format: ' + targetFormat);

    const bitmap = await decode(blob);
    const width = bitmap.width;
    const height = bitmap.height;
    const canvas = makeCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: targetFormat !== 'jpg' });
    if (!context) throw new Error('Could not get a 2D context.');

    // JPEG has no alpha channel: composite onto white instead of black.
    if (targetFormat === 'jpg') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(bitmap.source || bitmap, 0, 0, width, height);
    if (typeof bitmap.close === 'function') bitmap.close();

    const normalizedQuality = Math.min(1, Math.max(0.05, (quality || 92) / 100));
    const out = await canvasToBlob(
      canvas,
      mime,
      targetFormat === 'png' ? undefined : normalizedQuality
    );
    if (!out) throw new Error('Conversion produced no data.');
    // Some builds silently fall back to PNG when a codec is missing.
    if (out.type && out.type !== mime) {
      throw new Error('This browser cannot encode ' + targetFormat.toUpperCase() + '.');
    }
    return out;
  }

  /** Convert only when the target actually differs from the source. */
  async function maybeConvert(blob, sourceFormat, targetFormat, quality) {
    const source = sourceFormat || N.guessFormat('', blob.type);
    if (!needsConversion(source, targetFormat)) {
      return { blob, format: source, converted: false };
    }
    const out = await convertBlob(blob, targetFormat, quality);
    return { blob: out, format: targetFormat, converted: true };
  }

  IMGDL.converter = {
    TARGET_MIME,
    canvasToBlob,
    convertBlob,
    isConvertibleTarget,
    isDecodable,
    maybeConvert,
    needsConversion
  };
})(typeof self !== 'undefined' ? self : globalThis);
