const {chromium} = require('../.qa/node_modules/playwright');
const assert = require('assert');

(async () => {
  const url = process.argv[2];
  assert(url, 'Pass the preview URL as the first argument');
  const browser = await chromium.launch({args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:920}});
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(()=>window.havenGlass?.diagnostics.ready);
    await page.evaluate(()=>theme('dark'));
    await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark'&&!document.documentElement.classList.contains('theme-capture'));
    const button = await page.locator('#add-smart-album').boundingBox();
    const pixels = () => page.evaluate(() => {
      const canvas = document.querySelector('#liquid-canvas'),gl=canvas.getContext('webgl2');
      const bounds=document.querySelector('#add-smart-album').getBoundingClientRect();
      const scale=canvas.width/innerWidth,width=Math.ceil(bounds.width*scale),height=Math.ceil(bounds.height*scale);
      const data=new Uint8Array(width*height*4);
      gl.readPixels(Math.floor(bounds.left*scale),Math.floor((innerHeight-bounds.bottom)*scale),width,height,gl.RGBA,gl.UNSIGNED_BYTE,data);
      return [...data];
    });
    await page.mouse.move(350,300);
    await page.waitForTimeout(350);
    const before=await pixels();
    await page.mouse.move(button.x+button.width/2,button.y+button.height/2);
    await page.waitForTimeout(350);
    assert(await page.locator('#glass-cursor').evaluate(element=>getComputedStyle(element).opacity==='0'),'The pointer must merge at the button center');
    await page.screenshot({path:'.qa/smart-album-center-crop.png',clip:{x:button.x-20,y:button.y-20,width:button.width+80,height:button.height+40}});
    await page.mouse.move(button.x+button.width+6,button.y+button.height/2);
    await page.waitForTimeout(400);
    const after=await pixels();
    const pointerPixel=await page.evaluate(({x,y})=>{
      const canvas=document.querySelector('#liquid-canvas'),gl=canvas.getContext('webgl2'),scale=canvas.width/innerWidth;
      const pixel=new Uint8Array(4);
      gl.readPixels(Math.floor(x*scale),Math.floor((innerHeight-y)*scale),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
      return [...pixel];
    },{x:button.x+button.width+6,y:button.y+button.height/2});
    assert(after.some((value,index)=>Math.abs(value-before[index])>8),'The add button must merge toward the pointer');
    assert(await page.locator('#glass-cursor').evaluate(element=>getComputedStyle(element).opacity==='0'),'The pointer must merge into the button on the GPU');
    assert.deepStrictEqual(errors,[]);
    await page.screenshot({path:'.qa/smart-album-hover.png'});
    await page.screenshot({path:'.qa/smart-album-hover-crop.png',clip:{x:button.x-20,y:button.y-20,width:button.width+80,height:button.height+40}});
    const normalButton=await page.locator('#add-folder').boundingBox();
    await page.mouse.move(normalButton.x+normalButton.width+6,normalButton.y+normalButton.height/2);
    await page.waitForTimeout(400);
    assert(await page.locator('#glass-cursor').evaluate(element=>getComputedStyle(element).opacity==='0'),'The regular button must use the same GPU cursor');
    await page.screenshot({path:'.qa/normal-button-hover-crop.png',clip:{x:normalButton.x-20,y:normalButton.y-20,width:normalButton.width+80,height:normalButton.height+40}});
    await page.mouse.move(500,300);
    await page.waitForTimeout(400);
    const boundary=await page.locator('.smart-albums').evaluate(element=>({x:element.getBoundingClientRect().left+55,y:element.getBoundingClientRect().top+20}));
    const boundaryPixel=()=>page.evaluate(({x,y})=>{
      const canvas=document.querySelector('#liquid-canvas'),gl=canvas.getContext('webgl2'),scale=canvas.width/innerWidth;
      const pixel=new Uint8Array(4);
      gl.readPixels(Math.floor(x*scale),Math.floor((innerHeight-y)*scale),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
      return [...pixel];
    },boundary);
    const beforeScroll=await boundaryPixel();
    const listSize=await page.evaluate(()=>{
      const tree=document.querySelector('#tree'),list=document.querySelector('#smart-albums-list');
      for(let index=0;index<40;index++){
        const row=document.createElement('div');row.className='tree-row active';row.textContent=`Folder ${index}`;tree.append(row);
      }
      for(let index=0;index<12;index++){
        const row=document.createElement('div');row.className='smart-album-row';row.textContent=`Album ${index}`;list.append(row);
      }
      tree.scrollTop=tree.scrollHeight;
      list.scrollTop=list.scrollHeight;
      return {height:list.clientHeight,scrollHeight:list.scrollHeight};
    });
    assert(listSize.height<=128&&listSize.scrollHeight>listSize.height,'Many smart albums must scroll beneath the add button');
    await page.waitForTimeout(500);
    const afterScroll=await boundaryPixel();
    assert(afterScroll.every((value,index)=>Math.abs(value-beforeScroll[index])<=8),'Scrolled folder glass must not bleed into smart albums');
    await page.screenshot({path:'.qa/smart-album-many-folders.png'});
    await page.locator('#add-smart-album').click();
    await page.locator('#smart-album-dialog').waitFor({state:'visible'});
    console.log(JSON.stringify({passed:true,glass:'webgl2',cursor:'merged',pointerPixel}));
  } finally {
    await browser.close();
  }
})().catch(error=>{console.error(error);process.exit(1);});
