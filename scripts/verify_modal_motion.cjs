const {chromium} = require('../.qa/node_modules/playwright');
const fs = require('fs');
const assert = require('assert');

(async () => {
  const url = process.argv[2] || process.env.HAVEN_URL || fs.readFileSync('.qa/smooth-server.log', 'utf8').replace(/^\uFEFF/, '').trim();
  const browser = await chromium.launch({args:['--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
  try {
    const results = [];
    for (const baseline of [true, false]) {
      const page = await browser.newPage({viewport:{width:1440, height:920}});
      if (baseline) await page.route('**/liquid-glass.js?**', async route => {
        const response = await route.fetch();
        let source = await response.text();
        source = source.replace('busy||themeFade?0:150', 'themeFade?32:videoPlaying?33:busy?16:150');
        source = source.replace('if(!activeDialog || (sceneRevision!==backgroundRevision&&!videoPlaying)){', 'if(true){');
        source = source.replace('if(point!==cursorPaintedPoint||cursorLayerDirty||themeFade||videoPlaying||time-lastInteraction<400){', 'if(time-(window.testLastCursorPaint||0)>32&&(point!==cursorPaintedPoint||cursorLayerDirty||themeFade||videoPlaying)){window.testLastCursorPaint=time;');
        await route.fulfill({response, body:source});
      });
      await page.goto(url);
      await page.waitForFunction(() => havenGlass.diagnostics.ready && state.total > 0);
      await page.evaluate(() => showViewer(0));
      await page.waitForTimeout(1200);
      const result = await page.evaluate(async () => {
        const diagnostics = havenGlass.diagnostics;
        const gl = document.querySelector('#liquid-canvas').getContext('webgl2');
        const draw = gl.drawArrays.bind(gl);
        let backgroundDraws = 0;
        gl.drawArrays = (...args) => {backgroundDraws++;return draw(...args);};
        const button = document.querySelector('#viewer-close');
        const bounds = button.getBoundingClientRect();
        const startFrames = diagnostics.frames, startPaints = diagnostics.cursorPaints, start = performance.now();
        await new Promise(resolve => {
          const move = now => {
            button.dispatchEvent(new PointerEvent('pointermove', {bubbles:true, clientX:bounds.x + bounds.width / 2, clientY:bounds.bottom + 10 + Math.sin(now / 140) * 8}));
            if (now - start < 2000) requestAnimationFrame(move); else resolve();
          };
          requestAnimationFrame(move);
        });
        gl.drawArrays = draw;
        const frames = diagnostics.frames - startFrames;
        return {frames, cursorPaints:diagnostics.cursorPaints - startPaints, backgroundDraws, fps:Math.round(frames * 1000 / (performance.now() - start))};
      });
      results.push({baseline, ...result});
      await page.close();
    }
    const updated = results[1];
    assert(updated.cursorPaints >= updated.frames * .8, 'Moving cursor must update together with the button layer');
    assert(updated.backgroundDraws < results[0].backgroundDraws / 2, 'Modal movement must reuse the main-page background');
    console.log(JSON.stringify({passed:true, results}));
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
