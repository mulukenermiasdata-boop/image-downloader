/**
 * Assertions for src/content/scanner.js running against a real DOM.
 * Results are printed on the page and exposed as window.__scanResult.
 */
(function () {
  'use strict';
  const scanner = window.IMGDL.scanner;
  const D = window.IMGDL.dedupe;
  const out = document.getElementById('out');

  const checks = [];
  const check = (label, condition, detail) => checks.push({ label, pass: Boolean(condition), detail: detail || '' });

  // Give lazily decoded images a moment so naturalWidth is populated.
  window.addEventListener('load', () => setTimeout(run, 400));

  async function run() {
    const payload = await scanner.scan({ deep: true });
    const urls = payload.candidates.map((candidate) => candidate.url);
    const has = (fragment) => urls.some((url) => url.includes(fragment));
    const find = (fragment) => payload.candidates.find((candidate) => candidate.url.includes(fragment));

    check('finds a plain <img>', has('plain-photo-900x600'));
    check('reads srcset entries', has('responsive-800x600') && has('responsive-1600x1200'));
    check('srcset width descriptor becomes a hint',
      (find('responsive-1600x1200') || {}).hintWidth === 1600,
      'hintWidth=' + ((find('responsive-1600x1200') || {}).hintWidth));
    check('reads <picture><source>', has('picture-source-1200x800') && has('picture-source-2400x1600'));
    check('reads data-src lazy attribute', has('lazy-loaded-1400x933'));
    check('reads a linked full-size original', has('gallery-shot-2400x1600'));
    check('reads an inline style background', has('inline-style-bg-800x520'));
    check('reads a stylesheet background', has('css-stylesheet-bg-1000x667'));
    check('serialises inline <svg>', urls.some((url) => url.startsWith('data:image/svg+xml')));
    check('reads a video poster', has('video-poster-1280x720'));
    check('reads input type=image', has('input-image-120x40'));
    check('reads <object> image data', has('object-diagram.svg'));
    check('reads og:image', has('social-share-1200x630'));
    check('reads link rel=preload as=image', has('preloaded-hero-1920x800'));
    check('unwraps the next/image proxy to the original', has('next-original-2000x1333'));
    check('sees the tracking pixel (so it can be filtered)', has('tracking-pixel-1x1'));

    const plain = find('plain-photo-900x600');
    check('measures a loaded image', plain && plain.width === 900 && plain.height === 600,
      plain ? plain.width + 'x' + plain.height : 'missing');

    const bigSrcset = find('responsive-1600x1200');
    const smallSrcset = find('responsive-400x300');
    check('srcset entries share the element key',
      bigSrcset && smallSrcset && bigSrcset.nodeKey && bigSrcset.nodeKey === smallSrcset.nodeKey,
      bigSrcset && smallSrcset ? bigSrcset.nodeKey + ' / ' + smallSrcset.nodeKey : 'missing');

    // Grouping over what the scanner actually produced.
    const groups = D.groupCandidates(payload.candidates, { group: true });
    const groupOf = (fragment) => groups.find((group) =>
      group.candidates.some((candidate) => candidate.url.includes(fragment)));

    const responsive = groupOf('responsive-1600x1200');
    check('responsive variants collapse into one group',
      responsive && responsive.versions >= 3, responsive ? responsive.versions + ' versions' : 'missing');
    check('best responsive version is the 1600px one',
      responsive && responsive.best.url.includes('responsive-1600x1200'),
      responsive ? responsive.best.url.split('/').pop() : 'missing');

    const gallery = groupOf('gallery-shot-2400x1600');
    check('thumbnail groups with its linked original',
      gallery && gallery.versions === 2, gallery ? gallery.versions + ' versions' : 'missing');
    check('the linked original wins over the thumbnail',
      gallery && gallery.best.url.includes('gallery-shot-2400x1600'),
      gallery ? gallery.best.url.split('/').pop() : 'missing');

    const lazy = groupOf('lazy-loaded-1400x933');
    check('the real lazy image beats its 1x1 placeholder',
      lazy && lazy.best.url.includes('lazy-loaded-1400x933'),
      lazy ? lazy.best.url.slice(0, 48) : 'missing');

    const picture = groupOf('picture-source-2400x1600');
    check('<picture> sources group with the fallback <img>',
      picture && picture.versions >= 3, picture ? picture.versions + ' versions' : 'missing');

    const proxied = groupOf('next-original-2000x1333');
    check('the proxy URL and its unwrapped original are one group',
      proxied && proxied.versions === 2, proxied ? proxied.versions + ' versions' : 'missing');

    const failed = checks.filter((entry) => !entry.pass);
    window.__scanResult = {
      candidates: payload.candidates.length,
      groups: groups.length,
      passed: checks.length - failed.length,
      failed: failed.length,
      failures: failed.map((entry) => entry.label + (entry.detail ? ' (' + entry.detail + ')' : '')),
      urls: urls.map((url) => url.replace(location.origin, '').slice(0, 90))
    };

    out.innerHTML = checks.map((entry) =>
      '<span class="' + (entry.pass ? 'pass' : 'fail') + '">' + (entry.pass ? 'PASS' : 'FAIL') + '</span>  ' +
      entry.label + (entry.detail ? '  — ' + entry.detail : '')).join('\n') +
      '\n\n' + (checks.length - failed.length) + ' passed, ' + failed.length + ' failed' +
      '\n' + payload.candidates.length + ' candidates -> ' + groups.length + ' groups';
  }
})();
