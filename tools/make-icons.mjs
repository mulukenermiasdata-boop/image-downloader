/**
 * Generates icons/icon{16,32,48,128}.png
 *
 *   node tools/make-icons.mjs
 *
 * The mark: three offset cards — the same picture found at three sizes — with
 * the largest one picked out in the amber used by the "Best" badge in the side
 * panel. That is the product in one glyph: duplicates grouped, best version
 * chosen. Each card is separated by a keyline in the background colour so the
 * stack stays readable at 16px instead of blurring into one blob.
 *
 * Pure Node, no image libraries.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './png.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling factor

const INDIGO = [79, 70, 229];   // background
const WHITE = [255, 255, 255];  // the other versions
const AMBER = [251, 191, 36];   // the best version

const CARD_R = 0.055;
const KEYLINE = 0.042;

/** Rounded-rectangle hit test in unit space. */
function roundedRect(x0, y0, x1, y1, r) {
  return (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  };
}

const grow = ([x0, y0, x1, y1], k) => [x0 - k, y0 - k, x1 + k, y1 + k];

const BACK = [0.215, 0.150, 0.575, 0.430];
const MIDDLE = [0.280, 0.283, 0.685, 0.593];
const FRONT = [0.345, 0.416, 0.800, 0.796];

// Painted back to front; each card's keyline cuts a gap out of the one behind.
const LAYERS = [
  { test: roundedRect(...BACK, CARD_R), color: WHITE },
  { test: roundedRect(...grow(MIDDLE, KEYLINE), CARD_R + KEYLINE), color: INDIGO },
  { test: roundedRect(...MIDDLE, CARD_R), color: WHITE },
  { test: roundedRect(...grow(FRONT, KEYLINE), CARD_R + KEYLINE), color: INDIGO },
  { test: roundedRect(...FRONT, CARD_R), color: AMBER }
];

const SHELL = roundedRect(0.02, 0.02, 0.98, 0.98, 0.223);

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = SS * SS;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (!SHELL(x, y)) continue;
          covered++;
          let color = INDIGO;
          for (const layer of LAYERS) if (layer.test(x, y)) color = layer.color;
          r += color[0];
          g += color[1];
          b += color[2];
        }
      }

      const offset = (py * size + px) * 4;
      if (!covered) continue;
      pixels[offset] = Math.round(r / covered);
      pixels[offset + 1] = Math.round(g / covered);
      pixels[offset + 2] = Math.round(b / covered);
      pixels[offset + 3] = Math.round((covered / samples) * 255);
    }
  }
  return pixels;
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT, `icon${size}.png`);
  fs.writeFileSync(file, encodePng(size, size, render(size)));
  console.log(`wrote ${path.relative(root, file)} (${fs.statSync(file).size} bytes)`);
}
