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
  await page.locator('#settings-button').click();
  await page.locator('#settings-dialog .select-button').click();
  await page.locator('#settings-dialog .select-option[data-value="dark"]').click();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  await page.waitForFunction(()=>!document.documentElement.classList.contains('theme-capture'));
  assert.strictEqual(await page.locator('html').getAttribute('data-theme'),'dark','Settings appearance menu must switch to dark');
  await page.locator('#settings-dialog .select-button').click();
  await page.locator('#settings-dialog .select-option[data-value="light"]').click();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
  await page.waitForFunction(()=>!document.documentElement.classList.contains('theme-capture'));
  assert.strictEqual(await page.locator('html').getAttribute('data-theme'),'light','Settings appearance menu must switch to light');
  assert.strictEqual(await page.locator('#glass-transparency').getAttribute('max'),'100');
  await page.locator('#glass-transparency').fill('100');
  assert.strictEqual(await page.locator('#glass-transparency-value').textContent(),'100%');
  await page.locator('#glass-transparency').fill('24');
  await page.locator('[data-close="settings-dialog"]').click();
  await page.locator('#settings-dialog').waitFor({state:'hidden'});
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
  await page.evaluate(()=>theme('dark'));
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark'&&!document.documentElement.classList.contains('theme-capture'));
  await page.evaluate(()=>theme('light'));
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='light'&&!document.documentElement.classList.contains('theme-capture'));
  await page.locator('[data-kind="all"]').click();await page.waitForTimeout(800);
  assert(await page.locator('.media-card').count()<100,'Virtual grid must remain bounded');
  await page.locator('#viewport').evaluate(element=>element.scrollTop=element.scrollHeight);
  await page.waitForFunction(()=>[...document.querySelectorAll('.media-card')].some(card=>Number(card.dataset.index)>=240));
  await page.locator('#search').fill('Photo-244');await page.waitForFunction(()=>document.querySelector('#folder-summary').textContent.startsWith('1 '));
  assert.strictEqual(await page.locator('.media-card').count(),1);
  await page.locator('#search').fill('');await page.waitForFunction(()=>document.querySelector('#folder-summary').textContent.includes('245'));
  await page.locator('.media-card').first().click();await page.waitForFunction(()=>document.querySelector('#viewer-image').naturalWidth>0);
  await page.waitForTimeout(400);
  assert(await page.locator('.viewer-tools').evaluate(element=>{
    const tools=element.getBoundingClientRect(),stage=document.querySelector('#viewer-stage').getBoundingClientRect();
    return Math.abs(tools.bottom-(innerHeight-24))<2&&Math.abs((tools.left+tools.right)/2-innerWidth/2)<2&&stage.bottom>=tools.bottom;
  }),'Viewer tools must remain centered at the bottom over the photo stage');
  assert(await page.locator('.viewer-tools').evaluate(element=>getComputedStyle(element).backgroundColor==='rgba(0, 0, 0, 0)'),'Viewer tools must use transparent GPU glass');
  assert(await page.locator('#viewer').evaluate(element=>getComputedStyle(element).backgroundColor.includes('234, 244, 248')),'Light theme viewer must use a light surface');
  await page.waitForTimeout(500);
  const zoomBefore=await page.evaluate(()=>{
    const rect=document.querySelector('#viewer-image').getBoundingClientRect();
    return {centerX:rect.x+rect.width/2,centerY:rect.y+rect.height/2,scale:state.scale};
  });
  const anchor={x:zoomBefore.centerX+80,y:zoomBefore.centerY+60};
  await page.mouse.move(anchor.x,anchor.y);await page.mouse.wheel(0,-400);
  const zoomAfter=await page.evaluate(()=>{
    const rect=document.querySelector('#viewer-image').getBoundingClientRect();
    return {centerX:rect.x+rect.width/2,centerY:rect.y+rect.height/2,scale:state.scale};
  });
  const ratio=zoomAfter.scale/zoomBefore.scale;
  assert(Math.abs(zoomAfter.centerX-(zoomBefore.centerX+(anchor.x-zoomBefore.centerX)*(1-ratio)))<2,'Zoom must preserve pointer X');
  assert(Math.abs(zoomAfter.centerY-(zoomBefore.centerY+(anchor.y-zoomBefore.centerY)*(1-ratio)))<2,'Zoom must preserve pointer Y');
  assert(await page.locator('#zoom-label').textContent()!=='100%');
  await page.keyboard.press('ArrowRight');assert((await page.locator('#viewer-count').textContent()).startsWith('2 /'));
  await page.locator('#info-button').click();await page.waitForTimeout(500);await page.screenshot({path:'.qa/liquid-viewer.png'});
  assert(await page.locator('#details').evaluate(element=>getComputedStyle(element).backgroundColor==='rgba(0, 0, 0, 0)'),'Details must use the GPU glass layer');
  assert(await page.evaluate(()=>{
    const canvas=document.querySelector('.modal-liquid-canvas'),gl=canvas.getContext('webgl2');
    const rect=document.querySelector('#details').getBoundingClientRect(),scale=canvas.width/innerWidth;
    const pixel=new Uint8Array(4);
    gl.readPixels(Math.floor((rect.left+20)*scale),Math.floor((innerHeight-rect.top-20)*scale),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
    return pixel[3]>0;
  }),'Details glass must be drawn');
  await page.keyboard.press('Escape');await page.locator('#viewer').waitFor({state:'hidden'});
  await page.evaluate(async()=>{
    const source=document.createElement('canvas');source.width=400;source.height=300;
    source.getContext('2d').fillStyle='#ef2828';source.getContext('2d').fillRect(0,0,400,300);
    window.testVideoSource=source;
    const video=document.querySelector('#viewer-video');
    document.querySelector('#viewer-image').hidden=true;video.hidden=false;video.muted=true;
    video.srcObject=source.captureStream(15);
    document.querySelector('#viewer').showModal();
    await video.play();
  });
  await page.waitForFunction(()=>document.querySelector('#viewer-video').readyState>=2);
  const videoBounds=await page.locator('#viewer-video').boundingBox();
  await page.mouse.move(videoBounds.x+videoBounds.width/2,videoBounds.y+videoBounds.height/2);
  const videoPixel=()=>page.evaluate(()=>{
    const canvas=document.querySelector('.modal-liquid-canvas'),gl=canvas.getContext('webgl2');
    const rect=document.querySelector('#viewer-video').getBoundingClientRect(),scale=canvas.width/innerWidth;
    const pixel=new Uint8Array(4);
    gl.readPixels(Math.floor((rect.x+rect.width/2)*scale),Math.floor((innerHeight-rect.y-rect.height/2)*scale),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
    return [...pixel];
  });
  await page.waitForTimeout(400);const redVideoPixel=await videoPixel();
  await page.evaluate(()=>{const canvas=window.testVideoSource,ctx=canvas.getContext('2d');ctx.fillStyle='#285bef';ctx.fillRect(0,0,canvas.width,canvas.height);});
  let blueVideoPixel;
  for(let attempt=0;attempt<20;attempt++){
    await page.waitForTimeout(120);
    blueVideoPixel=await videoPixel();
    if(redVideoPixel[0]>blueVideoPixel[0]+25&&blueVideoPixel[2]>redVideoPixel[2]+25)break;
  }
  assert(redVideoPixel[0]>blueVideoPixel[0]+25&&blueVideoPixel[2]>redVideoPixel[2]+25,`Video glass cursor must transmit changing video pixels: ${redVideoPixel} -> ${blueVideoPixel}`);
  await page.evaluate(()=>{const video=document.querySelector('#viewer-video');video.pause();video.srcObject.getTracks().forEach(track=>track.stop());video.srcObject=null;document.querySelector('#viewer').close();});
  await page.locator('#viewer').waitFor({state:'hidden'});
  await page.locator('#settings-button').click();await page.waitForTimeout(500);await page.screenshot({path:'.qa/liquid-settings.png'});
  assert(await page.locator('.modal-liquid-canvas').isVisible());
  await page.locator('[data-close="settings-dialog"]').click();await page.locator('#settings-dialog').waitFor({state:'hidden'});
  await page.locator('#theme-button').click();await page.mouse.move(850,170);await page.waitForTimeout(500);await page.screenshot({path:'.qa/liquid-dark.png'});
  for(const width of [800,390]){
    await page.setViewportSize({width,height:width===390?844:600});await page.waitForTimeout(650);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`No page overflow at ${width}px`);
    await page.screenshot({path:`.qa/liquid-${width}.png`});
  }
  const treePage=await browser.newPage({viewport:{width:1000,height:700}});
  await treePage.goto(url);
  await treePage.locator('#tree .tree-row').first().waitFor();
  const treeOrder=await treePage.evaluate(async()=>{
    state.roots=['Root','Other'];state.expanded=new Set(['Root']);state.rows.clear();
    state.children=new Map([
      ['Root',{count:0,children:[{path:'Root/One',count:0},{path:'Root/Two',count:0}]}],
      ['Root/One',{count:0,children:[]}],['Root/Two',{count:0,children:[]}],
      ['Other',{count:0,children:[]}]
    ]);
    document.querySelector('#tree').replaceChildren();
    await renderTree();
    state.expanded.delete('Root');
    await renderTree();
    return [...document.querySelector('#tree').children].map(row=>row.dataset.path);
  });
  assert.deepStrictEqual(treeOrder,['Root','Root/One','Root/Two','Other'],'Collapsing children must not move surviving rows across departing rows');
  await treePage.close();
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
