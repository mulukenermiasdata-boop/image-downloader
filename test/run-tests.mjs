/**
 * Unit tests for the pure logic (no Chrome needed):
 *   node test/run-tests.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sandbox = {
  console, URL, URLSearchParams, TextEncoder, TextDecoder, Blob, Math, Date,
  JSON, Number, String, Object, Array, Map, Set, Promise, Uint8Array,
  Uint32Array, DataView, ArrayBuffer, Error, RegExp, isNaN, parseInt, parseFloat,
  setTimeout, clearTimeout
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const file of ['constants', 'image-normalizer', 'duplicate-detector', 'filenames', 'settings', 'converter', 'zip', 'downloader']) {
  const source = fs.readFileSync(path.join(root, 'src', 'utils', `${file}.js`), 'utf8');
  vm.runInContext(source, sandbox, { filename: `src/utils/${file}.js` });
}

const { normalizer: N, dedupe: D, filenames: F, zip: Z, downloader: DL, converter: CV, C } = sandbox.IMGDL;

let passed = 0;
const failures = [];
let group = '';

function describe(name) {
  group = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}
function ok(condition, label, detail) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failures.push(`${group} > ${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq(actual, expected, label) {
  ok(Object.is(actual, expected), label, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
function deepEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, label, `got ${a}, want ${b}`);
}

/* ------------------------------------------------------------------ */
describe('format detection');
eq(N.guessFormat('https://x.com/a/b.JPEG'), 'jpg', 'uppercase .JPEG -> jpg');
eq(N.guessFormat('https://x.com/a/b.png?w=100'), 'png', 'query does not hide the extension');
eq(N.guessFormat('https://x.com/i/abc'), 'unknown', 'no extension -> unknown');
eq(N.guessFormat('https://x.com/i/abc?format=webp'), 'webp', 'format query param');
eq(N.guessFormat('data:image/gif;base64,AAA'), 'gif', 'data URL mime');
eq(N.guessFormat('https://x.com/photo.jpg/large'), 'jpg', 'extension inside the path');
eq(N.guessFormat('', 'image/avif'), 'avif', 'mime hint');

/* ------------------------------------------------------------------ */
describe('srcset parsing');
deepEq(
  N.parseSrcset('a.jpg 1x, b.jpg 2x'),
  [{ url: 'a.jpg', w: 0, d: 1 }, { url: 'b.jpg', w: 0, d: 2 }],
  'density descriptors'
);
deepEq(
  N.parseSrcset(' small.jpg 320w,\n  big.jpg 1200w '),
  [{ url: 'small.jpg', w: 320, d: 0 }, { url: 'big.jpg', w: 1200, d: 0 }],
  'width descriptors + whitespace'
);
deepEq(
  N.parseSrcset('https://cdn/w_100,h_50/a.jpg 100w, https://cdn/w_800,h_400/a.jpg 800w'),
  [
    { url: 'https://cdn/w_100,h_50/a.jpg', w: 100, d: 0 },
    { url: 'https://cdn/w_800,h_400/a.jpg', w: 800, d: 0 }
  ],
  'commas inside URLs are not separators'
);
eq(N.parseSrcset('solo.jpg').length, 1, 'entry without descriptor');
eq(N.parseSrcset('').length, 0, 'empty srcset');

/* ------------------------------------------------------------------ */
describe('css url extraction');
deepEq(N.extractCssUrls('url("a.png")'), ['a.png'], 'double quotes');
deepEq(
  N.extractCssUrls('linear-gradient(#000,#fff), url(a.png), url(\'b.jpg\')'),
  ['a.png', 'b.jpg'],
  'multiple backgrounds, gradient ignored'
);
deepEq(N.extractCssUrls('none'), [], 'none');

/* ------------------------------------------------------------------ */
describe('dimension hints from URLs');
deepEq(
  pick(N.dimensionsFromUrl('https://s.com/wp-content/uploads/pic-1024x768.jpg')),
  { width: 1024, height: 768 },
  'WordPress filename suffix'
);
deepEq(
  pick(N.dimensionsFromUrl('https://s.com/i.jpg?w=800&h=600')),
  { width: 800, height: 600 },
  'query params'
);
deepEq(
  pick(N.dimensionsFromUrl('https://res.cloudinary.com/d/image/upload/w_1600,h_900,c_fill/v1/x.jpg')),
  { width: 1600, height: 900 },
  'cloudinary transform'
);
deepEq(
  pick(N.dimensionsFromUrl('https://s.com/resize/1200x800/photo.jpg')),
  { width: 1200, height: 800 },
  'path segment'
);
deepEq(pick(N.dimensionsFromUrl('https://s.com/pic-1200w.jpg')), { width: 1200, height: 0 }, 'width-only suffix');
eq(N.dimensionsFromUrl('https://s.com/holiday-2019.jpg').confidence, 0, 'a year is not a dimension');
eq(N.dimensionsFromUrl('https://s.com/photo.jpg').confidence, 0, 'plain filename has no hint');
function pick(d) { return { width: d.width, height: d.height }; }

/* ------------------------------------------------------------------ */
describe('proxy unwrapping');
eq(
  N.unwrapProxy('https://site.com/_next/image?url=%2Fstatic%2Fhero.jpg&w=640&q=75'),
  'https://site.com/static/hero.jpg',
  'next/image relative inner URL'
);
eq(
  N.unwrapProxy('https://images.weserv.nl/?url=example.com/a.jpg&w=300'),
  'https://example.com/a.jpg',
  'weserv'
);
eq(
  N.unwrapProxy('https://i0.wp.com/blog.com/wp-content/x.png?resize=300'),
  'https://blog.com/wp-content/x.png',
  'jetpack photon'
);
eq(
  N.unwrapProxy('https://site.com/cdn-cgi/image/width=80,quality=75/assets/a.jpg'),
  'https://site.com/assets/a.jpg',
  'cloudflare image resizing'
);
eq(N.unwrapProxy('https://site.com/plain.jpg'), '', 'ordinary URL is not a proxy');

/* ------------------------------------------------------------------ */
describe('identity keys');
const sameKey = (a, b, label) => ok(N.identityKey(a) === N.identityKey(b), label,
  `${N.identityKey(a)} vs ${N.identityKey(b)}`);
const diffKey = (a, b, label) => ok(N.identityKey(a) !== N.identityKey(b), label,
  `both ${N.identityKey(a)}`);

sameKey('https://s.com/img/pic-150x150.jpg', 'https://s.com/img/pic-2400x2400.jpg', 'WordPress size variants');
sameKey('https://s.com/img/pic.jpg', 'https://s.com/img/pic-1024x768.jpg', 'original + resized variant');
sameKey('https://s.com/a.jpg?w=100&h=100', 'https://s.com/a.jpg?w=2000&h=2000', 'resize query params ignored');
sameKey('https://s.com/a.jpg?v=12345', 'https://s.com/a.jpg?v=99999', 'cache busters ignored');
sameKey('https://s.com/sunset-beach.jpg', 'https://s.com/sunset-beach.webp', 'format variants of one picture');
sameKey('https://s.com/hero@2x.png', 'https://s.com/hero.png', 'retina suffix');
sameKey('https://www.s.com/a/b.jpg', 'https://s.com/a/b.jpg', 'www prefix');
sameKey('https://img1.s.com/a/b.jpg', 'https://img2.s.com/a/b.jpg', 'numbered CDN shards');
sameKey(
  'https://pbs.twimg.com/media/ABC123?format=jpg&name=small',
  'https://pbs.twimg.com/media/ABC123?format=jpg&name=orig',
  'twitter size names'
);
sameKey('https://s.com/p/photo_large.jpg', 'https://s.com/p/photo_small.jpg', 'shopify-style size words');
sameKey('https://s.com/x/img-2400x2400.jpg', 'https://s.com/x/img-2400x2400-scaled.jpg', 'WordPress -scaled');

