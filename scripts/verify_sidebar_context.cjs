const {chromium} = require('../.qa/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

(async () => {
  const url = process.argv[2];
  assert(url, 'Pass the preview URL as the first argument');
  const browser = await chromium.launch({args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const created = [];
  try {
    const page = await browser.newPage({viewport:{width:1000,height:700}});
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(()=>window.havenGlass?.diagnostics.ready&&state.roots.length);
    const root = await page.evaluate(()=>state.roots[0]);
    const child = await page.evaluate(async root => (await api('folders',root)).children[0].path,root);
    await page.evaluate(async ({root,child})=>{
      state.expanded.add(root);
      await renderTree();
      state.rows.get(root).dataset.testRoot='';
      state.rows.get(child).dataset.testChild='';
    },{root,child});
    await page.locator('[data-test-root]').click({button:'right'});
    assert(await page.locator('#context-menu').getByText('移除根目录').count()>0);
    await page.mouse.click(500,300);
    await page.locator('[data-test-child]').click({button:'right'});
    assert(await page.locator('#context-menu').getByText('新建子文件夹').count()>0);
    assert.strictEqual(await page.locator('#context-menu').getByText('移除根目录').count(),0);
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#glass-cursor')).opacity==='1');
    await page.screenshot({path:'.qa/sidebar-context-cursor.png'});
    await page.locator('#context-menu').getByText('新建子文件夹').hover();
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#glass-cursor')).opacity==='1');
    await page.screenshot({path:'.qa/sidebar-context-cursor-inside.png'});
    for(const [index,parent] of [child,null].entries()){
      const actualParent=parent||created[0];
      if(index===1){
        await page.evaluate(parent=>state.rows.get(parent).dataset.testGrandchild='',actualParent);
        await page.locator('[data-test-grandchild]').click({button:'right'});
      }
      await page.locator('#context-menu').getByText('新建子文件夹').click();
      await page.locator('#rename-dialog').waitFor({state:'visible'});
      const name=`Haven-context-${process.pid}-${index}`;
      await page.locator('#rename-name').fill(name);
      await page.locator('#rename-dialog button[type="submit"]').click();
      const destination=path.join(actualParent,name);
      created.push(destination);
      await page.waitForFunction(folder=>state.rows.get(folder)?.isConnected,destination);
      assert(fs.statSync(destination).isDirectory());
    }
    assert.deepStrictEqual(errors,[]);
    console.log(JSON.stringify({passed:true,nestedLevels:2,cursor:'visible'}));
  } finally {
    await browser.close();
    for(const folder of created.reverse())if(fs.existsSync(folder))fs.rmdirSync(folder);
  }
})().catch(error=>{console.error(error);process.exit(1);});
