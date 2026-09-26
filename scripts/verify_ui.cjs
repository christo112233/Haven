const {chromium} = require('../.qa/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({viewport:{width:1440,height:920}});
  const errors = [];
  page.on('pageerror',error=>errors.push(error.message));
  const url = fs.readFileSync(path.join(__dirname,'../.qa/server.log'),'utf8').trim();
  await page.goto(url);
  await page.locator('#add-folder').click();
  await page.locator('#folder-path').fill(path.resolve(__dirname,'../.qa/gallery'));
  await page.locator('#path-form button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#folder-summary').textContent.includes('245'),{},{timeout:30000});
  await page.waitForFunction(()=>document.querySelectorAll('.media-card img').length>0 && [...document.querySelectorAll('.media-card img')].some(image=>image.naturalWidth>0),{},{timeout:30000});
  await page.locator('#scan-progress').waitFor({state:'hidden',timeout:60000});
  assert(await page.locator('#warning').isHidden(), 'Writable gallery should not show cache warnings');
  await page.waitForTimeout(400);
  await page.screenshot({path:'.qa/desktop-dark.png'});
  const firstCount = await page.locator('.media-card').count();
  assert(firstCount < 100, 'Grid must virtualize more than 200 items');
  await page.locator('.media-card').first().click();
  await page.waitForFunction(()=>document.querySelector('#viewer-image').naturalWidth>0);
  await page.locator('#viewer-stage').hover();await page.mouse.wheel(0,-500);
  assert(await page.locator('#zoom-label').textContent() !== '100%');
  await page.keyboard.press('ArrowRight');assert((await page.locator('#viewer-count').textContent()).startsWith('2 /'));
  await page.locator('#info-button').click();await page.screenshot({path:'.qa/viewer.png'});await page.keyboard.press('Escape');
  await page.locator('#viewport').evaluate(element=>element.scrollTop=element.scrollHeight);
  await page.waitForFunction(()=>[...document.querySelectorAll('.media-card')].some(card=>Number(card.dataset.index)>=240));
  assert(await page.locator('.media-card').count()<100);
  await page.locator('#search').fill('Photo-244');
  await page.waitForFunction(()=>document.querySelector('#folder-summary').textContent.startsWith('1 个'));
  assert.strictEqual(await page.locator('.media-card').count(),1);
  await page.locator('#search').fill('');await page.waitForFunction(()=>document.querySelector('#folder-summary').textContent.includes('245'));
  await page.locator('#theme-button').click();await page.screenshot({path:'.qa/desktop-light.png'});
  for(const size of [{width:800,height:600},{width:390,height:844}]){
    await page.setViewportSize(size);await page.waitForTimeout(350);await page.screenshot({path:`.qa/layout-${size.width}.png`});
    const overflow = await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
    assert(!overflow,`Document overflows at ${size.width}px`);
  }
  await page.setViewportSize({width:1440,height:920});
  await page.locator('#theme-button').click();
  assert.deepStrictEqual(errors,[]);
  console.log(JSON.stringify({passed:true,virtualCardCount:firstCount,screenshots:6,errors}));
  await browser.close();
})().catch(error=>{console.error(error);process.exit(1);});
