const {chromium} = require('../.qa/node_modules/playwright');
const fs = require('fs');
const assert = require('assert');

const url = fs.readFileSync('.qa/glass-server.log','utf8').trim();
async function pixels(page, selector) {
  return page.evaluate(selector=>{
    const canvas=document.querySelector('#liquid-canvas'),gl=canvas.getContext('webgl2');
    const rect=document.querySelector(selector).getBoundingClientRect(),scale=canvas.width/innerWidth;
    const width=Math.ceil(rect.width*scale),height=Math.ceil(rect.height*scale);
    const data=new Uint8Array(width*height*4);
    gl.readPixels(Math.floor(rect.x*scale),Math.floor((innerHeight-rect.bottom)*scale),width,height,gl.RGBA,gl.UNSIGNED_BYTE,data);
    return [...data];
  },selector);
}

(async()=>{
  const browser=await chromium.launch({args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1440,height:920}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const failures=[];page.on('response',response=>{if(response.status()>=400&&!response.url().endsWith('/favicon.ico'))failures.push(response.url());});
  await page.goto(url);
  await page.evaluate(()=>theme('light'));
  await page.waitForFunction(()=>window.havenGlass?.diagnostics.ready,{},{timeout:20000});
  await page.locator('#scan-progress').waitFor({state:'hidden',timeout:30000});
  await page.waitForTimeout(800);
  const diagnostic=await page.evaluate(()=>window.havenGlass.diagnostics);
  assert.strictEqual(diagnostic.backend,'webgl2');
  const before=await pixels(page,'#theme-button');
  assert(before.filter((value,index)=>index%4===3&&value>0).length>100,'GPU glass must have visible pixels');
  await page.locator('#theme-button').hover();await page.waitForTimeout(400);
  const after=await pixels(page,'#theme-button');
  assert(after.some((value,index)=>Math.abs(value-before[index])>4),'Pointer must change glass pixels');
  await page.mouse.move(850,170);await page.waitForTimeout(400);
  await page.screenshot({path:'.qa/liquid-light.png'});
  await page.locator('[data-kind="video"]').click();await page.waitForTimeout(80);
  const moving=await page.locator('#filters').evaluate(element=>parseFloat(element.style.getPropertyValue('--pill-left')));
  await page.waitForTimeout(700);
  const settled=await page.locator('#filters').evaluate(element=>parseFloat(element.style.getPropertyValue('--pill-left')));
  assert(Math.abs(settled-moving)>1,'Selected glass must spring between filters');
  await page.locator('[data-kind="all"]').click();await page.waitForTimeout(800);
  assert(await page.locator('.media-card').count()<100,'Virtual grid must remain bounded');
  await page.locator('#viewport').evaluate(element=>element.scrollTop=element.scrollHeight);
  await page.waitForFunction(()=>[...document.querySelectorAll('.media-card')].some(card=>Number(card.dataset.index)>=240));
  await page.locator('#search').fill('Photo-244');await page.waitForFunction(()=>document.querySelector('#folder-summary').textContent.startsWith('1 '));
  assert.strictEqual(await page.locator('.media-card').count(),1);
  await page.locator('#search').fill('');await page.waitForFunction(()=>document.querySelector('#folder-summary').textContent.includes('245'));
  await page.locator('.media-card').first().click();await page.waitForFunction(()=>document.querySelector('#viewer-image').naturalWidth>0);
  await page.waitForTimeout(500);
  await page.locator('#viewer-stage').hover();await page.mouse.wheel(0,-400);
  assert(await page.locator('#zoom-label').textContent()!=='100%');
  await page.keyboard.press('ArrowRight');assert((await page.locator('#viewer-count').textContent()).startsWith('2 /'));
  await page.locator('#info-button').click();await page.waitForTimeout(500);await page.screenshot({path:'.qa/liquid-viewer.png'});
  await page.keyboard.press('Escape');await page.locator('#viewer').waitFor({state:'hidden'});
  await page.locator('#settings-button').click();await page.waitForTimeout(500);await page.screenshot({path:'.qa/liquid-settings.png'});
  assert(await page.locator('.modal-liquid-canvas').isVisible());
  await page.locator('[data-close="settings-dialog"]').click();await page.locator('#settings-dialog').waitFor({state:'hidden'});
  await page.locator('#theme-button').click();await page.waitForTimeout(500);await page.screenshot({path:'.qa/liquid-dark.png'});
  for(const width of [800,390]){
    await page.setViewportSize({width,height:width===390?844:600});await page.waitForTimeout(650);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`No page overflow at ${width}px`);
    await page.screenshot({path:`.qa/liquid-${width}.png`});
  }
  assert.deepStrictEqual(errors,[]);assert.deepStrictEqual(failures,[]);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator('#settings-button').click();await page.locator('[data-close="settings-dialog"]').click();await page.locator('#settings-dialog').waitFor({state:'hidden'});
  console.log(JSON.stringify({passed:true,diagnostic,screenshots:6,pointerPixelsChanged:true,errors}));
  await browser.close();

  const fallback=await chromium.launch({args:['--disable-webgl']});
  const fallbackPage=await fallback.newPage({viewport:{width:800,height:600}});
  await fallbackPage.goto(url);await fallbackPage.waitForTimeout(1000);
  assert(await fallbackPage.locator('#settings-button').isVisible());
  assert.strictEqual(await fallbackPage.evaluate(()=>window.havenGlass.diagnostics.ready),false);
  await fallbackPage.locator('#settings-button').click();await fallbackPage.locator('#settings-dialog').waitFor({state:'visible'});
  console.log('CSS fallback remains usable without WebGL');await fallback.close();
})().catch(error=>{console.error(error);process.exit(1);});
