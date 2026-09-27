const {chromium} = require('../.qa/node_modules/playwright');
const fs = require('fs');
const assert = require('assert');

(async()=>{
  const url = process.env.HAVEN_TEST_URL || fs.readFileSync('.qa/glass-server.log','utf8').trim();
  const browser = await chromium.launch({args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page = await browser.newPage({viewport:{width:1200,height:800}});
  let openCalls = 0, moveCalls = 0;
  page.on('request', request => { if(request.url().includes('/api/open_folder')) openCalls++; });
  await page.route('**/api/move_file', async route => {
    const [, source, target] = JSON.parse(route.request().postData() || '[]');
    moveCalls++;
    const name = source.split(/[\\/]/).pop();
    await route.fulfill({contentType:'application/json',body:JSON.stringify({result:{path:target+'\\'+name,name,old_parent:source.replace(/[\\/][^\\/]+$/,''),parent:target}})});
  });
  await page.goto(url);
  await page.waitForFunction(()=>window.havenGlass?.diagnostics.ready,{},{timeout:20000});
  await page.locator('#scan-progress').waitFor({state:'hidden',timeout:60000});
  await page.locator('.media-card').first().waitFor({state:'attached'});
  const paths = await page.evaluate(async()=>{
    const root=state.roots[0],entry=await api('folders',root);
    return {root,target:entry.children[0].path};
  });
  const sourceIndex = await page.locator('.media-card').first().getAttribute('data-index');
  const source = await page.evaluate(index=>state.pages.get(0)?.[Number(index)]?.path, sourceIndex);
  assert(source,'A source photo must be available for the refresh test');
  const baseline = openCalls;
  await page.evaluate(({source,target})=>{
    state.folder=source.replace(/[\\/][^\\/]+$/,'');
    return Promise.all([queuePhotoMove(source,target),queuePhotoMove(source+'-second.jpg',target),queuePhotoMove(source+'-third.jpg',target)]);
  },{source,target:paths.target});
  assert.strictEqual(moveCalls,3,'Each drop must still submit its move operation');
  await page.waitForTimeout(120);
  assert.strictEqual(openCalls,baseline,'Rapid moves must not start an immediate folder scan');
  await page.waitForTimeout(900);
  assert.strictEqual(openCalls,baseline,'Moves must not scan automatically');
  await page.locator('#refresh').click();
  await page.waitForTimeout(900);
  assert.strictEqual(openCalls,baseline+1,'The manual refresh button must start the scan');
  console.log(JSON.stringify({passed:true,moveCalls,automaticOpenCalls:openCalls-baseline-1,manualOpenCalls:1}));
  await browser.close();
})().catch(error=>{console.error(error);process.exit(1);});
