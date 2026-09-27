const {chromium} = require('../.qa/node_modules/playwright');
const fs = require('fs');
const assert = require('assert');

(async()=>{
  const url = process.argv[2] || process.env.HAVEN_TEST_URL || fs.readFileSync('.qa/glass-server.log','utf8').trim();
  const browser = await chromium.launch({args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page = await browser.newPage({viewport:{width:1200,height:800}});
  let openCalls = 0, moveCalls = 0, failSource = null;
  const movedSources = [];
  page.on('request', request => { if(request.url().includes('/api/open_folder')) openCalls++; });
  await page.route('**/api/move_file', async route => {
    const [source, target] = JSON.parse(route.request().postData() || '[]');
    moveCalls++;
    movedSources.push(source);
    if(source===failSource){await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Simulated move failure'})});return;}
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
  await page.evaluate(target=>state.rows.get(target)?.setAttribute('data-test-drop-target',''),paths.target);
  const targetRow=page.locator('[data-test-drop-target]');
  await targetRow.waitFor({state:'attached'});
  await page.locator('#selection-mode').click();
  await page.locator('.media-card').nth(0).click();
  await page.locator('.media-card').nth(1).click();
  const selected=await page.evaluate(()=>[...state.selection]);
  assert.strictEqual(selected.length,2);
  await page.evaluate(()=>{
    window.testDrag=null;
    document.querySelector('.media-card.selected').addEventListener('dragstart',event=>{
      window.testDrag={paths:JSON.parse(event.dataTransfer.getData('application/x-haven-paths')),count:event.currentTarget.dataset.dragCount};
    },{once:true});
  });
  await page.locator('.media-card.selected').first().dragTo(targetRow);
  await page.waitForFunction(()=>state.selection.size===0&&state.optimisticMoved.size>=2);
  assert.deepStrictEqual(movedSources.slice(0,2),selected);
  assert.deepStrictEqual(await page.evaluate(()=>window.testDrag),{paths:selected,count:'2 项'});
  const partial=await page.evaluate(()=>state.pages.get(0).filter(item=>!state.optimisticMoved.has(item.path)).slice(0,2).map(item=>item.path));
  const failedPath=partial[0];
  failSource=failedPath;
  const partialResult=await page.evaluate(async({sources,target})=>{
    sources.forEach(source=>state.selection.add(source));
    return queuePhotoMoves(sources,target);
  },{sources:partial,target:paths.target});
  assert.deepStrictEqual(partialResult,{moved:1,failed:1});
  assert.deepStrictEqual(await page.evaluate(()=>[...state.selection]),[failedPath]);
  failSource=null;
  await page.locator('.media-card.selected').first().waitFor();
  const unselected=page.locator('.media-card:not(.selected)').first();
  const unselectedPath=await unselected.evaluate(card=>itemAt(Number(card.dataset.index)).path);
  const beforeSingle=moveCalls;
  await unselected.dragTo(targetRow);
  await page.waitForFunction(path=>state.optimisticMoved.has(path),unselectedPath);
  assert.strictEqual(moveCalls,beforeSingle+1,'Dragging an unselected card must move only that card');
  assert.strictEqual(movedSources.at(-1),unselectedPath);
  assert.deepStrictEqual(await page.evaluate(()=>[...state.selection]),[failedPath]);
  const sourceIndex = await page.locator('.media-card').first().getAttribute('data-index');
  const source = await page.evaluate(index=>state.pages.get(0)?.[Number(index)]?.path, sourceIndex);
  assert(source,'A source photo must be available for the refresh test');
  const baseline = openCalls;
  const beforeQueue=moveCalls;
  await page.evaluate(({source,target})=>{
    state.folder=source.replace(/[\\/][^\\/]+$/,'');
    return Promise.all([queuePhotoMove(source,target),queuePhotoMove(source+'-second.jpg',target),queuePhotoMove(source+'-third.jpg',target)]);
  },{source,target:paths.target});
  assert.strictEqual(moveCalls,beforeQueue+3,'Each queued move must still submit its operation');
  await page.waitForTimeout(120);
  assert.strictEqual(openCalls,baseline,'Rapid moves must not start an immediate folder scan');
  await page.waitForTimeout(900);
  assert.strictEqual(openCalls,baseline,'Moves must not scan automatically');
  await page.locator('#refresh').click();
  await page.waitForTimeout(900);
  assert.strictEqual(openCalls,baseline+1,'The manual refresh button must start the scan');
  console.log(JSON.stringify({passed:true,moveCalls,multiMoved:2,partialResult,automaticOpenCalls:openCalls-baseline-1,manualOpenCalls:1}));
  await browser.close();
})().catch(error=>{console.error(error);process.exit(1);});
