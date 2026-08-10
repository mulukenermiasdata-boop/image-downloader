/**
 * Dev server for the side-panel preview harness (not part of the extension).
 *
 *   node tools/serve.mjs
 *
 * Serves the repo, puts test/preview/index.html at "/", and synthesises
 * placeholder images for /mock/img/<name> so the harness has real bytes to
 * load, measure and download.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './png.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 5599);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif'
};

const PALETTE = [
  [37, 99, 235], [16, 185, 129], [244, 114, 182], [251, 146, 60],
  [139, 92, 246], [14, 165, 233], [234, 179, 8], [239, 68, 68]
];

/** Derive the intended pixel size from a filename like pic-1024x768.jpg. */
function sizeFromName(name) {
  let match = /[-_](\d{2,5})x(\d{2,5})(?=[-_.]|$)/.exec(name);
  if (match) return { width: +match[1], height: +match[2] };
  match = /[-_](\d{2,5})(?=\.|$)/.exec(name);
  if (match) return { width: +match[1], height: +match[1] };
  match = /[?&](?:w|width)=(\d{2,5})/.exec(name);
  if (match) return { width: +match[1], height: Math.round(+match[1] * 0.66) };
  return { width: 400, height: 300 };
}

function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return Math.abs(h);
}

function makeSvg(name) {
  const { width, height } = sizeFromName(name);
  const base = PALETTE[hash(name) % PALETTE.length];
  const fill = `rgb(${base.join(',')})`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`
    + `<rect width="100%" height="100%" rx="${Math.round(width * 0.14)}" fill="${fill}"/>`
    + `<circle cx="${width * 0.5}" cy="${height * 0.42}" r="${Math.min(width, height) * 0.18}" fill="#fff" opacity=".9"/>`
    + `<rect x="${width * 0.24}" y="${height * 0.68}" width="${width * 0.52}" height="${height * 0.08}" rx="${height * 0.04}" fill="#fff" opacity=".9"/>`
    + '</svg>';
  return { body: Buffer.from(svg, 'utf8'), width, height };
}

function makeImage(name) {
  if (/\.svg(\?|$)/i.test(name)) return makeSvg(name);
  const { width, height } = sizeFromName(name);
  const w = Math.max(1, Math.min(width, 2600));
  const h = Math.max(1, Math.min(height, 2600));
  // Strip the size suffix so every variant of one picture gets one colour.
  const family = name.replace(/[-_]\d{2,5}(x\d{2,5})?(?=[-_.]|$)/, '').replace(/\?.*$/, '');
  // Atmospheric abstract "photographs": a sky-to-ground gradient, a couple of
  // soft light sources, a horizon and a vignette. Reads as photography at
  // thumbnail size without borrowing anyone's actual copyrighted picture.
  const seed = hash(family);
  const scheme = SCHEMES[seed % SCHEMES.length];
  const rand = mulberry(seed);
  const horizon = 0.45 + rand() * 0.25;
  const lights = [
    { x: 0.2 + rand() * 0.6, y: 0.1 + rand() * 0.3, r: 0.35 + rand() * 0.3, i: 0.55 + rand() * 0.35 },
    { x: rand(), y: 0.5 + rand() * 0.5, r: 0.4 + rand() * 0.4, i: 0.2 + rand() * 0.25 }
  ];
  const pixels = Buffer.alloc(w * h * 4);

  for (let y = 0; y < h; y++) {
    const v = y / h;
    const sky = v < horizon;
    const t = sky ? v / horizon : (v - horizon) / (1 - horizon);
    const from = sky ? scheme.sky[0] : scheme.ground[0];
    const to = sky ? scheme.sky[1] : scheme.ground[1];
    const eased = t * t * (3 - 2 * t);

    for (let x = 0; x < w; x++) {
      const u = x / w;
      let r = from[0] + (to[0] - from[0]) * eased;
      let g = from[1] + (to[1] - from[1]) * eased;
      let b = from[2] + (to[2] - from[2]) * eased;

      for (const light of lights) {
        const dx = (u - light.x) * 1.35;
        const dy = v - light.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= light.r) continue;
        const fall = (1 - d / light.r) ** 2 * light.i;
        r += (scheme.light[0] - r) * fall;
        g += (scheme.light[1] - g) * fall;
        b += (scheme.light[2] - b) * fall;
      }

      // horizon haze
      const band = Math.abs(v - horizon);
      if (band < 0.05) {
        const haze = (1 - band / 0.05) * 0.32;
        r += (scheme.light[0] - r) * haze;
        g += (scheme.light[1] - g) * haze;
        b += (scheme.light[2] - b) * haze;
      }

      // vignette + film grain
      const vig = 1 - 0.32 * (((u - 0.5) ** 2 + (v - 0.5) ** 2) * 1.9);
      const grain = ((x * 31 + y * 17 + seed) % 23) / 23 * 7 - 3.5;

      const offset = (y * w + x) * 4;
      pixels[offset] = clamp8(r * vig + grain);
      pixels[offset + 1] = clamp8(g * vig + grain);
      pixels[offset + 2] = clamp8(b * vig + grain);
      pixels[offset + 3] = 255;
    }
  }
  return { body: encodePng(w, h, pixels), width: w, height: h };
}

function clamp8(value) {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

/** Small deterministic PRNG so a given filename always renders identically. */
function mulberry(a) {
  let t = a >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const SCHEMES = [
  { sky: [[38, 52, 92], [126, 148, 186]], ground: [[92, 108, 128], [26, 32, 44]], light: [255, 232, 196] },
  { sky: [[24, 40, 48], [88, 150, 150]], ground: [[52, 90, 92], [14, 26, 30]], light: [232, 248, 240] },
  { sky: [[70, 40, 60], [216, 138, 122]], ground: [[96, 62, 66], [30, 20, 26]], light: [255, 214, 170] },
  { sky: [[30, 34, 58], [96, 92, 150]], ground: [[64, 62, 96], [18, 18, 30]], light: [226, 220, 255] },
  { sky: [[46, 56, 34], [154, 168, 116]], ground: [[80, 92, 56], [24, 30, 18]], light: [248, 246, 214] },
  { sky: [[22, 44, 66], [104, 156, 196]], ground: [[46, 78, 104], [12, 22, 34]], light: [236, 246, 255] },
  { sky: [[64, 34, 30], [212, 124, 74]], ground: [[104, 60, 40], [28, 18, 14]], light: [255, 206, 150] },
  { sky: [[34, 34, 38], [140, 140, 148]], ground: [[74, 74, 80], [20, 20, 22]], light: [245, 245, 248] }
];

const imageCache = new Map();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);

  // /mock/img/foo.jpg?sig=avif  -> AVIF magic bytes served with a LYING
  // Content-Type, so the ZIP packager's sniffing can be tested end to end.
  const sig = url.searchParams.get('sig');
  if (pathname.startsWith('/mock/img/') && sig) {
    const body = Buffer.alloc(64);
    const brands = { avif: 'avif', avis: 'avis', heic: 'heic' };
    if (brands[sig]) {
      body.writeUInt32BE(24, 0);
      body.write('ftyp', 4);
      body.write(brands[sig], 8);
      body.write('mif1', 16);
    } else if (sig === 'webp') {
      body.write('RIFF', 0);
      body.write('WEBP', 8);
    } else if (sig === 'png') {
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(body, 0);
    } else if (sig === 'jpeg') {
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(body, 0);
    } else if (sig === 'gif') {
      body.write('GIF89a', 0);
    }
    res.writeHead(200, {
      'Content-Type': url.searchParams.get('ct') || 'image/jpeg',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
    return;
  }

  if (pathname.startsWith('/mock/img/')) {
    const key = pathname.slice('/mock/img/'.length) + url.search;
    if (!imageCache.has(key)) imageCache.set(key, makeImage(key));
    const image = imageCache.get(key);
    res.writeHead(200, {
      'Content-Type': /\.svg$/i.test(pathname) ? 'image/svg+xml' : 'image/png',
      'Content-Length': image.body.length,
      'Cache-Control': 'no-store',
      'Timing-Allow-Origin': '*',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(image.body);
    return;
  }

  // Redirect rather than rewrite, so the page's relative paths still resolve.
  if (pathname === '/') {
    res.writeHead(302, { Location: '/test/preview/index.html' });
    res.end();
    return;
  }
  const file = path.join(root, pathname);
  if (!file.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }

  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found: ' + pathname); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`preview harness on http://localhost:${PORT}`));
