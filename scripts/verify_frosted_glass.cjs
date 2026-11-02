const {chromium} = require('../.qa/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Verifies the CSS frosted-glass replacement: no WebGL canvas, no custom cursor,
// CSS backdrop-filter on the main surfaces, and a persistent transparency slider.
(async () => {
  const url = process.argv[2] || process.env.HAVEN_URL || fs.readFileSync(path.join(__dirname,'../.qa/server.log'),'utf8').trim();
  const browser = await chromium.launch();
  const page = await browser.newPage({viewport:{width:1440,height:920}});
  const errors = [];
  const legacyRequests = [];
  const failedResponses = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const requestUrl = request.url();
    if (requestUrl.includes('/shaders/') || requestUrl.includes('liquid-glass')) legacyRequests.push(requestUrl);
  });
  page.on('response', response => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) failedResponses.push(`${response.status()} ${response.url()}`);
  });
  try {
    await page.goto(url);
    await page.waitForFunction(() => state.job, {}, {timeout:30000});
    await page.locator('#scan-progress').waitFor({state:'hidden',timeout:60000});
    await page.waitForFunction(() => state.total > 0, {}, {timeout:30000}).catch(() => {});

    const legacy = await page.evaluate(() => ({
      element: document.querySelector('#liquid-canvas,#glass-cursor,.liquid-canvas,.modal-liquid-canvas'),
      havenGlass: typeof window.havenGlass,
      liquidReady: document.documentElement.classList.contains('liquid-ready'),
      bodyCursor: getComputedStyle(document.body).cursor,
    }));
    assert.strictEqual(legacy.element, null, 'WebGL canvas / custom cursor elements must be gone');
    assert.strictEqual(legacy.havenGlass, 'undefined', 'window.havenGlass must not be defined');
    assert.strictEqual(legacy.liquidReady, false, 'The liquid-ready class must not be applied');
    assert.notStrictEqual(legacy.bodyCursor, 'none', 'The custom cursor must not hide the native pointer');

    const readFrost = () => page.evaluate(() => {
      const read = selector => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const style = getComputedStyle(node);
        return {
          backdropFilter: style.backdropFilter || '',
          // Chromium no longer exposes the -webkit- alias through computed style,
          // so the prefixed fallback is checked in the CSS source below.
          webkitBackdropFilter: typeof style.webkitBackdropFilter === 'string' ? style.webkitBackdropFilter : '',
        };
      };
      let cssText = '';
      const walk = rules => {
        for (const rule of rules) {
          if (rule.cssRules) walk(rule.cssRules);
          else if (rule.cssText) cssText += rule.cssText + '\n';
        }
      };
      for (const sheet of document.styleSheets) {
        try { walk(sheet.cssRules); } catch { /* cross-origin or unavailable sheet */ }
      }
      return {sidebar: read('#sidebar'), prefixedFallback: cssText.includes('-webkit-backdrop-filter')};
    });
    const sidebarFrost = await readFrost();
    const assertFrost = (name, style) => {
      assert(style, `${name} must exist`);
      assert(style.backdropFilter.includes('blur('), `${name} must compute a CSS backdrop-filter blur(...): ${JSON.stringify(style)}`);
      if (style.webkitBackdropFilter) assert(style.webkitBackdropFilter.includes('blur('), `${name} -webkit-backdrop-filter must keep the blur: ${JSON.stringify(style)}`);
    };
    assertFrost('#sidebar', sidebarFrost.sidebar);
    // Chromium drops the prefixed alias from the parsed CSSOM, so check the
    // served stylesheet source instead of computed styles/rules.
    const cssSource = await page.evaluate(async () => {
      const link = document.querySelector('link[rel="stylesheet"]');
      return link ? await (await fetch(link.href)).text() : '';
    });
    assert(cssSource.includes('-webkit-backdrop-filter'), 'The stylesheet must keep the -webkit-backdrop-filter fallback for WebView2/WebKit');

    await page.evaluate(() => theme('dark'));
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark' && !document.documentElement.classList.contains('theme-capture'));
    await page.waitForTimeout(300);
    await page.screenshot({path:'.qa/frosted-dark.png'});

    await page.locator('#theme-button').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light' && !document.documentElement.classList.contains('theme-capture'));
    assert.strictEqual(await page.locator('html').getAttribute('data-theme'), 'light', 'Theme button must switch to light');
    await page.waitForTimeout(300);
    await page.screenshot({path:'.qa/frosted-light.png'});

    await page.locator('#theme-button').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    assert.strictEqual(await page.locator('html').getAttribute('data-theme'), 'dark', 'Theme button must switch back to dark');

    // Restore the default transparency before the dialog screenshot so the
    // persisted "fully transparent" value from an earlier run does not make
    // the panel invisible.
    await page.evaluate(() => {
      const input = document.querySelector('#glass-transparency');
      if (input) { input.value = '24'; input.dispatchEvent(new Event('input', {bubbles:true})); }
    });
    await page.locator('#settings-button').click();
    await page.locator('#settings-dialog').waitFor({state:'visible'});
    assert(await page.locator('#settings-dialog').evaluate(dialog => dialog.open), 'Settings dialog must open');
    const dialogFrost = await page.evaluate(() => {
      const node = document.querySelector('#settings-dialog');
      if (!node || !node.classList.contains('panel-dialog')) return null;
      const style = getComputedStyle(node);
      return {backdropFilter: style.backdropFilter || '', webkitBackdropFilter: typeof style.webkitBackdropFilter === 'string' ? style.webkitBackdropFilter : ''};
    });
    assertFrost('#settings-dialog.panel-dialog', dialogFrost);
    const dialogAlpha = await page.locator('#settings-dialog').evaluate(dialog => {
      const value = getComputedStyle(dialog).backgroundColor;
      const match = value.match(/\/\s*([0-9.]+)\s*\)/);
      return match ? Number(match[1]) : 1;
    });
    assert(dialogAlpha > 0.4, `Settings dialog must stay readable at the default transparency: ${dialogAlpha}`);
    const slider = page.locator('#glass-transparency');
    await slider.waitFor({state:'visible'});
    assert(await slider.isEnabled(), 'Glass transparency slider must be interactable');
    assert.strictEqual(await slider.getAttribute('max'), '100', 'Glass transparency slider must keep the 0..100 range');
    await page.waitForTimeout(350);  // let the dialog open animation finish
    await page.screenshot({path:'.qa/frosted-dialog.png'});

    const readAlphaFactor = () => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--glass-alpha-factor')));
    const factors = [];
    for (const percent of [0, 24, 100]) {
      await slider.evaluate((input, value) => {
        input.value = String(value);
        input.dispatchEvent(new Event('input', {bubbles:true}));
        input.dispatchEvent(new Event('change', {bubbles:true}));
      }, percent);
      factors.push(await readAlphaFactor());
      assert.strictEqual(await slider.inputValue(), String(percent), `Slider must show ${percent}`);
    }
    const [factorOpaque, factorMiddle, factorTransparent] = factors;
    assert(factorOpaque >= 0.9, `Slider 0 must keep the glass nearly opaque: ${factors}`);
    assert(factorMiddle > factorTransparent + 0.1 && factorMiddle < factorOpaque - 0.1, `Middle transparency must sit between the extremes: ${factors}`);
    assert(factorTransparent >= 0.25 && factorTransparent <= 0.4, `Alpha factor must be clamped to roughly 0.3 at full transparency: ${factors}`);
    assert(factors.every(factor => factor >= 0.25 && factor <= 1.01), `Alpha factor must stay within the clamped range: ${factors}`);

    const persisted = page.waitForRequest(request => request.url().includes('/api/settings') && (request.postData() || '').includes('glass_transparency'), {timeout:5000});
    await slider.evaluate(input => {
      input.value = '100';
      input.dispatchEvent(new Event('input', {bubbles:true}));
      input.dispatchEvent(new Event('change', {bubbles:true}));
    });
    await persisted;
    const persistedFactor = await readAlphaFactor();
    await page.locator('[data-close="settings-dialog"]').click();
    await page.locator('#settings-dialog').waitFor({state:'hidden'});

    await page.emulateMedia({reducedMotion:'reduce'});
    await page.locator('#settings-button').click();
    await page.locator('#settings-dialog').waitFor({state:'visible'});
    assert(await page.locator('#settings-dialog').evaluate(dialog => dialog.open), 'Settings dialog must stay usable with reduced motion');
    assert(await slider.isVisible(), 'Glass transparency slider must stay visible with reduced motion');
    await page.locator('[data-close="settings-dialog"]').click();
    await page.locator('#settings-dialog').waitFor({state:'hidden'});
    await page.emulateMedia({reducedMotion:'no-preference'});

    await page.reload();
    await page.waitForFunction(() => state.job, {}, {timeout:30000});
    await page.locator('#scan-progress').waitFor({state:'hidden',timeout:60000});
    await page.waitForFunction(() => document.querySelector('#glass-transparency'), {}, {timeout:30000});
    const restoredFactor = await readAlphaFactor();
    assert(Math.abs(restoredFactor - persistedFactor) < 0.02, `Glass transparency must persist across reloads: ${persistedFactor} -> ${restoredFactor}`);
    assert.strictEqual(await page.locator('#glass-transparency').evaluate(input => input.value), '100', 'Glass transparency slider must be restored after reload');

    await page.setViewportSize({width:390,height:844});
    await page.waitForTimeout(400);
    assert(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'Frosted glass layout must not overflow at 390px');
    await page.screenshot({path:'.qa/frosted-390.png'});

    assert.deepStrictEqual(legacyRequests, [], 'No legacy WebGL/shader assets may be requested');
    assert.deepStrictEqual(failedResponses, [], 'No failed (4xx+) responses are allowed');
    assert.deepStrictEqual(errors, []);
    console.log(JSON.stringify({passed:true,alphaFactors:factors,persistedFactor,restoredFactor,surfaces:{sidebar:sidebarFrost.sidebar.backdropFilter,dialog:dialogFrost.backdropFilter},screenshots:4,legacyRequests,failedResponses,errors}));
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
