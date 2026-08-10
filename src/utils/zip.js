/**
 * Minimal, dependency-free ZIP writer (STORE method).
 *
 * Images are already compressed, so deflate would burn CPU for ~0% gain;
 * storing keeps the writer small enough to audit and fast on big batches.
 */
(function (global) {
  'use strict';
  const IMGDL = (global.IMGDL = global.IMGDL || {});
  if (IMGDL.zip) return;

  const MAX_TOTAL = 0xffffffff; // classic zip offset/size ceiling

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes, seed) {
    let crc = (seed === undefined ? 0 : seed) ^ 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  const encoder = new TextEncoder();

  function writer(size) {
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    let offset = 0;
    return {
      bytes,
      u16(value) { view.setUint16(offset, value, true); offset += 2; },
      u32(value) { view.setUint32(offset, value >>> 0, true); offset += 4; },
      raw(chunk) { bytes.set(chunk, offset); offset += chunk.length; },
      get length() { return offset; }
    };
  }

  /** MS-DOS date/time as used in zip headers. */
  function dosDateTime(date) {
    const d = date || new Date();
    const year = Math.max(1980, d.getFullYear());
    const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
    const dateBits = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
    return { time, date: dateBits };
  }

  /**
   * @param {Array<{name: string, data: Uint8Array|ArrayBuffer, date?: Date}>} files
   * @returns {Blob} a valid .zip
   */
  function createZip(files, options) {
    const opts = options || {};
    const entries = [];
    const chunks = [];
    let offset = 0;

    for (const file of files) {
      const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
      const nameBytes = encoder.encode(file.name);
      const stamp = dosDateTime(file.date || opts.date);
      const crc = crc32(data);

      const local = writer(30 + nameBytes.length);
      local.u32(0x04034b50);
      local.u16(20);            // version needed
      local.u16(0x0800);        // UTF-8 filename flag
      local.u16(0);             // method: store
      local.u16(stamp.time);
      local.u16(stamp.date);
      local.u32(crc);
      local.u32(data.length);
      local.u32(data.length);
      local.u16(nameBytes.length);
      local.u16(0);             // extra length
      local.raw(nameBytes);

      chunks.push(local.bytes, data);
      entries.push({ nameBytes, crc, size: data.length, offset, stamp });
      offset += local.bytes.length + data.length;

      if (offset > MAX_TOTAL) {
        throw new Error('ZIP archive would exceed 4 GB. Download without ZIP, or select fewer images.');
      }
    }

    const centralStart = offset;
    for (const entry of entries) {
      const central = writer(46 + entry.nameBytes.length);
      central.u32(0x02014b50);
      central.u16(0x031e);      // version made by (unix, zip 3.0)
      central.u16(20);
      central.u16(0x0800);
      central.u16(0);
      central.u16(entry.stamp.time);
      central.u16(entry.stamp.date);
      central.u32(entry.crc);
      central.u32(entry.size);
      central.u32(entry.size);
      central.u16(entry.nameBytes.length);
      central.u16(0);           // extra
      central.u16(0);           // comment
      central.u16(0);           // disk number
      central.u16(0);           // internal attrs
      central.u32(0x81a40000);  // external attrs: -rw-r--r--
      central.u32(entry.offset);
      central.raw(entry.nameBytes);
      chunks.push(central.bytes);
      offset += central.bytes.length;
    }

    const centralSize = offset - centralStart;
    const end = writer(22);
    end.u32(0x06054b50);
    end.u16(0);
    end.u16(0);
    end.u16(entries.length);
    end.u16(entries.length);
    end.u32(centralSize);
    end.u32(centralStart);
    end.u16(0);
    chunks.push(end.bytes);

    if (entries.length > 0xffff) {
      throw new Error('ZIP archives are limited to 65535 files.');
    }
    return new Blob(chunks, { type: 'application/zip' });
  }

  IMGDL.zip = { createZip, crc32, dosDateTime };
})(typeof self !== 'undefined' ? self : globalThis);