diffKey('https://s.com/a/cat.jpg', 'https://s.com/a/dog.jpg', 'different names stay apart');
diffKey('https://s.com/a/pic.jpg', 'https://s.com/b/pic.jpg', 'different directories stay apart');
diffKey('https://a.com/pic.jpg', 'https://b.com/pic.jpg', 'different hosts stay apart');
diffKey('https://s.com/i?id=1', 'https://s.com/i?id=2', 'unknown query params are preserved');
diffKey('https://s.com/gallery/1.jpg', 'https://s.com/gallery/1.png', 'generic names keep their extension');
diffKey('https://s.com/holiday-2019.jpg', 'https://s.com/holiday-2020.jpg', 'years are not sizes');

/* ------------------------------------------------------------------ */
describe('getBestCandidate');
{
  const group1 = {
    candidates: [
      { url: 'https://s.com/p-150x150.jpg', width: 150, height: 150 },
      { url: 'https://s.com/p-2400x2400.jpg', width: 2400, height: 2400 },
      { url: 'https://s.com/p-600x600.jpg', width: 600, height: 600 }
    ]
  };
  eq(D.getBestCandidate(group1).url, 'https://s.com/p-2400x2400.jpg', 'largest measured area wins');
}
{
  // The rendered thumbnail is measured; the big one is only known via srcset.
  const group2 = {
    candidates: [
      { url: 'https://s.com/p-300.jpg', width: 300, height: 200 },
      { url: 'https://s.com/p-2400.jpg', hintWidth: 2400 }
    ]
  };
  eq(D.getBestCandidate(group2).url, 'https://s.com/p-2400.jpg',
    'a srcset width hint beats the small measured variant (via group aspect ratio)');
}
{
  const group3 = {
    candidates: [
      { url: 'https://s.com/known-800x600.jpg', width: 800, height: 600 },
      { url: 'https://s.com/mystery.jpg' }
    ]
  };
  eq(D.getBestCandidate(group3).url, 'https://s.com/known-800x600.jpg',
    'an unknown-size candidate never beats a known large one');
}
{
  const group4 = {
    candidates: [
      { url: 'https://s.com/thumbs/p.jpg?w=1200&h=1200', width: 1200, height: 1200 },
      { url: 'https://s.com/original/p.jpg', width: 1200, height: 1200 }
    ]
  };
  eq(D.getBestCandidate(group4).url, 'https://s.com/original/p.jpg',
    'ties break toward the non-resized URL');
}
{
  const group5 = {
    candidates: [
      { url: 'https://s.com/a.jpg', width: 500, height: 500, bytes: 10000 },
      { url: 'https://s.com/b.jpg', width: 500, height: 500, bytes: 90000 }
    ]
  };
  eq(D.getBestCandidate(group5).url, 'https://s.com/b.jpg', 'equal area + originality -> bigger file');
}
{
  const group6 = { candidates: [{ url: 'https://s.com/logo.png', width: 512, height: 512 }, { url: 'https://s.com/logo.svg' }] };
  eq(D.getBestCandidate(group6).url, 'https://s.com/logo.svg', 'vector wins inside its group');
}
{
  const shuffled = [
    { url: 'https://s.com/c.jpg', width: 100, height: 100 },
    { url: 'https://s.com/a.jpg', width: 100, height: 100 },
    { url: 'https://s.com/b.jpg', width: 100, height: 100 }
  ];
  const first = D.getBestCandidate({ candidates: shuffled }).url;
  const second = D.getBestCandidate({ candidates: shuffled.slice().reverse() }).url;
  eq(first, second, 'fully deterministic regardless of input order');
}
eq(D.getBestCandidate({ candidates: [] }), null, 'empty group -> null');
eq(D.getBestCandidate([]), null, 'empty array -> null');

/* ------------------------------------------------------------------ */
describe('acceptance test (spec section 27)');
{
  const groups = D.groupCandidates([
    { url: 'https://shop.com/img/product-200.jpg', source: 'img', domOrder: 0 },
    { url: 'https://shop.com/img/product-600.jpg', source: 'img', width: 600, height: 600, domOrder: 1 },
    { url: 'https://shop.com/img/product-1200.jpg', source: 'img', domOrder: 2 },
    { url: 'https://shop.com/img/product-2400.jpg', source: 'img', domOrder: 3 }
  ]);
  eq(groups.length, 1, 'four size variants collapse into one card');
  eq(groups[0].versions, 4, 'reports "4 versions found"');
  eq(groups[0].best.url, 'https://shop.com/img/product-2400.jpg', 'downloads product-2400.jpg');
  eq(`${groups[0].width} x ${groups[0].height}`, '2400 x 2400', 'shows 2400 x 2400');
}
{
  const groups = D.groupCandidates([
    { url: 'https://cdn.com/i/image-150x150.jpg', domOrder: 0 },
    { url: 'https://cdn.com/i/image-400x400.jpg', domOrder: 1 },
    { url: 'https://cdn.com/i/image-1200x1200.jpg', domOrder: 2 },
    { url: 'https://cdn.com/i/image-2400x2400.jpg', domOrder: 3 }
  ]);
  eq(groups.length, 1, 'spec section 2 example collapses into one card');
  eq(groups[0].best.url, 'https://cdn.com/i/image-2400x2400.jpg', 'best is the 2400px version');
  eq(groups[0].area, 2400 * 2400, 'area derives from the filename hint');
}

