const {chromium} = require('../.qa/node_modules/playwright');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

(async () => {
  const url = process.argv[2];
  assert(url, 'Pass the preview URL as the first argument');
  const browser = await chromium.launch();
  const created = [];
  try {
    const page = await browser.newPage({viewport:{width:1100,height:760}});
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(()=>state.roots.length>0);
    const root = await page.evaluate(()=>state.roots[0]);
    await page.evaluate(root=>api('settings',{current:root}),root);
    await page.reload();
    await page.waitForFunction(root=>state.folder===root && state.job && state.subfolders.length>0,root);
    const initial = await page.evaluate(()=>state.subfolders.length);
    assert(initial>0,'Preview gallery needs one existing child folder');
    assert(await page.locator('#subfolders').isVisible());

    const names = Array.from({length:4},(_,index)=>`Haven-subfolder-${process.pid}-${index}`);
    names[3] += '-very-long-folder-name-for-ellipsis-check';
    for(const name of names){
      await page.evaluate(async ({root,name})=>api('create_folder',root,name),{root,name});
      created.push(path.join(root,name));
    }
    await page.locator('#refresh').click();
    await page.waitForFunction(count=>state.subfolders.length===count,initial+names.length);
    assert.strictEqual(await page.locator('.subfolder-link').count(),3);
    assert.strictEqual(await page.locator('#subfolders-toggle').getAttribute('aria-expanded'),'false');
    await page.locator('#subfolders-toggle').click();
    assert.strictEqual(await page.locator('.subfolder-link').count(),initial+names.length);
    assert.strictEqual(await page.locator('#subfolders-toggle').getAttribute('aria-expanded'),'true');
    const long = page.locator('.subfolder-link').filter({hasText:names[3]});
    assert.strictEqual(await long.getAttribute('title'),names[3]);

    await page.setViewportSize({width:700,height:700});
    const layout = await page.evaluate(() => {
      const strip=document.querySelector('#subfolders').getBoundingClientRect();
      const viewport=document.querySelector('#viewport').getBoundingClientRect();
      return {stripRight:strip.right,viewportTop:viewport.top,stripBottom:strip.bottom,width:innerWidth};
    });
    assert(layout.stripRight<=layout.width && layout.viewportTop>=layout.stripBottom,'Narrow layout must not overlap the grid');
    await page.screenshot({path:'.qa/subfolders-narrow.png'});
    await page.setViewportSize({width:390,height:700});
    const mobile=await page.evaluate(()=>({strip:document.querySelector('#subfolders').getBoundingClientRect().toJSON(),viewport:document.querySelector('#viewport').getBoundingClientRect().toJSON(),width:innerWidth}));
    assert(mobile.strip.right<=mobile.width && mobile.viewport.top>=mobile.strip.bottom && mobile.viewport.height>100,'Small window must keep the photo viewport usable');
    await page.screenshot({path:'.qa/subfolders-mobile.png'});
    await page.setViewportSize({width:700,height:700});

    await page.locator('#search').fill('no-photo-has-this-name');
    await page.waitForFunction(()=>state.total===0);
    assert(await page.locator('#subfolders').isVisible(),'Photo filters must not hide folders');
    await page.locator('#search').fill('');
    await page.setViewportSize({width:390,height:500});
    await page.evaluate(async root=>{state.expanded.delete(root);await renderTree();},root);
    assert(!await page.evaluate(folder=>state.rows.has(folder),created[3]));
    await page.locator('.subfolder-link').filter({hasText:names[3]}).click();
    await page.waitForFunction(folder=>state.folder===folder,created[3]);
    await page.waitForFunction(folder=>state.rows.get(folder)?.classList.contains('active'),created[3]);
    assert(await page.evaluate(root=>state.expanded.has(root),root),'The sidebar must expand to the child folder');
    await page.waitForTimeout(350);
    assert(await page.evaluate(folder=>{
      const tree=document.querySelector('#tree').getBoundingClientRect(),row=state.rows.get(folder).getBoundingClientRect();
      return row.top>=tree.top && row.bottom<=tree.bottom;
    },created[3]),'The active folder must be scrolled into view in the sidebar');
    assert(await page.locator('#subfolders').isHidden(),'Empty child has no folder strip');
    assert(await page.locator('#empty').isVisible(),'Empty child should still show its empty state');
    await page.locator('#up-folder').click();
    await page.waitForFunction(folder=>state.folder===folder,root);
    await page.waitForFunction(count=>state.subfolders.length===count,initial+names.length);
    assert.strictEqual(await page.locator('.subfolder-link').count(),3);
    await page.locator('#tree .tree-row.active').click({button:'right'});
    await page.locator('#context-menu').getByText('新建子文件夹').click();
    const added=`Haven-subfolder-${process.pid}-created-in-menu`;
    await page.locator('#rename-name').fill(added);
    await page.locator('#rename-dialog button[type="submit"]').click();
    created.push(path.join(root,added));
    await page.waitForFunction(count=>state.subfolders.length===count,initial+names.length+1);

    await page.evaluate(async ({root,child})=>{
      const original=api;
      api=async (method,...args)=>{
        if(method==='folders' && args[0]===root)await new Promise(resolve=>setTimeout(resolve,200));
        return original(method,...args);
      };
      try{
        const stale=loadSubfolders(root);
        await openFolder(child);
        await stale;
      }finally{api=original;}
    },{root,child:created[3]});
    assert(await page.locator('#subfolders').isHidden(),'A stale folder response must not replace the current folder');
    assert(await page.locator('#subfolders').isHidden());
    await page.evaluate(root=>openFolder(root),root);
    await page.waitForFunction(folder=>state.folder===folder,root);
    assert.deepStrictEqual(errors,[]);
    console.log(JSON.stringify({passed:true,children:initial+names.length+1,narrow:layout,staleRequest:'ignored'}));
  } finally {
    await browser.close();
    const gallery=path.resolve(__dirname,'../.qa/gallery')+path.sep;
    for(const folder of created.reverse()){
      const target=path.resolve(folder);
      assert(target.startsWith(gallery) && path.basename(target).startsWith('Haven-subfolder-'));
      if(fs.existsSync(target))fs.rmSync(target,{recursive:true});
    }
  }
})().catch(error=>{console.error(error);process.exit(1);});
