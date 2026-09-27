const {chromium} = require('../.qa/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

(async () => {
  const browser = await chromium.launch({args:process.argv.includes('--disable-webgl')?['--disable-webgl']:[]});
  const page = await browser.newPage({viewport:{width:1440,height:920}});
  const errors = [];
  page.on('pageerror',error=>errors.push(error.message));
  const url = process.argv[2] || process.env.HAVEN_URL || fs.readFileSync(path.join(__dirname,'../.qa/server.log'),'utf8').trim();
  await page.goto(url);
  await page.waitForFunction(()=>state.job && state.folder,{},{timeout:30000});
  await page.waitForFunction(()=>document.querySelector('#folder-summary').textContent.includes('245'),{},{timeout:30000});
  await page.waitForFunction(()=>document.querySelectorAll('.media-card img').length>0 && [...document.querySelectorAll('.media-card img')].some(image=>image.naturalWidth>0),{},{timeout:30000});
  await page.locator('#scan-progress').waitFor({state:'hidden',timeout:60000});
  assert(await page.locator('#warning').isHidden(), 'Writable gallery should not show cache warnings');
  await page.waitForTimeout(400);
  await page.screenshot({path:'.qa/desktop-dark.png'});
  const firstCount = await page.locator('.media-card').count();
  assert(firstCount>0,'The first page must render cards');
  assert(firstCount < 100, 'Grid must keep the 245-item gallery bounded');
  await page.evaluate(() => { window.__firstPage = state.pages.get(0).slice(); });
  const virtualCounts = {};
  for(const total of [1,70,200]){
    await page.evaluate(async count => {
      state.total=count;
      state.pages.set(0,window.__firstPage.slice(0,count));
      document.getElementById('viewport').scrollTop=0;
      await renderGrid();
    },total);
    const topCount=await page.locator('.media-card').count();
    assert(topCount<=total,`Too many cards for ${total} items`);
    if(total>1)assert(topCount<total,`${total} items should render only near the viewport`);
    await page.locator('#viewport').evaluate(element=>element.scrollTop=element.scrollHeight);
    await page.waitForFunction(last=>[...document.querySelectorAll('.media-card')].some(card=>Number(card.dataset.index)===last),total-1);
    const bottomCount=await page.locator('.media-card').count();
    assert(bottomCount<=topCount+8,`Bottom of ${total}-item gallery rendered too many cards`);
    virtualCounts[total]={top:topCount,bottom:bottomCount};
  }
  await page.evaluate(async () => {
    state.total=245;
    state.pages.set(0,window.__firstPage);
    document.getElementById('viewport').scrollTop=0;
    await renderGrid();
  });
  const thumbWidth=await page.locator('.media-card').first().evaluate(card=>card.getBoundingClientRect().width);
  await page.locator('#thumb-size').evaluate(input=>{input.value='120';input.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.waitForFunction(before=>document.querySelector('.media-card').getBoundingClientRect().width<before,thumbWidth);
  assert(await page.locator('.media-card').count()<100,'Resizing thumbnails must keep the grid bounded');
  await page.locator('#thumb-size').evaluate(input=>{input.value='240';input.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.waitForFunction(before=>document.querySelector('.media-card').getBoundingClientRect().width>before*.8,thumbWidth);
  const sameRowMutations=await page.evaluate(async () => {
    const viewport=document.getElementById('viewport'),grid=document.getElementById('grid');
    let changes=0;
    const observer=new MutationObserver(records=>{changes+=records.length;});
    observer.observe(grid,{subtree:true,childList:true,characterData:true});
    viewport.scrollTop+=1;
    await new Promise(resolve=>setTimeout(resolve,100));
    observer.disconnect();
    return changes;
  });
  assert.strictEqual(sameRowMutations,0,'Scrolling within the same visible rows should not rebuild cards');
  const frameTiming=await page.evaluate(async () => {
    state.total=70;
    state.pages.set(0,window.__firstPage.slice(0,70));
    document.getElementById('viewport').scrollTop=0;
    await renderGrid();
    const sample=async scrolling=>{
      const samples=[];
      let previous=await new Promise(resolve=>requestAnimationFrame(resolve));
      for(let index=0;index<45;index++){
        if(scrolling)document.getElementById('viewport').scrollTop+=12;
        const now=await new Promise(resolve=>requestAnimationFrame(resolve));
        samples.push(now-previous);previous=now;
      }
      samples.sort((a,b)=>a-b);
      return Math.round(samples[Math.floor(samples.length*.95)]*10)/10;
    };
    const idleP95Ms=await sample(false),scrollP95Ms=await sample(true);
    state.total=245;
    state.pages.set(0,window.__firstPage);
    document.getElementById('viewport').scrollTop=0;
    await renderGrid();
    return {idleP95Ms,scrollP95Ms};
  });
  await page.locator('#selection-mode').click();
  await page.locator('.media-card').first().click();
  await page.locator('.media-card.selected').first().waitFor();
  await page.locator('#selection-mode').click();
  await page.waitForFunction(()=>document.querySelectorAll('.media-card.selected').length===0);
  await page.locator('.media-card').first().click();
  await page.waitForFunction(()=>document.querySelector('#viewer-image').naturalWidth>0);
  await page.locator('#viewer-stage').hover();await page.mouse.wheel(0,-500);
  assert(await page.locator('#zoom-label').textContent() !== '100%');
  await page.keyboard.press('Space');
  await page.waitForFunction(()=>state.scale===1&&state.x===0&&state.y===0&&document.querySelector('#zoom-label').textContent==='100%');
  await page.keyboard.press('d');await page.waitForFunction(()=>document.querySelector('#viewer-count').textContent.startsWith('2 /'));
  await page.keyboard.press('a');await page.waitForFunction(()=>document.querySelector('#viewer-count').textContent.startsWith('1 /'));
  await page.keyboard.press('D');await page.waitForFunction(()=>document.querySelector('#viewer-count').textContent.startsWith('2 /'));
  await page.keyboard.press('A');await page.waitForFunction(()=>document.querySelector('#viewer-count').textContent.startsWith('1 /'));
  await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.querySelector('#viewer-count').textContent.startsWith('2 /'));
  await page.locator('#viewer-rating').click();
  await page.locator('#rating-dialog').waitFor({state:'visible'});
  await page.keyboard.press('d');await page.keyboard.press('Space');await page.keyboard.press('f');
  assert((await page.locator('#viewer-count').textContent()).startsWith('2 /'),'Shortcuts must not act behind a modal');
  assert(await page.locator('#details').isHidden(),'Details must stay closed behind a modal');
  await page.keyboard.press('Escape');
  await page.locator('#rating-dialog').waitFor({state:'hidden'});
  await page.keyboard.press('f');await page.locator('#details').waitFor({state:'visible'});
  await page.keyboard.press('F');await page.locator('#details').waitFor({state:'hidden'});
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
  const glassBackend=await page.evaluate(()=>window.havenGlass?.diagnostics.backend);
  console.log(JSON.stringify({passed:true,virtualCardCount:firstCount,virtualCounts,sameRowMutations,frameTiming,glassBackend,screenshots:6,errors}));
  await browser.close();
})().catch(error=>{console.error(error);process.exit(1);});
