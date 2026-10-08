const {chromium} = require('../.qa/node_modules/playwright');
const fs = require('fs');
const assert = require('assert');

(async () => {
  const url = process.argv[2] || process.env.HAVEN_URL || fs.readFileSync('.qa/stack-server.log', 'utf8').replace(/^\uFEFF/, '').trim();
  const browser = await chromium.launch({args:['--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
  try {
    const page = await browser.newPage({viewport:{width:1440, height:920}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => window.havenGlass?.diagnostics.ready && state.total > 0);

    async function sample(selector, offset, angle=0) {
      const bounds = await page.locator(selector).boundingBox();
      const point = {x:bounds.x + bounds.width / 2 + Math.sin(angle)*offset, y:bounds.y + bounds.height / 2 + Math.cos(angle)*offset};
      await page.mouse.move(point.x, point.y);
      await page.waitForTimeout(180);
      return page.evaluate(point => {
        // Force a repaint so readPixels samples the current frame.
        havenGlass.refresh();havenGlass.renderOnce();
        const canvas = document.querySelector('dialog[open] .modal-cursor-canvas');
        const gl = canvas.getContext('webgl2'), scale = canvas.width / innerWidth;
        const pixels = new Uint8Array(4);
        gl.readPixels(Math.floor(point.x * scale), Math.floor((innerHeight - point.y) * scale), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const cursorUniform=gl.getUniformLocation(gl.getParameter(gl.CURRENT_PROGRAM), 'u_cursor');
        return {alpha:pixels[3], disc:gl.getUniform(gl.getParameter(gl.CURRENT_PROGRAM),cursorUniform), domOpacity:Number(getComputedStyle(document.querySelector('#glass-cursor')).opacity)};
      }, point);
    }

    for (const viewport of [{width:1440,height:920},{width:390,height:844}]) {
      await page.setViewportSize(viewport);
      for (const theme of ['dark', 'light']) {
        await page.evaluate(theme => {
          document.documentElement.dataset.theme = theme;
          const members = Array.from({length:150}, (_, i) => ({...state.pages.values().next().value[0], name:`Photo-${i}.jpg`}));
          document.querySelector('#stack-dialog').showModal();
          renderStackList(members);
          const cards = [...document.querySelectorAll('.stack-card')];
          if (!cards.length || cards.some(card => getComputedStyle(card).animationName !== 'none' || getComputedStyle(card).opacity !== '1')) throw new Error('Stack cards must appear together without an entrance animation');
        }, theme);
        await page.waitForTimeout(650);
        for (const [dialog, selector] of [['stack-dialog','#stack-dialog-close'], ['viewer','#viewer-close']]) {
          if (dialog === 'viewer') {
            await page.evaluate(async () => {
              document.querySelector('#stack-dialog').close();
              await showViewer(0);
            });
            await page.waitForTimeout(650);
          }
          const merged = await sample(selector, 0);
          assert.equal(merged.domOpacity, 0, 'GPU cursor must not have a second DOM disc');
          assert(merged.alpha > 0 && merged.disc === 0, `${dialog}: pointer inside button must form one merged surface`);
          assert(await page.locator(selector).evaluate(button => {
            const content=button.closest('.dialog-heading, .viewer-header, .viewer-tools');
            return Number(getComputedStyle(content).zIndex)>Number(getComputedStyle(document.querySelector('.modal-cursor-canvas')).zIndex);
          }), `${dialog}: icons must stay above the glass at every approach angle`);
          const near = await sample(selector, 30);
          assert(near.alpha > 0, `${dialog}: approaching pointer must draw a merge trail`);
          for(const angle of [-Math.PI/4, Math.PI/4]){
            const diagonal=await sample(selector, 30, angle);
            assert(diagonal.alpha>0&&diagonal.disc===0, `${dialog}: diagonal approach must keep one merged surface`);
          }
          const free = await sample(selector, 85);
          assert(free.alpha > 0 && free.domOpacity === 0, `${dialog}: free pointer must remain visible on GPU`);
          await sample(selector, 0);
          await page.screenshot({path:`.qa/cursor-${dialog}-${viewport.width}-${theme}.png`});
        }
        await page.evaluate(() => document.querySelector('#viewer').close());
        await page.locator('#viewer').waitFor({state:'hidden'});
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS: modal cursor absorption, approach trail, free cursor, simultaneous stack entry; desktop/mobile and dark/light');
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
