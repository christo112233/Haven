const {chromium} = require('../.qa/node_modules/playwright');
const fs = require('fs');
const assert = require('assert');

(async () => {
  const url=process.argv[2]||process.env.HAVEN_URL||fs.readFileSync('.qa/smooth-server.log','utf8').replace(/^\uFEFF/,'').trim();
  const browser=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:920}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(()=>havenGlass.diagnostics.ready&&state.total>0);
    await page.evaluate(async()=>{
      const source=await ensureItem(0),backend=api;
      window.returnMembers=Array.from({length:180},(_,index)=>({...source,name:`Return-${index}.jpg`}));
      window.api=async(method,...args)=>method==='stack_items'?returnMembers:backend(method,...args);
    });
    for(const viewport of [{width:1440,height:920},{width:390,height:844}]){
      await page.setViewportSize(viewport);
      await page.evaluate(()=>openStackExpand({stack_id:'return',stack_size:returnMembers.length},0));
      await page.waitForTimeout(450);
      await page.evaluate(()=>{const list=document.querySelector('#stack-list');list.scrollTop=(list.scrollHeight-list.clientHeight)*.65;});
      await page.waitForTimeout(350);
      for(const closeWithEscape of [false,true]){
        await page.waitForFunction(()=>{
          const list=document.querySelector('#stack-list'),bounds=list.getBoundingClientRect();
          return [...list.querySelectorAll('.stack-card')].some(card=>{const box=card.getBoundingClientRect();return box.top>=bounds.top+1&&box.bottom<=bounds.bottom-1;});
        },{},{timeout:10000}).catch(async error=>{
          console.log(JSON.stringify(await page.evaluate(()=>({scroll:document.querySelector('#stack-list').scrollTop,height:document.querySelector('#stack-list').clientHeight,bounds:document.querySelector('#stack-list').getBoundingClientRect().toJSON(),layout:state.stackRenderLayout&&{start:state.stackRenderLayout.start,end:state.stackRenderLayout.end,scroll:state.stackRenderLayout.scroll,columns:state.stackRenderLayout.columns},cards:[...document.querySelectorAll('.stack-card')].slice(0,4).map(card=>({top:card.getBoundingClientRect().top,bottom:card.getBoundingClientRect().bottom,name:card.textContent}))}))));
          throw error;
        });
        const selected=await page.evaluate(()=>{
          const list=document.querySelector('#stack-list'),bounds=list.getBoundingClientRect();
          const card=[...list.querySelectorAll('.stack-card')].find(card=>{const box=card.getBoundingClientRect();return box.top>=bounds.top+1&&box.bottom<=bounds.bottom-1;});
          if(!card)throw new Error('No fully visible card at the saved scroll position');
          return {scroll:list.scrollTop,name:card.querySelector('.stack-card-name').textContent,top:parseFloat(card.style.top)};
        });
        assert(selected.scroll>500,'Test must open a photo well below the first rows');
        await page.locator('.stack-card').filter({hasText:selected.name}).click();
        await page.waitForFunction(name=>document.querySelector('#viewer').open&&state.current.name===name,selected.name);
        await page.locator('#stack-dialog').waitFor({state:'hidden'});
        if(closeWithEscape)await page.keyboard.press('Escape');else await page.locator('#viewer-close').click();
        await page.locator('#viewer').waitFor({state:'hidden'});
        await page.waitForTimeout(450);
        const returned=await page.evaluate(name=>{
          const list=document.querySelector('#stack-list');
          const card=[...list.querySelectorAll('.stack-card')].find(card=>card.querySelector('.stack-card-name').textContent===name);
          return {open:document.querySelector('#stack-dialog').open,scroll:list.scrollTop,top:card?parseFloat(card.style.top):null};
        },selected.name);
        assert(returned.open&&Math.abs(returned.scroll-selected.scroll)<2,'Returning from the viewer must preserve stack scroll');
        assert(Math.abs(returned.top-selected.top)<2,`The opened photo must stay at the same grid position: ${JSON.stringify({viewport,closeWithEscape,selected,returned})}`);
      }
      await page.locator('#stack-dialog-close').click();
      await page.locator('#stack-dialog').waitFor({state:'hidden'});
      await page.evaluate(()=>openStackExpand({stack_id:'new-stack',stack_size:returnMembers.length},0));
      assert.equal(await page.locator('#stack-list').evaluate(list=>list.scrollTop),0,'Opening a fresh stack must start at the top');
      await page.evaluate(()=>collectStackDialog());
      await page.locator('#stack-dialog').waitFor({state:'hidden'});
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: stack return preserves scroll and photo position; close button/Escape, repeated visits, desktop/mobile; new stacks start at top');
  }finally{
    await browser.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
