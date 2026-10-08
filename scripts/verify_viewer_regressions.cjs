const {chromium} = require('../.qa/node_modules/playwright');
const fs = require('fs');
const assert = require('assert');

(async () => {
  const url = process.argv[2] || process.env.HAVEN_URL || fs.readFileSync('.qa/smooth-server.log', 'utf8').replace(/^\uFEFF/, '').trim();
  const browser = await chromium.launch({args:['--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:920}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => havenGlass.diagnostics.ready && state.total > 0);
    await page.evaluate(async () => {
      state.stack=false;await reloadFilter();
      const cover = {...await ensureItem(0),stack_id:'regression',stack_size:2};
      const member = {...await ensureItem(1),favorite:false,flagged:false,rejected:false};
      window.testMembers = [cover, member];
      window.testPatches = [];
      const backend = api;
      // Keep metadata writes isolated from the preview library.
      window.api = async (method, ...args) => {
        if(method === 'stack_items') return testMembers;
        if(method === 'list_tags') return [];
        if(method === 'update_photo_metadata') {
          const [paths,patch] = args;
          testPatches.push(patch);
          return {count:paths.length,metadata:Object.fromEntries(paths.map(path => [path,{...patch}]))};
        }
        return backend(method, ...args);
      };
      state.pages = new Map([[0,[cover]]]);state.total = 1;
      await openStackExpand(cover, 0);
    });
    await page.locator('.stack-card').nth(1).click();
    await page.waitForFunction(() => document.querySelector('#viewer').open && state.current.path === testMembers[1].path);
    await page.locator('#stack-dialog').waitFor({state:'hidden'});
    for(const key of ['favorite','flagged','rejected']) {
      for(const expected of [true,false,true,false]) {
        await page.locator(`#viewer-${key}`).click();
        await page.waitForFunction(({key,expected}) => state.current[key] === expected && document.querySelector(`#viewer-${key}`).getAttribute('aria-pressed') === String(expected), {key,expected});
      }
    }
    assert.deepEqual(await page.evaluate(() => testPatches.map(patch => Object.values(patch)[0])), [true,false,true,false,true,false,true,false,true,false,true,false]);
    assert(await page.evaluate(() => !state.pages.get(0).some(item => item.path === state.current.path)), 'Regression must use a stack member absent from the main grid');

    for(const theme of ['dark','light']) {
      await page.evaluate(theme => {
        document.documentElement.dataset.theme = theme;
        const source=document.createElement('canvas');source.width=1440;source.height=920;
        const ctx=source.getContext('2d');
        for(let x=0;x<source.width;x+=12){ctx.fillStyle=x%24?'#d04745':'#37b0bc';ctx.fillRect(x,0,12,source.height);}
        const image=document.querySelector('#viewer-image');
        image.src=source.toDataURL();image.style.cssText='position:absolute;width:100%;height:100%;max-width:none;max-height:none;object-fit:fill;transform:none';
        image.onload=()=>havenGlass.refresh();
      },theme);
      await page.waitForFunction(() => document.querySelector('#viewer-image').complete && document.querySelector('#viewer-image').naturalWidth === 1440);
      await page.mouse.move(720,400);
      await page.waitForTimeout(650);
      const glass=await page.evaluate(() => {
        havenGlass.refresh();havenGlass.renderOnce();
        const canvas=document.querySelector('#viewer .modal-liquid-canvas'),gl=canvas.getContext('webgl2');
        const tools=document.querySelector('.viewer-tools'),bounds=tools.getBoundingClientRect(),scale=canvas.width/innerWidth;
        const pixel=new Uint8Array(4);
        gl.readPixels(Math.floor((bounds.x+bounds.width/2)*scale),Math.floor((innerHeight-bounds.top-3)*scale),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
        return {alpha:pixel[3],canvasZ:Number(getComputedStyle(canvas).zIndex),photoZ:Number(getComputedStyle(document.querySelector('#viewer-stage')).zIndex),contentZ:Number(getComputedStyle(tools).zIndex)};
      });
      assert(glass.alpha>0&&glass.canvasZ>glass.photoZ&&glass.canvasZ<glass.contentZ, 'Toolbar glass must be visible above the photo and below its icons');
      await page.screenshot({path:`.qa/viewer-toolbar-refraction-${theme}.png`});
    }
    await page.evaluate(() => {state.stackExpand=false;closeViewer(false);});
    await page.locator('#viewer').waitFor({state:'hidden'});
    for(const viewport of [{width:1440,height:920},{width:390,height:844}]) {
      await page.setViewportSize(viewport);
      await page.locator('.media-card').first().click({button:'right'});
      await page.locator('#context-menu button').first().hover();
      await page.waitForFunction(() => document.querySelector('#glass-cursor').matches(':popover-open') && Number(getComputedStyle(document.querySelector('#glass-cursor')).opacity) === 1);
      assert(await page.locator('#context-menu').evaluate(menu => menu.matches(':popover-open')), 'Raising the cursor must keep the context menu open');
      await page.screenshot({path:`.qa/context-menu-cursor-${viewport.width}.png`});
      await page.evaluate(() => closeContextMenu());
      await page.waitForFunction(() => !document.querySelector('#glass-cursor').hasAttribute('popover'));
    }
    await page.setViewportSize({width:1440,height:920});
    for(const theme of ['dark','light']){
      await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.querySelector('#theme-select').value=theme;syncSelect('theme-select');},theme);
      await page.locator('#settings-button').click();
      await page.waitForTimeout(650);
      assert(await page.locator('#settings-dialog').evaluate(dialog=>{
        const glass=dialog.querySelector('.modal-liquid-canvas');
        return [...dialog.querySelectorAll('.settings-row')].every(row=>Number(getComputedStyle(row).zIndex)>Number(getComputedStyle(glass).zIndex));
      }),'Settings labels, dropdown values and switches must sit above their glass');
      assert(await page.locator('#settings-dialog .select-value').first().textContent(), 'Theme label must be populated');
      await page.screenshot({path:`.qa/settings-controls-${theme}.png`});
      await page.locator('[data-close="settings-dialog"]').click();
      await page.locator('#settings-dialog').waitFor({state:'hidden'});
    }
    assert.deepEqual(errors, []);
    console.log('PASS: repeated stack metadata toggles, toolbar refraction above photos, top-layer context cursor and cleanup, settings controls above glass');
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error);process.exitCode=1;});
