const {chromium}=require('../.qa/node_modules/playwright');
const fs=require('fs');
const assert=require('assert');

(async()=>{
  const url=process.argv[2]||process.env.HAVEN_URL||fs.readFileSync('.qa/smooth-server.log','utf8').replace(/^\uFEFF/,'').trim();
  const browser=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:920}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(()=>havenGlass.diagnostics.ready&&state.total>0);
    await page.evaluate(async()=>{state.stack=false;await reloadFilter();});
    async function dragScrollbar(id){
      const rail=page.locator(`.custom-scrollbar[aria-controls="${id}"]`),thumb=rail.locator('.custom-scrollbar-thumb');
      await rail.waitFor({state:'visible'});
      assert.equal(await page.locator(`#${id}`).evaluate(node=>getComputedStyle(node).scrollbarWidth),'none','Native scrollbar must be hidden');
      assert.equal(await thumb.evaluate(node=>getComputedStyle(node).cursor),'none','Scrollbar thumb must keep the custom cursor');
      const before=await page.locator(`#${id}`).evaluate(node=>node.scrollTop);
      const thumbBox=await thumb.boundingBox(),railBox=await rail.boundingBox();
      const x=thumbBox.x+thumbBox.width/2,y=thumbBox.y+thumbBox.height/2,target=Math.min(railBox.y+railBox.height-5,y+railBox.height/3);
      await rail.evaluate(node=>node.addEventListener('pointerdown',event=>window.scrollTestPointer=event.pointerId,{once:true}));
      await page.mouse.move(x,y);await page.mouse.down();
      assert(await rail.evaluate(node=>node.hasPointerCapture(scrollTestPointer)),'Scrollbar drag must use DOM pointer capture');
      await page.mouse.move(x,target,{steps:8});
      await page.waitForTimeout(200);
      assert(await page.locator(`#${id}`).evaluate(node=>node.scrollTop)>before+100,'Dragging the thumb must scroll the photos');
      assert(await page.locator('#glass-cursor').evaluate(node=>node.classList.contains('is-visible')),'Custom cursor must stay active during scrollbar drag');
      await page.screenshot({path:`.qa/scrollbar-drag-${id}.png`});
      await page.mouse.up();
      assert(!await rail.evaluate(node=>node.classList.contains('is-dragging')),'Releasing the pointer must end dragging');
      await rail.focus();await page.keyboard.press('Home');
      assert.equal(await page.locator(`#${id}`).evaluate(node=>node.scrollTop),0,'Scrollbar Home key must return to the top');
    }
    await dragScrollbar('viewport');
    await page.evaluate(async()=>{
      const source=await ensureItem(0),backend=api;
      const members=Array.from({length:150},(_,index)=>({...source,name:`Scroll-${index}.jpg`}));
      window.api=async(method,...args)=>method==='stack_items'?members:backend(method,...args);
      await openStackExpand({stack_id:'scroll',stack_size:members.length},0);
    });
    await page.waitForTimeout(650);
    await dragScrollbar('stack-list');
    await page.setViewportSize({width:390,height:844});
    await page.waitForTimeout(450);
    await dragScrollbar('stack-list');
    assert.deepEqual(errors,[]);
    console.log('PASS: gallery and stack scrollbar dragging, DOM pointer capture, custom cursor, release and keyboard scrolling; desktop/mobile');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
