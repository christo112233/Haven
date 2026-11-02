const {chromium} = require('../.qa/node_modules/playwright');
const fs = require('fs');
const assert = require('assert');

(async () => {
  const url = process.argv[2] || process.env.HAVEN_URL || fs.readFileSync('.qa/smooth-server.log', 'utf8').replace(/^\uFEFF/, '').trim();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({viewport:{width:1440,height:920}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => state.total > 0);
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

    await page.evaluate(() => {state.stackExpand=false;closeViewer(false);});
    await page.locator('#viewer').waitFor({state:'hidden'});
    for(const viewport of [{width:1440,height:920},{width:390,height:844}]) {
      await page.setViewportSize(viewport);
      await page.locator('.media-card').first().click({button:'right'});
      await page.locator('#context-menu button').first().hover();
      assert(await page.locator('#context-menu').evaluate(menu => menu.matches(':popover-open')), 'Right-click menu must open above the grid');
      await page.screenshot({path:`.qa/context-menu-${viewport.width}.png`});
      await page.evaluate(() => closeContextMenu());
      await page.waitForFunction(() => !document.querySelector('#context-menu').matches(':popover-open'));
    }
    await page.setViewportSize({width:1440,height:920});
    for(const theme of ['dark','light']){
      await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.querySelector('#theme-select').value=theme;syncSelect('theme-select');},theme);
      await page.locator('#settings-button').click();
      await page.waitForTimeout(650);
      assert(await page.locator('#settings-dialog .select-value').first().textContent(), 'Theme label must be populated');
      assert(await page.locator('#settings-dialog').evaluate(dialog=>dialog.open), 'Settings dialog must be open');
      await page.screenshot({path:`.qa/settings-controls-${theme}.png`});
      await page.locator('[data-close="settings-dialog"]').click();
      await page.locator('#settings-dialog').waitFor({state:'hidden'});
    }
    assert.deepEqual(errors, []);
    console.log('PASS: repeated stack metadata toggles, context menu open/cleanup, settings dialog controls; desktop/mobile, dark/light');
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error);process.exitCode=1;});
