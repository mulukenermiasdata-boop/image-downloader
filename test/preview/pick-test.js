/**
 * Verifies Pick Mode leaves no trace on the page when the side panel goes away
 * (port disconnect) as well as on Escape.
 */
(function () {
  'use strict';
  const out = document.getElementById('out');
  const checks = [];
  const check = (label, condition, detail) => checks.push({ label, pass: Boolean(condition), detail: detail || '' });

  function footprint() {
    return {
      style: Boolean(document.getElementById('imgdl-picker-style')),
      overlay: Boolean(document.getElementById('imgdl-picker-overlay')),
      hint: Boolean(document.getElementById('imgdl-picker-hint')),
      cursorClass: document.documentElement.classList.contains('imgdl-picking'),
      active: window.IMGDL.picker.isActive(),
      cursor: getComputedStyle(document.querySelector('img')).cursor
    };
  }

  function clean(state) {
    return !state.style && !state.overlay && !state.hint && !state.cursorClass && !state.active;
  }

  setTimeout(run, 300);

  async function run() {
    const baselineNodes = document.documentElement.childElementCount;
    const baselineClass = document.documentElement.className;

    // --- 1. panel closes (port disconnect) ---------------------------------
    await window.__send({ type: 'imgdl:pick-start', selected: [] });
    const port = window.__connectPickPort();
    const during1 = footprint();
    check('pick mode starts (overlay + style + crosshair injected)',
      during1.style && during1.overlay && during1.hint && during1.cursorClass && during1.active);

    port.drop();
    await new Promise((r) => setTimeout(r, 60));
    const after1 = footprint();
    check('closing the side panel removes every injected node and listener', clean(after1), JSON.stringify(after1));
    check('the page cursor is restored after the panel closes', after1.cursor !== 'crosshair', after1.cursor);

    // --- 2. Escape ---------------------------------------------------------
    await window.__send({ type: 'imgdl:pick-start', selected: [] });
    window.__connectPickPort();
    const during2 = footprint();
    check('pick mode restarts cleanly a second time', during2.overlay && during2.active);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    check('Escape removes everything', clean(footprint()), JSON.stringify(footprint()));

    // --- 3. explicit stop from the panel -----------------------------------
    await window.__send({ type: 'imgdl:pick-start', selected: [] });
    await window.__send({ type: 'imgdl:pick-stop' });
    await new Promise((r) => setTimeout(r, 60));
    check('an explicit stop message removes everything', clean(footprint()), JSON.stringify(footprint()));

    // --- 4. a dropped port after pick mode already ended must be harmless ---
    const strayPort = window.__connectPickPort();
    strayPort.drop();
    await new Promise((r) => setTimeout(r, 60));
    check('a stale port disconnect does not throw or re-inject', clean(footprint()));

    // --- 5. the page is byte-for-byte as we found it ------------------------
    check('document element count restored',
      document.documentElement.childElementCount === baselineNodes,
      document.documentElement.childElementCount + ' vs ' + baselineNodes);
    check('documentElement class restored',
      document.documentElement.className === baselineClass,
      JSON.stringify(document.documentElement.className));
    check('no imgdl-* nodes remain anywhere',
      document.querySelectorAll('[id^="imgdl-"]').length === 0,
      document.querySelectorAll('[id^="imgdl-"]').length + ' left');

    const failed = checks.filter((c) => !c.pass);
    window.__pickResult = {
      passed: checks.length - failed.length,
      failed: failed.length,
      failures: failed.map((c) => c.label + (c.detail ? ' (' + c.detail + ')' : ''))
    };
    out.innerHTML = checks.map((c) =>
      '<span class="' + (c.pass ? 'pass' : 'fail') + '">' + (c.pass ? 'PASS' : 'FAIL') + '</span>  ' +
      c.label + (c.detail ? '  — ' + c.detail : '')).join('\n') +
      '\n\n' + (checks.length - failed.length) + ' passed, ' + failed.length + ' failed';
  }
})();