/* ------------------------------------------------------------------ */
describe('grouping guardrails');
{
  const groups = D.groupCandidates([
    { url: 'https://s.com/g/DSC_1234.jpg', domOrder: 0 },
    { url: 'https://s.com/g/DSC_1235.jpg', domOrder: 1 },
    { url: 'https://s.com/g/DSC_1236.jpg', domOrder: 2 }
  ]);
  eq(groups.length, 3, 'a camera burst is NOT merged (numbers do not span sizes)');
}
{
  const groups = D.groupCandidates([
    { url: 'https://s.com/g/slide-1.jpg', domOrder: 0 },
    { url: 'https://s.com/g/slide-2.jpg', domOrder: 1 },
    { url: 'https://s.com/g/slide-3.jpg', domOrder: 2 }
  ]);
  eq(groups.length, 3, 'numbered slides are not merged (numbers too small to be sizes)');
}
{
  const groups = D.groupCandidates([
    { url: 'https://s.com/a/cat.jpg', width: 800, height: 600, domOrder: 0 },
    { url: 'https://s.com/a/dog.jpg', width: 800, height: 600, domOrder: 1 }
  ]);
  eq(groups.length, 2, 'unrelated images with identical sizes stay separate');
}
{
  // src is a blur placeholder, data-src is the real image: same element, one card.
  const groups = D.groupCandidates([
    { url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', nodeKey: 'n1', width: 1, height: 1, domOrder: 0 },
    { url: 'https://s.com/real-photo.jpg', nodeKey: 'n1', hintWidth: 0, domOrder: 0 }
  ]);
  eq(groups.length, 1, 'placeholder + lazy source on one element merge');
  eq(groups[0].best.url, 'https://s.com/real-photo.jpg', 'the real photo wins over the 1x1 placeholder');
}
{
  const raw = [
    { url: 'https://s.com/a.jpg', width: 100, height: 100, domOrder: 0 },
    { url: 'https://s.com/a.jpg', width: 0, height: 0, bytes: 4242, domOrder: 1 }
  ];
  eq(D.prepareCandidates(raw).length, 1, 'exact duplicate URLs collapse');
  eq(D.prepareCandidates(raw)[0].bytes, 4242, 'merged candidate keeps the known byte size');
  eq(D.prepareCandidates(raw)[0].width, 100, 'merged candidate keeps the known dimensions');
}
{
  const groups = D.groupCandidates([
    { url: 'https://s.com/img/pic-150x150.jpg', domOrder: 0 },
    { url: 'https://s.com/img/pic-2400x2400.jpg', domOrder: 1 }
  ], { group: false });
  eq(groups.length, 2, 'grouping can be turned off');
}
{
  // The 600px variant's byte count must not be advertised for the 2400px one.
  const groups = D.groupCandidates([
    { url: 'https://s.com/img/shoe-600x600.jpg', width: 600, height: 600, bytes: 48210, domOrder: 0 },
    { url: 'https://s.com/img/shoe-2400x2400.jpg', domOrder: 1 }
  ]);
  eq(groups[0].best.url, 'https://s.com/img/shoe-2400x2400.jpg', 'best is the 2400px variant');
  eq(groups[0].bytes, 0, 'no byte count is claimed for a version we have not measured');
  eq(groups[0].knownBytes, 48210, 'the known size is still available for sorting');
}

{
  // "Prefer highest quality" off must keep what the page rendered.
  const raw = [
    { url: 'https://s.com/i/pic-400x300.jpg', source: 'srcset', nodeKey: 'n1', hintWidth: 400, domOrder: 0 },
    { url: 'https://s.com/i/pic-800x600.jpg', source: 'currentSrc', nodeKey: 'n1', width: 800, height: 600, domOrder: 0 },
    { url: 'https://s.com/i/pic-2400x1800.jpg', source: 'srcset', nodeKey: 'n1', hintWidth: 2400, domOrder: 0 }
  ];
  eq(D.groupCandidates(raw)[0].best.url, 'https://s.com/i/pic-2400x1800.jpg', 'default upgrades to the largest');
  eq(D.groupCandidates(raw, { preferBest: false })[0].best.url, 'https://s.com/i/pic-800x600.jpg',
    'preferBest:false keeps the version the page rendered');
  const plan = DL.planDownloads(D.groupCandidates(raw, { preferBest: false }), {}, {});
  eq(plan[0].url, 'https://s.com/i/pic-800x600.jpg', 'the plan follows the group, so card and file agree');
}

/* ------------------------------------------------------------------ */
describe('tracking pixels + classification');
ok(N.isLikelyTracker({ url: 'https://t.com/p.gif', width: 1, height: 1 }), '1x1 gif is a tracker');
ok(N.isLikelyTracker({ url: 'https://t.com/pixel.png', width: 0, height: 0, displayWidth: 0, displayHeight: 0 }),
  'zero-size pixel.png is a tracker');
ok(!N.isLikelyTracker({ url: 'https://t.com/photo.jpg', width: 1200, height: 800 }), 'a real photo is not');
ok(!N.isLikelyTracker({ url: 'https://s.com/img/product-2400.jpg', hintWidth: 2400, displayWidth: 0, displayHeight: 0 }),
  'an unrendered srcset/link candidate is not a tracker');
ok(!N.isLikelyTracker({ url: 'https://s.com/img/photo.jpg', displayWidth: 0, displayHeight: 0 }),
  'unmeasured is not the same as invisible');
ok(N.isLikelyTracker({ url: 'https://t.com/b/beacon.gif', width: 0, height: 0 }), 'beacon.gif with no size is a tracker');
eq(N.classify({ url: 'https://s.com/a.svg', format: 'svg' }), 'svg', 'svg category');
eq(N.classify({ url: 'https://s.com/a.gif', format: 'gif' }), 'gif', 'gif category');
eq(N.classify({ url: 'https://s.com/a.jpg', format: 'jpg', width: 1200, height: 800 }), 'photo', 'large jpg is a photo');
eq(N.classify({ url: 'https://s.com/logo.png', format: 'png', width: 120, height: 40 }), 'graphic', 'small png logo is a graphic');
eq(N.classify({ url: 'https://s.com/screenshot.png', format: 'png', width: 1600, height: 900 }), 'photo', 'large png is a photo');

/* ------------------------------------------------------------------ */
describe('filenames');
eq(F.filenameFromUrl('https://s.com/a/My Photo.JPG'), 'My Photo.jpg', 'spaces kept, extension normalised');
eq(F.filenameFromUrl('https://s.com/a/b.jpg?x=1#y'), 'b.jpg', 'query and hash dropped');
eq(F.sanitize('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j', 'illegal characters replaced');
eq(F.sanitize('   ...trim...   '), 'trim', 'leading/trailing dots and spaces trimmed');
eq(F.sanitize('CON'), '_CON', 'reserved Windows device name escaped');
eq(F.sanitize(''), 'image', 'empty name gets a fallback');
ok(F.sanitize('x'.repeat(500)).length <= 100, 'names are capped', `${F.sanitize('x'.repeat(500)).length}`);
eq(F.ensureExtension('photo.webp', 'jpg'), 'photo.jpg', 'extension follows the converted format');
eq(
  F.smartFilename({ url: 'https://s.com/7c99e9a1.webp', alt: 'Nike Air Max black, side view', format: 'webp' }),
  'nike-air-max-black-side-view.webp',
  'smart filename from alt text'
);
eq(
  F.smartFilename({ url: 'https://s.com/photos/golden-gate-bridge-fog.jpg', format: 'jpg' }),
  'golden-gate-bridge-fog.jpg',
  'smart filename keeps a meaningful URL name'
);
ok(
  F.smartFilename({ url: 'https://s.com/a1b2c3d4e5f6a7b8.jpg', pageTitle: 'Acme Store', width: 800, height: 600, format: 'jpg' })
    .startsWith('acme-store'),
  'opaque hash names fall back to the page title'
);
{
  const used = new Set();
  eq(F.uniquify('a.jpg', used), 'a.jpg', 'first use keeps the name');
  eq(F.uniquify('a.jpg', used), 'a (1).jpg', 'second use is suffixed Chrome-style');
  eq(F.uniquify('a.jpg', used), 'a (2).jpg', 'third use increments');
}
eq(F.joinPath('My Page!', 'a.jpg'), 'My Page!/a.jpg', 'folder paths are sanitised per segment');
eq(F.folderNameFromPage('', 'https://www.example.com/x'), 'example.com', 'folder falls back to the host');

/* ------------------------------------------------------------------ */
describe('download planning');
{
  const groups = D.groupCandidates([
    { url: 'https://s.com/img/pic-150x150.jpg', domOrder: 0, alt: 'A red bicycle' },
    { url: 'https://s.com/img/pic-2400x2400.jpg', domOrder: 1, alt: 'A red bicycle' }
  ]);
  const plan = DL.planDownloads(groups, { naming: 'original', format: 'original' }, { title: 'Bike Shop' });
  eq(plan.length, 1, 'one task per group');
  eq(plan[0].url, 'https://s.com/img/pic-2400x2400.jpg', 'plans the best version');
  eq(plan[0].path, 'pic-2400x2400.jpg', 'original filename by default');
  eq(plan[0].fallbacks[0], 'https://s.com/img/pic-150x150.jpg', 'keeps a fallback URL');
  eq(plan[0].needsBytes, false, 'no byte access needed for an untouched download');

  const smart = DL.planDownloads(groups, { naming: 'smart', format: 'original' }, { title: 'Bike Shop' });
  eq(smart[0].path, 'red-bicycle.jpg', 'smart naming uses alt text');

  const converted = DL.planDownloads(groups, { format: 'png', naming: 'original' }, { title: 'Bike Shop' });
  eq(converted[0].path, 'pic-2400x2400.png', 'converted target changes the extension');
  eq(converted[0].needsBytes, true, 'conversion requires reading bytes');

  const foldered = DL.planDownloads(groups, { folderPerPage: true, downloadFolder: 'Images' }, { title: 'Bike Shop' });
  eq(foldered[0].path, 'Images/Bike Shop/pic-2400x2400.jpg', 'folder settings compose');
}
{
  const groups = D.groupCandidates([
    { url: 'https://s.com/a/photo.jpg', domOrder: 0 },
    { url: 'https://s.com/b/photo.jpg', domOrder: 1 }
  ]);
  const plan = DL.planDownloads(groups, {}, {});
  eq(plan[1].path, 'photo (1).jpg', 'same-named files in one batch do not collide');
}

/* ------------------------------------------------------------------ */
describe('release audit: filenames for every URL shape');
eq(F.filenameFromUrl('https://s.com/a/My Holiday Photo.JPG'), 'My Holiday Photo.jpg', 'spaces are preserved and legal');
eq(F.filenameFromUrl('https://s.com/a/%E6%97%A5%E6%9C%AC%E8%AA%9E-%C3%A9t%C3%A9.png'), '日本語-été.png', 'unicode filenames survive');
eq(F.filenameFromUrl('https://s.com/i?id=99&format=jpg'), 'i.jpg', 'query-string URL keeps a usable name');
eq(F.filenameFromUrl('https://s.com/a/shot.avif'), 'shot.avif', 'avif');
eq(F.filenameFromUrl('https://s.com/a/photo.webp'), 'photo.webp', 'webp');
ok(/^image-[a-z0-9]{1,8}\.svg$/.test(F.filenameFromUrl('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22x%22%3E%3C%2Fsvg%3E')),
  'inline-SVG data URL gets a real name, not a parsed data payload',
  F.filenameFromUrl('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22x%22%3E%3C%2Fsvg%3E'));
ok(/^image-[a-z0-9]{1,8}\.png$/.test(F.filenameFromUrl('data:image/png;base64,iVBORw0KGgo=')),
  'data URL takes its extension from the MIME type',
  F.filenameFromUrl('data:image/png;base64,iVBORw0KGgo='));
{
  const name = F.filenameFromUrl('blob:https://example.com/6f3a1c2e-8b21-4f0d-9c77-2a1b3c4d5e6f');
  ok(/^image-[a-z0-9]{1,8}$/.test(name), 'blob URL gets a stable name (extension added after the MIME is known)', name);
  ok(!name.includes('/') && !name.includes(':'), 'blob URL name contains no path separators', name);
}
eq(
  F.filenameFromUrl('data:image/png;base64,AAA'),
  F.filenameFromUrl('data:image/png;base64,AAA'),
  'data URL naming is deterministic'
);
ok(
  F.filenameFromUrl('data:image/png;base64,AAA') !== F.filenameFromUrl('data:image/png;base64,BBB'),
  'two different data URLs do not collide'
);
{
  // Duplicate names across one batch must not overwrite each other.
  const groups = D.groupCandidates([
    { url: 'https://s.com/a/photo.jpg', width: 800, height: 600, domOrder: 0 },
    { url: 'https://s.com/b/photo.jpg', width: 800, height: 600, domOrder: 1 },
    { url: 'https://s.com/c/photo.jpg', width: 800, height: 600, domOrder: 2 }
  ]);
  const plan = DL.planDownloads(groups, {}, {});
  deepEq(plan.map((task) => task.path), ['photo.jpg', 'photo (1).jpg', 'photo (2).jpg'],
    'three same-named images get distinct paths');
}
{
  const groups = D.groupCandidates([{ url: 'https://s.com/a/clear.png', width: 500, height: 500, domOrder: 0 }]);
  const plan = DL.planDownloads(groups, { format: 'jpg', jpgQuality: 92 }, {});
  eq(plan[0].path, 'clear.jpg', 'transparent PNG converted to JPG gets a .jpg name');
  eq(plan[0].needsBytes, true, 'PNG->JPG requires reading bytes');
}
{
  const groups = D.groupCandidates([{ url: 'https://s.com/a/pic.avif', width: 500, height: 500, domOrder: 0 }]);
  eq(DL.planDownloads(groups, { format: 'jpg' }, {})[0].path, 'pic.jpg', 'AVIF -> JPG target name');
  eq(DL.planDownloads(groups, { format: 'original' }, {})[0].needsBytes, false, 'AVIF kept original needs no bytes');
}

/* ------------------------------------------------------------------ */
describe('release audit: download retry policy');
ok(!DL.isTerminalError(new Error('NETWORK_FAILED')), 'a transport failure is retried with the next candidate');
ok(!DL.isTerminalError(new Error('SERVER_BAD_CONTENT')), 'a 404 on a derived URL is retried');
ok(DL.isTerminalError(new Error('USER_CANCELED')), 'a user-cancelled download is not retried');
ok(DL.isTerminalError(new Error('FILE_ACCESS_DENIED')), 'a refused disk write is not retried');
ok(DL.isTerminalError(new Error('FILE_NO_SPACE')), 'a full disk is not retried');

/* ------------------------------------------------------------------ */
describe('BUG 1: ZIP archives are always named *.zip');
{
  const title = 'AliExpress - Affordable Chinese Stores & Free Shipping - Online Shopping';
  const name = F.archiveName(title, 'https://www.aliexpress.com/');
  eq(name, title + '.zip', 'the long AliExpress title keeps its full name and gains .zip');
  ok(/\.zip$/.test(name), 'ends in .zip');

  // The regression: joinPath used to truncate every segment to 60 chars,
  // which silently ate the extension.
  const path = F.joinPath('', name);
  eq(path, name, 'joinPath no longer truncates the extension away');
  ok(/\.zip$/.test(F.joinPath('Images', name)), 'still .zip inside a download subfolder');
  ok(/\.zip$/.test(F.joinPath('Images/Nested', name)), 'still .zip inside nested folders');

  eq(F.archiveName('', 'https://www.example.com/x'), 'example.com.zip', 'no title falls back to the host');
  eq(F.archiveName('', ''), 'images.zip', 'no title and no host falls back to images.zip');
  eq(F.archiveName('Report.zip', ''), 'Report.zip', 'a title already ending in .zip is not doubled');
  ok(/\.zip$/.test(F.archiveName('x'.repeat(400), '')), 'an absurdly long title still ends in .zip');
  ok(F.archiveName('x'.repeat(400), '').length <= 105, 'and stays a sane length',
    String(F.archiveName('x'.repeat(400), '').length));
  eq(F.archiveName('Photos / Trip: 2024?', ''), 'Photos - Trip- 2024.zip', 'illegal characters are sanitised');
  // (8) unicode titles
  eq(F.archiveName('日本語のページ — Übersicht', ''), '日本語のページ — Übersicht.zip', 'unicode ZIP filenames survive');
  ok(/\.zip$/.test(F.archiveName('Ünïcødé ✨ Gallery', '')), 'unicode + emoji title still ends in .zip');
}
{
  // The same truncation bug hit ordinary long image filenames.
  const long = 'a'.repeat(80) + '.jpg';
  ok(/\.jpg$/.test(F.joinPath('', long)), 'a long image filename keeps its extension');
  ok(F.joinPath('', long).length <= 100, 'and is still capped');
}

/* ------------------------------------------------------------------ */
describe('BUG 2: real image format detection');
{
  const sig = (...bytes) => new Uint8Array(bytes);
  const withTail = (head, length) => {
    const out = new Uint8Array(length || head.length + 32);
    out.set(head, 0);
    return out;
  };
  const ftyp = (brand, ...compatible) => {
    const enc = new TextEncoder();
    const brands = [brand].concat(compatible);
    const size = 8 + 4 + 4 + (brands.length - 1) * 4;
    const out = new Uint8Array(Math.max(size, 32));
    out[0] = (size >> 24) & 0xff; out[1] = (size >> 16) & 0xff; out[2] = (size >> 8) & 0xff; out[3] = size & 0xff;
    out.set(enc.encode('ftyp'), 4);
    out.set(enc.encode(brand), 8);
    out.set(enc.encode('    '), 12); // minor version
    let offset = 16;
    for (const extra of compatible) { out.set(enc.encode(extra), offset); offset += 4; }
    return out;
  };

  const JPEG = withTail(sig(0xff, 0xd8, 0xff, 0xe0));
  const PNG = withTail(sig(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));
  const GIF = withTail(new TextEncoder().encode('GIF89a'));
  const WEBP = (() => {
    const out = new Uint8Array(32);
    out.set(new TextEncoder().encode('RIFF'), 0);
    out.set(new TextEncoder().encode('WEBP'), 8);
    return out;
  })();
  const AVIF = ftyp('avif', 'mif1', 'miaf');
  const AVIS = ftyp('avis', 'msf1');
  const HEIC = ftyp('heic', 'mif1');
  const SVG = new TextEncoder().encode('<?xml version="1.0"?>\n<!-- a comment -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');

  deepEq(N.detectImageFormat(JPEG, ''), { extension: 'jpg', mimeType: 'image/jpeg' }, 'JPEG magic bytes');
  deepEq(N.detectImageFormat(PNG, ''), { extension: 'png', mimeType: 'image/png' }, 'PNG magic bytes');
  deepEq(N.detectImageFormat(GIF, ''), { extension: 'gif', mimeType: 'image/gif' }, 'GIF magic bytes');
  deepEq(N.detectImageFormat(WEBP, ''), { extension: 'webp', mimeType: 'image/webp' }, 'WebP RIFF/WEBP');
  deepEq(N.detectImageFormat(AVIF, ''), { extension: 'avif', mimeType: 'image/avif' }, 'AVIF ftypavif');
  deepEq(N.detectImageFormat(AVIS, ''), { extension: 'avif', mimeType: 'image/avif' }, 'AVIF sequence ftypavis');
  deepEq(N.detectImageFormat(HEIC, ''), { extension: 'heic', mimeType: 'image/heic' }, 'HEIC is not mistaken for AVIF');
  deepEq(N.detectImageFormat(SVG, ''), { extension: 'svg', mimeType: 'image/svg+xml' }, 'SVG root element after xml decl + comment');

  // Magic bytes are authoritative over a lying Content-Type.
  eq(N.detectImageFormat(AVIF, 'image/jpeg').extension, 'avif', 'AVIF bytes beat a Content-Type of image/jpeg');
  eq(N.detectImageFormat(WEBP, 'image/png').extension, 'webp', 'WebP bytes beat a Content-Type of image/png');
  eq(N.detectImageFormat(JPEG, 'application/octet-stream').extension, 'jpg', 'generic Content-Type does not confuse sniffing');

  // Content-Type is the fallback when the bytes say nothing.
  eq(N.detectImageFormat(new Uint8Array([1, 2, 3, 4]), 'image/webp').extension, 'webp', 'unknown bytes fall back to Content-Type');
  eq(N.detectImageFormat(new Uint8Array([1, 2, 3, 4]), 'image/avif; charset=binary').extension, 'avif', 'Content-Type parameters are ignored');
  eq(N.detectImageFormat(new Uint8Array([1, 2, 3, 4]), '').extension, '', 'nothing known -> empty extension');
  eq(N.detectImageFormat(new Uint8Array(0), '').extension, '', 'empty buffer is safe');
  eq(N.detectImageFormat(JPEG.buffer, '').extension, 'jpg', 'accepts an ArrayBuffer as well as a view');
  ok(!/^<svg/i.test('x'), 'sanity');
  eq(N.detectImageFormat(new TextEncoder().encode('<!DOCTYPE html><html><body><svg></svg>'), '').extension, '',
    'an HTML error page containing <svg> is not detected as SVG');

  /* --- entry naming inside the archive --------------------------------- */
  const detect = (bytes, type) => N.detectImageFormat(bytes, type);

  // (2) AVIF bytes from a .jpg URL
  eq(DL.archiveEntryName('1080x1080.jpg', detect(AVIF, 'image/jpeg'), { converted: false }), '1080x1080.avif',
    'AVIF bytes served from a .jpg URL are stored as .avif');
  eq(DL.archiveEntryName('2424x917.png', detect(AVIF, 'image/png'), { converted: false }), '2424x917.avif',
    'AVIF bytes served from a .png URL are stored as .avif');
  // (3) WebP bytes from a .png URL
  eq(DL.archiveEntryName('banner.png', detect(WEBP, 'image/png'), { converted: false }), 'banner.webp',
    'WebP bytes served from a .png URL are stored as .webp');
  // (4) real JPEG stays .jpg
  eq(DL.archiveEntryName('594x594.jpg', detect(JPEG, 'image/jpeg'), { converted: false }), '594x594.jpg',
    'a real JPEG keeps .jpg');
  // (5) real PNG stays .png
  eq(DL.archiveEntryName('logo.png', detect(PNG, 'image/png'), { converted: false }), 'logo.png',
    'a real PNG keeps .png');
  eq(DL.archiveEntryName('anim.gif', detect(GIF, 'image/gif'), { converted: false }), 'anim.gif', 'a real GIF keeps .gif');
  eq(DL.archiveEntryName('icon.svg', detect(SVG, 'image/svg+xml'), { converted: false }), 'icon.svg', 'a real SVG keeps .svg');
  // (6) conversion mode keeps the requested output extension
  eq(DL.archiveEntryName('shot.jpg', detect(PNG, 'image/png'), { converted: true }), 'shot.jpg',
    'converted output keeps the requested extension, not the source signature');
  eq(DL.archiveEntryName('photo.png', detect(JPEG, 'image/jpeg'), { converted: true }), 'photo.png',
    'a PNG conversion stays .png');
  // undetectable bytes must not damage a working name
  eq(DL.archiveEntryName('mystery.jpg', { extension: '', mimeType: '' }, { converted: false }), 'mystery.jpg',
    'an undetectable file keeps its planned name');
  eq(DL.archiveEntryName('noext', detect(AVIF, ''), { converted: false }), 'noext.avif',
    'a name with no extension gains the detected one');
}

/* ------------------------------------------------------------------ */
describe('BUG 2: duplicates after extension correction');
{
  // (9) two different sources correcting to the same name must not collide.
  const used = new Set();
  const names = ['image.jpg', 'image.png', 'image.webp'].map((planned) =>
    F.uniquify(DL.archiveEntryName(planned, { extension: 'avif', mimeType: 'image/avif' }, {}), used));
  deepEq(names, ['image.avif', 'image (1).avif', 'image (2).avif'],
    'corrected names are de-duplicated, matching Chrome download naming');
  eq(new Set(names).size, 3, 'no entry overwrites another');
}
{
  const used = new Set();
  deepEq(
    ['photo.jpg', 'photo.jpg', 'photo.jpg'].map((n) => F.uniquify(n, used)),
    ['photo.jpg', 'photo (1).jpg', 'photo (2).jpg'],
    'plain duplicates use the same scheme'
  );
}

/* ------------------------------------------------------------------ */
describe('BUG 2: original mode never re-encodes');
{
  // (7) Bytes must reach the archive untouched: same length, same CRC.
  const original = new Uint8Array(512);
  for (let i = 0; i < original.length; i++) original[i] = (i * 37 + 11) & 0xff;
  original.set(new TextEncoder().encode('ftypavif'), 4);

  ok(!CV.needsConversion('avif', 'original'), 'original mode never triggers conversion');
  ok(!CV.needsConversion('jpg', 'original'), 'original mode never converts a JPEG either');
  ok(!CV.needsConversion('avif', ''), 'an empty target never triggers conversion');

  const blob = Z.createZip([{ name: 'kept.avif', data: original, date: new Date(2024, 0, 1) }]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const nameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);
  const start = 30 + nameLen + extraLen;
  const stored = bytes.subarray(start, start + original.length);
  eq(view.getUint16(8, true), 0, 'entry is stored, not deflated');
  eq(view.getUint32(18, true), original.length, 'compressed size equals the original size');
  eq(Z.crc32(stored), Z.crc32(original), 'stored bytes have the same CRC as the source');
  ok(stored.every((byte, i) => byte === original[i]), 'stored bytes are byte-for-byte identical');
  eq(N.detectImageFormat(stored, '').extension, 'avif', 'the archived bytes still sniff as AVIF');
}

/* ------------------------------------------------------------------ */
describe('individual originals: extension correction');
{
  const avif = (() => {
    const b = new Uint8Array(64);
    b[0] = 0; b[1] = 0; b[2] = 0; b[3] = 24;
    b.set(new TextEncoder().encode('ftyp'), 4);
    b.set(new TextEncoder().encode('avif'), 8);
    return b;
  })();
  const webp = (() => {
    const b = new Uint8Array(32);
    b.set(new TextEncoder().encode('RIFF'), 0);
    b.set(new TextEncoder().encode('WEBP'), 8);
    return b;
  })();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const correct = (path, bytes, contentType) => {
    const detected = N.detectImageFormat(bytes, contentType);
    return detected.extension ? F.pathWithExtension(path, detected.extension) : path;
  };

  eq(correct('1080x1080.jpg', avif, 'image/jpeg'), '1080x1080.avif',
    'an individual .jpg URL serving AVIF is saved as .avif');
  eq(correct('banner.png', webp, 'image/png'), 'banner.webp',
    'an individual .png URL serving WebP is saved as .webp');
  eq(correct('594x594.jpg', jpeg, 'image/jpeg'), '594x594.jpg', 'a genuine JPEG stays .jpg');
  eq(correct('logo.png', png, 'image/png'), 'logo.png', 'a genuine PNG stays .png');
  eq(correct('mystery.jpg', new Uint8Array([1, 2, 3]), ''), 'mystery.jpg',
    'unidentifiable bytes leave the planned name alone');

  // Folders must survive the correction.
  eq(correct('Images/Bike Shop/1080x1080.jpg', avif, 'image/jpeg'), 'Images/Bike Shop/1080x1080.avif',
    'subfolders are preserved when the extension is corrected');
  eq(F.pathWithExtension('Images/Nested/pic.jpg', 'webp'), 'Images/Nested/pic.webp', 'nested folders preserved');
  eq(F.pathWithExtension('pic.jpg', ''), 'pic.jpg', 'no detected extension leaves the path untouched');
}

/* ------------------------------------------------------------------ */
describe('individual originals: conversion still wins when requested');
{
  // The planner reads the format from the URL, which can lie. Once the bytes
  // are known, the conversion decision must be re-made from the truth.
  ok(CV.needsConversion('avif', 'png'), 'a .png URL that really serves AVIF is still converted to PNG');
  ok(CV.needsConversion('avif', 'jpg'), 'AVIF -> JPG still converts');
  ok(!CV.needsConversion('png', 'png'), 'a genuine PNG requested as PNG is not re-encoded');
  ok(!CV.needsConversion('avif', 'original'), 'original mode never converts, whatever the bytes are');
  ok(!CV.needsConversion('jpg', ''), 'an empty target never converts');
  eq(F.pathWithExtension('shot.png', 'png'), 'shot.png', 'a conversion target keeps the requested extension');
  eq(F.pathWithExtension('shot.png', 'jpg'), 'shot.jpg', 'converted output takes the requested extension');
}

/* ------------------------------------------------------------------ */
describe('individual originals: origin permissions');
{
  const page = 'https://shop.example/*';
  deepEq(
    DL.distinctOrigins([
      'https://shop.example/a.jpg',
      'https://shop.example/b.jpg',
      'https://cdn.shop.net/c.jpg',
      'https://cdn.shop.net/d.jpg',
      'https://img.other.org/e.jpg'
    ], page),
    ['https://cdn.shop.net/*', 'https://img.other.org/*'],
    'only cross-origin hosts are requested, de-duplicated'
  );
  deepEq(DL.distinctOrigins(['https://shop.example/a.jpg', 'https://shop.example/b.jpg'], page), [],
    'a same-origin image requires no host request at all');
  deepEq(DL.distinctOrigins(['data:image/png;base64,AAA', 'blob:https://shop.example/x'], page), [],
    'data: and blob: URLs require no host request');
  eq(DL.originPattern('https://cdn.example.com:8443/a/b.jpg'), 'https://cdn.example.com:8443/*',
    'the pattern is scoped to scheme+host+port, never <all_urls>');
  eq(DL.originPattern('http://plain.example/a.jpg'), 'http://plain.example/*', 'http origins too');
  eq(DL.originPattern('data:image/png;base64,AAA'), '', 'data URL has no origin pattern');
  eq(DL.originPattern('not a url'), '', 'a malformed URL yields no pattern');
  ok(!DL.distinctOrigins(['https://a.com/x.jpg'], page).includes('<all_urls>'),
    'no request ever contains <all_urls>');
}

/* ------------------------------------------------------------------ */
describe('the [hidden] attribute actually hides');
{
  // A rule like `.filters { display: flex }` beats the UA stylesheet's
  // [hidden] { display: none }, which left the filter panel and the empty
  // state rendered while the code believed they were hidden. Every stylesheet
  // that styles a toggled element needs the guard.
  for (const sheet of ['src/sidepanel/sidepanel.css', 'src/options/options.css']) {
    const css = fs.readFileSync(path.join(root, sheet), 'utf8');
    ok(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css),
      sheet + ' forces [hidden] to win over author display rules');
  }

  // Elements the panel toggles at runtime, and the display they declare.
  const panelCss = fs.readFileSync(path.join(root, 'src/sidepanel/sidepanel.css'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src/sidepanel/index.html'), 'utf8');
  const toggled = ['filters', 'state', 'grid', 'progress', 'dl-options', 'versions', 'scrim', 'toast'];
  for (const id of toggled) {
    ok(new RegExp('id="' + id + '"').test(html), 'panel markup still has #' + id);
  }
  ok(panelCss.indexOf('[hidden]') < panelCss.indexOf('.filters'),
    'the guard is declared before the rules it has to override');
}

/* ------------------------------------------------------------------ */
describe('host access is optional, opted into from the panel');
{
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  ok(!manifest.host_permissions,
    'no host_permissions at install: no scary prompt, and an update cannot force-disable existing users');
  deepEq(manifest.optional_host_permissions, ['http://*/*', 'https://*/*'],
    'all-sites access is optional and scoped to http/https');
  ok(!(manifest.optional_host_permissions || []).includes('<all_urls>'),
    'not <all_urls>: file:// and other schemes are excluded');
  ok(!(manifest.permissions || []).includes('<all_urls>'),
    'the api permission list does not smuggle in <all_urls>');
  ok((manifest.permissions || []).includes('activeTab'),
    'activeTab remains the default path, so the extension works with nothing granted');

  const shipping = ['src/sidepanel/sidepanel.js', 'src/options/options.js', 'src/background/service-worker.js']
    .map((f) => ({ f, text: fs.readFileSync(path.join(root, f), 'utf8') }));
  const panelText = shipping.find((s) => s.f === 'src/sidepanel/sidepanel.js').text;
  const swText = shipping.find((s) => s.f === 'src/background/service-worker.js').text;
  const optionsJs = shipping.find((s) => s.f === 'src/options/options.js').text;

  // Exactly one place may ask, and it must ask for the declared optional set.
  const asks = shipping.filter((s) => /permissions\.request\(/.test(s.text)).map((s) => s.f);
  deepEq(asks, ['src/sidepanel/sidepanel.js'], 'only the side panel ever requests permissions');
  ok(!/permissions\.request\([^)]*<all_urls>/.test(panelText),
    'the request is never for <all_urls>');
  ok(/ALL_SITES\s*=\s*\['http:\/\/\*\/\*', 'https:\/\/\*\/\*'\]/.test(panelText),
    'the request matches what the manifest declares as optional');
  ok(!/permissions\.request\(/.test(swText), 'the service worker never prompts');
  ok(!/permissions\.request\(/.test(optionsJs), 'the options page never prompts');

  // The opt-in must be a real action, not the misleading retry button.
  ok(/Scan every page automatically/.test(panelText), 'the empty state offers a working opt-in');
  ok(!/'Scan this page'/.test(panelText), 'the old no-op retry button is gone');
  ok(/grantAllSites/.test(panelText), 'the opt-in is wired to a permission request');

  // Byte reading still degrades gracefully when nothing is granted.
  ok(/permissions\.contains\(/.test(panelText), 'the panel checks what it may fetch');
  ok(typeof DL.originPattern === 'function' && DL.originPattern('https://cdn.a.com/x.jpg') === 'https://cdn.a.com/*',
    'per-origin capability checks still work');
}

/* ------------------------------------------------------------------ */
describe('individual originals: conflict-safe naming + traversal');
{
  const used = new Set();
  deepEq(
    ['a.jpg', 'a.png', 'a.webp'].map((n) => F.uniquePath(F.pathWithExtension(n, 'avif'), used)),
    ['a.avif', 'a (1).avif', 'a (2).avif'],
    'three sources correcting to the same name stay distinct'
  );
  const folders = new Set();
  deepEq(
    ['Shop/a.jpg', 'Shop/a.png'].map((n) => F.uniquePath(F.pathWithExtension(n, 'avif'), folders)),
    ['Shop/a.avif', 'Shop/a (1).avif'],
    'de-duplication happens per filename, inside its folder'
  );

  // (7) directory traversal must be impossible.
  eq(F.pathWithExtension('../../file.jpg', 'avif'), 'file.avif', '../../ is stripped');
  eq(F.pathWithExtension('/file.jpg', 'avif'), 'file.avif', 'a leading slash is stripped');
  eq(F.pathWithExtension('..\\file.jpg', 'avif'), 'file.avif', 'a backslash traversal is stripped');
  eq(F.pathWithExtension('../../../../etc/passwd.jpg', 'avif'), 'etc/passwd.avif', 'deep traversal is stripped');
  eq(F.joinPath('..', 'x.jpg'), 'x.jpg', 'a ".." folder segment is dropped');
  eq(F.joinPath('.', 'x.jpg'), 'x.jpg', 'a "." folder segment is dropped');
  eq(F.joinPath('a/../../b', 'x.jpg'), 'a/b/x.jpg', 'traversal between real folders is dropped');
  eq(F.uniquePath('../../evil.jpg', new Set()), 'evil.jpg', 'uniquePath cannot traverse either');
  eq(F.filenameFromUrl('https://s.com/../../secret.jpg'), 'secret.jpg', 'traversal in a URL is resolved away');
  for (const attack of ['../../file.jpg', '/file.jpg', '..\\file.jpg', '....//file.jpg', 'C:\\win\\file.jpg']) {
    const out = F.pathWithExtension(attack, 'avif');
    ok(!out.startsWith('/') && !out.includes('..') && !out.includes('\\') && !out.includes(':'),
      'sanitised: ' + JSON.stringify(attack) + ' -> ' + JSON.stringify(out));
  }
}

/* ------------------------------------------------------------------ */
describe('zip writer');
{
  eq(Z.crc32(new TextEncoder().encode('123456789')), 0xcbf43926, 'CRC-32 check value');
  const blob = Z.createZip([
    { name: 'a.txt', data: new TextEncoder().encode('hello'), date: new Date(2024, 0, 1, 12, 0, 0) },
    { name: 'dir/b.txt', data: new TextEncoder().encode('world'), date: new Date(2024, 0, 1, 12, 0, 0) }
  ]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  eq(view.getUint32(0, true), 0x04034b50, 'starts with a local file header');
  const eocdOffset = bytes.length - 22;
  eq(view.getUint32(eocdOffset, true), 0x06054b50, 'ends with the end-of-central-directory record');
  eq(view.getUint16(eocdOffset + 10, true), 2, 'records both entries');
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  eq(view.getUint32(centralOffset, true), 0x02014b50, 'central directory offset points at a central header');
  eq(blob.type, 'application/zip', 'blob has the zip mime type');
}

/* ------------------------------------------------------------------ */
describe('settings');
eq(sandbox.IMGDL.settings.clean({ minWidth: '250' }).minWidth, 250, 'numeric strings are coerced');
eq(sandbox.IMGDL.settings.clean({ jpgQuality: 500 }).jpgQuality, 100, 'quality is clamped');
eq(sandbox.IMGDL.settings.clean(null).minWidth, C.DEFAULT_SETTINGS.minWidth, 'null falls back to defaults');
eq(sandbox.IMGDL.settings.clean({ bogus: 1 }).bogus, undefined, 'unknown keys are dropped');
{
  // Two toggles flipped in the same tick must both survive.
  const store = {};
  sandbox.chrome = {
    storage: {
      local: {
        get: (key) => Promise.resolve(key in store ? { [key]: store[key] } : {}),
        set: (patch) => { Object.assign(store, patch); return Promise.resolve(); }
      }
    }
  };
  const S = sandbox.IMGDL.settings;
  const [a, b] = await Promise.all([S.set({ hideTiny: false }), S.set({ groupDuplicates: false })]);
  ok(a.hideTiny === false, 'first concurrent write applies');
  ok(b.hideTiny === false && b.groupDuplicates === false, 'second concurrent write does not undo the first',
    JSON.stringify({ hideTiny: b.hideTiny, groupDuplicates: b.groupDuplicates }));
  const final = await S.get();
  ok(final.hideTiny === false && final.groupDuplicates === false, 'both survive in storage',
    JSON.stringify({ hideTiny: final.hideTiny, groupDuplicates: final.groupDuplicates }));
  delete sandbox.chrome;
}

/* ------------------------------------------------------------------ */
describe('release audit: service worker loads and classifies access errors');
{
  // Run the real service worker under stubbed Chrome APIs. This proves its
  // top-level registration does not throw (a throw here is a dead extension)
  // and lets us test its access-error classifier for real.
  const listeners = [];
  const bus = {};
  const evented = (name) => ({
    addListener: (fn) => { listeners.push(fn); (bus[name] = bus[name] || []).push(fn); },
    removeListener: () => {},
    hasListener: () => false
  });
  const fire = (name, ...args) => (bus[name] || []).map((fn) => fn(...args));
  const swBox = {
    console, URL, URLSearchParams, TextEncoder, TextDecoder, Blob, Math, Date, JSON,
    Number, String, Object, Array, Map, Set, Promise, Uint8Array, Uint32Array, DataView,
    ArrayBuffer, Error, RegExp, isNaN, parseInt, parseFloat, setTimeout, clearTimeout, atob, btoa, fetch
  };
  swBox.self = swBox;
  swBox.globalThis = swBox;
  swBox.importScripts = (...paths) => {
    for (const p of paths) {
      vm.runInContext(fs.readFileSync(path.join(root, p.replace(/^\//, '')), 'utf8'), swBox, { filename: p });
    }
  };
  const calls = { executeScript: 0, sent: [], menus: [] };
  let router = () => Promise.resolve(undefined);
  swBox.chrome = {
    runtime: { onInstalled: evented('installed'), onStartup: evented('startup'), onMessage: evented('message'), onConnect: evented('connect'), sendMessage: () => Promise.resolve(), lastError: undefined, openOptionsPage: () => {} },
    tabs: {
      onRemoved: evented('tabRemoved'), onUpdated: evented('tabUpdated'), onActivated: evented('tabActivated'),
      sendMessage: (tabId, message) => { calls.sent.push(message.type); return router(tabId, message); },
      query: () => Promise.resolve([{ id: 7 }]),
      get: () => Promise.resolve({ id: 7, title: 'Shop', url: 'https://shop.example/p' })
    },
    action: { onClicked: evented('actionClicked'), setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, setTitle: () => {} },
    contextMenus: { onClicked: evented('menuClicked'), removeAll: (cb) => cb && cb(), create: (o) => calls.menus.push(o.id) },
    permissions: { onAdded: evented('permAdded'), onRemoved: evented('permRemoved'), contains: () => Promise.resolve(false) },
    scripting: {
      executeScript: () => { calls.executeScript++; return Promise.resolve(); },
      getRegisteredContentScripts: () => Promise.resolve([]),
      registerContentScripts: () => Promise.resolve(),
      unregisterContentScripts: () => Promise.resolve()
    },
    sidePanel: { open: () => Promise.resolve() },
    downloads: { onChanged: evented('downloadChanged'), download: () => {} },
    storage: { sync: { get: () => Promise.resolve({}), set: () => Promise.resolve() }, onChanged: evented('storageChanged') }
  };
  vm.createContext(swBox);

  let threw = null;
  try {
    vm.runInContext(fs.readFileSync(path.join(root, 'src/background/service-worker.js'), 'utf8'), swBox,
      { filename: 'src/background/service-worker.js' });
  } catch (error) {
    threw = error;
  }
  ok(!threw, 'service worker evaluates without throwing', threw && threw.message);
  ok(listeners.length >= 9, 'service worker registers its event listeners at top level', listeners.length + ' listeners');
  ok(typeof swBox.syncDynamicScripts !== 'function',
    'the background all-sites content-script registration is gone');
  ok(typeof swBox.hasAllSites !== 'function', 'the worker no longer checks for <all_urls>');
  ok(typeof swBox.hasOriginAccess === 'function', 'byte reading is gated per image origin instead');

  const classify = swBox.isRestrictedFailure;
  ok(typeof classify === 'function', 'access-error classifier is present');
  if (typeof classify === 'function') {
    // The message Chrome gives on an ordinary page you have not invoked yet.
    ok(!classify('Cannot access contents of the page. Extension manifest must request permission to access the respective host.'),
      'an ordinary un-invoked page is NOT reported as blocking extensions');
    ok(classify('Cannot access contents of url "chrome://newtab/". Extension manifest must request permission to access this host.'),
      'a chrome:// page is reported as restricted');
    ok(classify('Cannot access a chrome:// URL'), 'the short chrome:// message is restricted');
    ok(classify('The extensions gallery cannot be scripted.'), 'the Web Store is restricted');
    ok(classify('Cannot access contents of url "devtools://devtools/bundled/x.html".'), 'devtools is restricted');
    ok(!classify('The tab was closed.'), 'an unrelated failure is not reported as restricted');
  }

  /* --- restart resilience: nothing depends on in-memory state ------------- */
  describe('release audit: behaviour after a service-worker restart');

  // A freshly restarted worker has an empty tab cache. The content script from
  // before the restart is still alive in the page and answers PING.
  const ALTERNATES = [
    { url: 'https://shop.example/i/shoe-150x150.jpg', source: 'srcset', width: 0, height: 0, hintWidth: 0, hintHeight: 0, bytes: 0, nodeKey: 'n1', domOrder: 0, format: 'jpg' },
    { url: 'https://shop.example/i/shoe-600x600.jpg', source: 'currentSrc', width: 600, height: 600, hintWidth: 0, hintHeight: 0, bytes: 0, nodeKey: 'n1', domOrder: 0, format: 'jpg' },
    { url: 'https://shop.example/i/shoe-2400x2400.jpg', source: 'srcset', width: 0, height: 0, hintWidth: 2400, hintHeight: 0, bytes: 0, nodeKey: 'n1', domOrder: 0, format: 'jpg' }
  ];
  router = (tabId, message) => {
    if (message.type === C.MSG.PING) return Promise.resolve({ ready: true });
    if (message.type === C.MSG.GET_ALTERNATES) {
      return Promise.resolve({ candidates: ALTERNATES, pageUrl: 'https://shop.example/p', pageTitle: 'Shop' });
    }
    if (message.type === C.MSG.SCAN) {
      return Promise.resolve({ candidates: ALTERNATES, full: true, pageUrl: 'https://shop.example/p', pageTitle: 'Shop' });
    }
    return Promise.resolve(undefined);
  };

  calls.sent.length = 0;
  const best = await swBox.resolveBest(7, 'https://shop.example/i/shoe-600x600.jpg');
  eq(best.url, 'https://shop.example/i/shoe-2400x2400.jpg',
    '"Download best quality" resolves the largest variant with an empty worker cache');
  ok(calls.sent.includes(C.MSG.GET_ALTERNATES),
    'it asks the page live rather than trusting in-memory state');
  ok(best.fallbacks.length > 1, 'it keeps fallback URLs in case the best one 404s');

  // Right-clicking an image the scanner never indexed must still download it.
  router = (tabId, message) => (message.type === C.MSG.PING
    ? Promise.resolve({ ready: true })
    : Promise.resolve({ candidates: [], pageUrl: '', pageTitle: '' }));
  const orphan = await swBox.resolveBest(7, 'https://shop.example/i/unknown.jpg');
  eq(orphan.url, 'https://shop.example/i/unknown.jpg', 'an unindexed image falls back to the right-clicked URL');

  // A page that cannot be reached at all must not throw.
  router = () => Promise.reject(new Error('Could not establish connection.'));
  const unreachable = await swBox.resolveBest(7, 'https://shop.example/i/x.jpg');
  eq(unreachable.url, 'https://shop.example/i/x.jpg', 'an unreachable page degrades to the plain URL');

  // Panel asking for state on a cold worker triggers a fresh scan.
  router = (tabId, message) => {
    if (message.type === C.MSG.PING) return Promise.resolve({ ready: true });
    if (message.type === C.MSG.SCAN) return Promise.resolve({ candidates: ALTERNATES, full: true, pageUrl: 'https://shop.example/p', pageTitle: 'Shop' });
    return Promise.resolve(undefined);
  };
  calls.sent.length = 0;
  const cold = await swBox.getTabState(7);
  ok(cold.ok, 'cold worker returns a usable tab state');
  eq(cold.snapshot.candidates.length, 3, 'cold worker repopulates its cache by rescanning the page');
  ok(calls.sent.includes(C.MSG.SCAN), 'a cold cache triggers a scan request');

  // Navigating the tab must drop the cache so the panel never shows stale images.
  fire('tabUpdated', 7, { status: 'loading', url: 'https://shop.example/other' }, {});
  const after = swBox.snapshotFor(7);
  ok(!after || !after.candidates.length, 'navigating a tab clears its cached images',
    after ? after.candidates.length + ' left' : 'cleared');

  // Closing a tab must not leak its entry.
  await swBox.getTabState(7);
  fire('tabRemoved', 7, {});
  ok(!swBox.snapshotFor(7), 'closing a tab drops its cache entry');

  // Context menus are rebuilt on both install and browser startup.
  calls.menus.length = 0;
  fire('installed', {});
  deepEq(calls.menus, ['imgdl-root', 'imgdl-image', 'imgdl-best', 'imgdl-jpg', 'imgdl-png'],
    'all five context-menu items are created on install');
  calls.menus.length = 0;
  fire('startup');
  eq(calls.menus.length, 5, 'context menus are recreated on browser startup');
}

/* ------------------------------------------------------------------ */
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
