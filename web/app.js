'use strict';
const $ = id => document.getElementById(id);
const icons = root => lucide.createIcons({root: root || document, attrs: {'aria-hidden': 'true'}});
const state = {job: null, folder: '', roots: [], expanded: new Set(), children: new Map(), counts: new Map(), rows: new Map(), pages: new Map(), total: 0, kind: 'all', sort: 'name', descending: false, query: '', size: 240, epoch: 0, viewerIndex: 0, current: null, scale: 1, rotation: 0, x: 0, y: 0, desktop: false, update: null};
const number = new Intl.NumberFormat('zh-CN');
const escapeHTML = text => String(text ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const basename = path => path.split(/[\\/]/).filter(Boolean).pop() || path;
const bytes = value => value >= 1024**3 ? (value / 1024**3).toFixed(1) + ' GB' : value >= 1024**2 ? (value / 1024**2).toFixed(1) + ' MB' : Math.max(1, Math.round(value / 1024)) + ' KB';
const date = value => new Date(value * 1000).toLocaleDateString('zh-CN', {year:'numeric',month:'2-digit',day:'2-digit'});
const duration = value => Math.floor((value || 0) / 60) + ':' + String(Math.floor((value || 0) % 60)).padStart(2, '0');
let toastTimer, searchTimer, pollTimer, themeTransition, themeTarget = null, themeSequence = 0, renderScheduled = false;
async function api(method, ...args) {
  if (window.pywebview?.api) return window.pywebview.api[method](...args);
  const response = await fetch('/api/' + method, {method:'POST', headers:{'Content-Type':'application/json','X-Haven-Token':window.HAVEN_TOKEN}, body:JSON.stringify(args)});
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error);
  return payload.result;
}
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5000); }
async function safely(callback) { try { return await callback(); } catch(error) { toast(error.message || String(error)); } }
function mediaURL(item, mode = 'thumb') { const params = new URLSearchParams({token:window.HAVEN_TOKEN,path:item.path,mode}); return '/media?' + params; }
// Native <option> popups cannot be styled, so each select gets a glass listbox that mirrors the real <select>.
const glassSelects = new Map();
function glassSelect(id) {
  const select = $(id);
  if (!select || glassSelects.has(id)) return glassSelects.get(id);
  const shell = select.closest('.select-shell, .sort-controls') || select.parentElement;
  shell.classList.add('select-host');
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'select-button';
  button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
  if (select.getAttribute('aria-label')) button.setAttribute('aria-label', select.getAttribute('aria-label'));
  button.innerHTML = '<span class="select-value"></span><i data-lucide="chevron-down"></i>';
  const menu = document.createElement('div');
  menu.className = 'select-menu glass'; menu.hidden = true; menu.setAttribute('role', 'listbox');
  const component = {
    id, select, shell, button, menu,
    sync() {
      const option = select.options[select.selectedIndex] || select.options[0];
      button.querySelector('.select-value').textContent = option ? option.textContent : '';
      for (const item of menu.children) item.setAttribute('aria-selected', String(item.dataset.value === select.value));
    },
    close() { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); shell.classList.remove('select-open'); },
    open() { closeSelects(); menu.hidden = false; button.setAttribute('aria-expanded', 'true'); shell.classList.add('select-open'); }
  };
  for (const option of select.options) {
    const item = document.createElement('button');
    item.type = 'button'; item.className = 'select-option'; item.setAttribute('role', 'option');
    item.dataset.value = option.value; item.textContent = option.textContent;
    item.onclick = () => { component.close(); if (select.value !== option.value) { select.value = option.value; select.dispatchEvent(new Event('change', {bubbles:true})); } component.sync(); };
    menu.append(item);
  }
  button.onclick = event => { event.stopPropagation(); menu.hidden ? component.open() : component.close(); };
  button.onkeydown = event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (menu.hidden) { component.open(); return; }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = Math.max(0, Math.min(select.options.length - 1, select.selectedIndex + step));
      select.selectedIndex = next; component.sync();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (menu.hidden) component.open();
      else { component.close(); select.dispatchEvent(new Event('change', {bubbles:true})); }
    } else if (event.key === 'Escape' && !menu.hidden) { event.stopPropagation(); component.close(); }
  };
  select.classList.add('select-native'); select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
  shell.insertBefore(button, select.nextSibling);
  shell.append(menu);
  glassSelects.set(id, component);
  icons(shell); component.sync();
  return component;
}
function syncSelect(id) { glassSelects.get(id)?.sync(); }
function closeSelects() { for (const component of glassSelects.values()) component.close(); }
function theme(value) {
  const root = document.documentElement;
  $('theme-select').value = value;
  syncSelect('theme-select');
  if ((themeTarget || root.dataset.theme) !== value) {
    themeTarget = value;
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      themeTransition?.skipTransition();
      const sequence = ++themeSequence;
      themeTransition = document.startViewTransition(() => {
        if (sequence !== themeSequence) return;
        root.classList.add('theme-capture');
        root.dataset.theme = value;
        window.havenGlass?.setThemeInstant?.();
      });
      const complete = () => { if (sequence === themeSequence) { root.classList.remove('theme-capture'); themeTransition = null; themeTarget = null; } };
      themeTransition.finished.then(complete, complete);
    } else {
      root.dataset.theme = value;
      themeTarget = null;
    }
  }
  safely(() => api('settings', {theme:value}));
}
function setGlassTransparency(value) {
  const ratio = Math.max(0, Math.min(1, Number(value) || 0));
  const percent = Math.round(ratio * 100);
  document.documentElement.style.setProperty('--glass-transparency', ratio.toFixed(2));
  document.documentElement.style.setProperty('--glass-alpha-factor', (1 - ratio).toFixed(2));
  const input = $('glass-transparency');
  const output = $('glass-transparency-value');
  if (input) input.value = String(percent);
  if (output) output.textContent = `${percent}%`;
  window.havenGlass?.setTransparency?.(ratio);
}
function ensureTransparencyControl(initial) {
  const dialog = $('settings-dialog');
  if (!dialog || $('glass-transparency')) return;
  const row = document.createElement('div');
  row.className = 'settings-row transparency-row';
  row.innerHTML = '<label for="glass-transparency">\u6db2\u6001\u73bb\u7483\u900f\u660e\u5ea6</label><div class="transparency-control"><input id="glass-transparency" type="range" min="0" max="100" step="1" aria-label="\u6db2\u6001\u73bb\u7483\u900f\u660e\u5ea6"><output id="glass-transparency-value" for="glass-transparency"></output></div>';
  dialog.querySelector('.dialog-heading')?.after(row);
  const input = $('glass-transparency');
  input.oninput = event => setGlassTransparency(Number(event.target.value) / 100);
  input.onchange = () => safely(() => api('settings', {glass_transparency: Number(input.value) / 100}));
  setGlassTransparency(initial);
}
async function addFolder(path) {
  if (!path && !state.desktop) { $('path-dialog').showModal(); $('folder-path').focus(); return; }
  const result = await api('add_folder', path || null);
  if (result.cancelled) return;
  state.roots = [...result.roots];
  // The backend folds folders that already live inside an added folder into that tree.
  if (result.expanded) state.expanded = new Set(result.expanded); else state.expanded.add(result.path);
  await api('settings', {expanded:[...state.expanded]});
  await renderTree(); await openFolder(result.path);
}
async function renderTree() {
  const treeEpoch = (state.treeEpoch || 0) + 1; state.treeEpoch = treeEpoch;
  const tree = $('tree');
  const plan = [];
  async function listing(path) {
    let entry = state.children.get(path);
    if (!entry) { entry = await api('folders', path); state.children.set(path, entry); }
    state.counts.set(path, entry.count);
    for (const child of entry.children) state.counts.set(child.path, child.count);
    return entry;
  }
  async function walk(path, depth) {
    const entry = await listing(path);
    plan.push({path, depth, count: entry.count});
    if (treeEpoch !== state.treeEpoch || !state.expanded.has(path)) return;
    for (const child of entry.children) {
      try { await walk(child.path, depth + 1); }
      catch (error) { plan.push({path: child.path, depth: depth + 1, count: child.count}); }
    }
  }
  for (const root of state.roots) {
    try { await walk(root, 0); }
    catch (error) { plan.push({path: root, depth: 0, count: state.counts.get(root)}); toast(error.message); }
  }
  if (treeEpoch !== state.treeEpoch) return;
  // Reuse the existing rows so switching folders never re-renders or re-animates the whole list.
  const rows = plan.map(item => {
    const row = treeRow(item.path);
    row.classList.toggle('active', item.path === state.folder);
    row.style.paddingLeft = (item.depth * 12) + 'px';
    row.querySelector('.tree-expand').classList.toggle('expanded', state.expanded.has(item.path));
    row.querySelector('.tree-expand').setAttribute('aria-expanded', String(state.expanded.has(item.path)));
    row.querySelector('small').textContent = item.count > 0 ? number.format(item.count) : '';
    return row;
  });
  const animateTree = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const entering = animateTree ? rows.filter(row => row.parentNode !== tree) : [];
  const keep = new Set(plan.map(item => item.path));
  for (const row of [...tree.children]) if (!keep.has(row.dataset.path) && !row.dataset.leaving) {
    state.rows.delete(row.dataset.path);
    if (!animateTree) { row.remove(); continue; }
    const height = row.getBoundingClientRect().height;
    const opacity = Number(getComputedStyle(row).opacity);
    row.getAnimations().forEach(animation => animation.cancel());
    row.dataset.leaving = 'true'; row.style.pointerEvents = 'none'; row.style.overflow = 'hidden';
    row.animate([{height:`${height}px`,margin:'4px 0',opacity,transform:'translateY(0)'},{height:'0px',margin:'0',opacity:0,transform:'translateY(-5px)'}],{duration:220,easing:'ease-in-out',fill:'forwards'}).finished.then(() => row.remove(), () => row.remove());
  }
  // Ignore departing rows when checking order so survivors stay put while children shrink away.
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index], next = rows[index + 1] || null;
    let following = row.nextElementSibling;
    while (following?.dataset.leaving) following = following.nextElementSibling;
    if (row.parentNode !== tree || following !== next) tree.insertBefore(row, next);
  }
  for (const row of entering) {
    row.style.overflow = 'hidden';
    const animation=row.animate([{height:'0px',margin:'0',opacity:0,transform:'translateY(-8px)'},{height:'42px',margin:'4px 0',opacity:1,transform:'translateY(0)'}],{duration:300,easing:'cubic-bezier(.18,.85,.25,1)',fill:'both'});
    animation.finished.then(() => { animation.cancel(); row.style.overflow = ''; }, () => { if (!row.dataset.leaving) row.style.overflow = ''; });
  }
  icons(tree);
}
function treeRow(path) {
  let row = state.rows.get(path);
  if (row) return row;
  row = document.createElement('div'); row.className = 'tree-row'; row.dataset.path = path;
  row.innerHTML = `<button class="tree-expand" aria-label="展开或折叠 ${escapeHTML(basename(path))}"><i data-lucide="chevron-right"></i></button><button class="folder-button" title="${escapeHTML(path)}"><i data-lucide="folder"></i><span class="folder-name">${escapeHTML(basename(path))}</span><small></small></button>`;
  row.querySelector('.folder-button').onclick = () => safely(() => openFolder(path));
  row.querySelector('.tree-expand').onclick = () => safely(() => toggleTree(path));
  row.oncontextmenu = event => {
    event.preventDefault();
    const actions = [['folder-open','在资源管理器中打开',() => api('file_action',path,'open')],['refresh-cw','刷新',async () => {forgetTree(path);await renderTree();await openFolder(path);}],['brush-cleaning','清理缓存',async () => {if(await confirmAction('清理缓存', '删除此目录及子目录的 Haven 缩略图与预览缓存。原始照片不会删除。')) {await api('clean_cache',path,true);await openFolder(state.folder);}}]];
    if (state.roots.includes(path)) actions.push(['folder-minus','移除根目录', async () => {const saved = await api('remove_folder',path);state.roots = saved.roots;forgetTree(path);await renderTree();if(saved.current) await openFolder(saved.current);else resetEmpty();}]);
    contextMenu(event, actions);
  };
  state.rows.set(path, row); icons(row);
  return row;
}
async function toggleTree(path) {
  state.expanded.has(path) ? state.expanded.delete(path) : state.expanded.add(path);
  await api('settings', {expanded:[...state.expanded]});
  await renderTree();
}
function forgetTree(path) {
  for (const key of [...state.children.keys()]) if (key === path || key.startsWith(path + '\\') || key.startsWith(path + '/')) state.children.delete(key);
  for (const key of [...state.counts.keys()]) if (key === path || key.startsWith(path + '\\') || key.startsWith(path + '/')) state.counts.delete(key);
  for (const [key, row] of [...state.rows]) if (key === path || key.startsWith(path + '\\') || key.startsWith(path + '/')) { row.remove(); state.rows.delete(key); }
  state.expanded.delete(path);
}
function markTreeSelection(path) { for (const [key, row] of state.rows) row.classList.toggle('active', key === path); }
function resetEmpty() {
  clearTimeout(pollTimer);state.epoch++;state.job=null;state.folder='';state.pages.clear();state.total=0;
  state.children.clear();state.counts.clear();state.rows.clear();$('tree').replaceChildren();$('viewport').classList.remove('is-loading');
  $('grid').replaceChildren();$('grid').removeAttribute('style');$('empty').hidden=false;$('empty').querySelector('h2').textContent='打开你的照片文件夹';$('empty-add').hidden=false;
  $('folder-title').textContent='Haven';$('folder-summary').textContent='尚未添加文件夹';$('breadcrumbs').textContent='图库';$('status').textContent='0 个项目';$('scan-progress').hidden=true;
}
async function openFolder(path) {
  clearTimeout(pollTimer);state.epoch++;state.folder=path;state.pages.clear();state.total=0;state.job=null;
  // Keep the previous photos on screen (dimmed) until the new folder is ready, instead of blanking the view.
  $('viewport').classList.add('is-loading');$('viewport').scrollTop=0;$('warning').hidden=true;
  if($('grid').children.length){$('empty').hidden=true;}else{$('empty').hidden=false;$('empty').querySelector('h2').textContent='正在扫描文件夹…';$('empty-add').hidden=true;}
  $('folder-title').textContent=basename(path);$('folder-parent').textContent=path;$('folder-summary').textContent='正在读取本地文件';
  const segments = path.split(/[\\/]/).filter(Boolean);$('breadcrumbs').replaceChildren();
  segments.forEach((name,index) => {if(index) {const arrow=document.createElement('i');arrow.dataset.lucide='chevron-right';$('breadcrumbs').append(arrow);}const button=document.createElement('button');button.textContent=name;button.title=name;button.onclick=()=>safely(()=>openFolder(segments.slice(0,index+1).join('\\')));$('breadcrumbs').append(button);}); icons($('breadcrumbs'));
  const epoch=state.epoch; const result=await api('open_folder',path,$('recursive').checked);if(epoch!==state.epoch)return;state.job=result.job;
  $('refresh').classList.add('is-scanning');
  markTreeSelection(path); await poll(epoch);
}
async function fetchPage(offset) {
  const epoch = state.epoch;
  const result = await api('page',state.job,offset,200,state.query,state.kind,state.sort,state.descending);
  if(epoch!==state.epoch)return null;
  state.pages.set(Math.floor(offset/200),result.items);state.total=result.filtered;return result;
}
function itemAt(index) { return state.pages.get(Math.floor(index/200))?.[index%200]; }
async function ensureItem(index) { if(!itemAt(index)) await fetchPage(Math.floor(index/200)*200); return itemAt(index); }
async function poll(epoch) {
  if (epoch !== state.epoch || !state.job) return;
  try {
    const first = await fetchPage(0);if(!first || epoch!==state.epoch)return;
    $('scan-progress').hidden=['ready','error'].includes(first.state);
    $('refresh').classList.toggle('is-scanning',!['ready','error'].includes(first.state));
    $('scan-progress').querySelector('progress').value=first.total ? first.done/first.total*100 : 0;
    $('scan-progress').querySelector('span').textContent=first.done + ' / ' + first.total;
    $('folder-summary').textContent=number.format(first.filtered)+' 个项目' + ($('recursive').checked ? ' · 包含子文件夹' : '');
    $('status').textContent=number.format(first.filtered)+' 个项目' + (state.current ? ' · 已选中 1 项' : '');
    if(first.warnings.length) {$('warning').textContent=first.warnings.join('\n');$('warning').hidden=false;$('cache-status').textContent='部分目录缓存不可写';}
    if(first.state==='error')throw new Error(first.error);
    $('empty').hidden=first.filtered>0;
    if(!first.filtered) {$('empty').querySelector('h2').textContent=first.state==='scanning' ? '正在扫描文件夹…' : '没有匹配的照片或视频';$('empty-add').hidden=true;}
    // Refresh only the pages that are currently drawn after metadata changes.
    const pages = [...state.pages.keys()].filter(page=>page>0);
    for(const page of pages)await fetchPage(page*200);
    await renderGrid();
    $('viewport').classList.remove('is-loading');
    if(first.state!=='ready')pollTimer=setTimeout(()=>poll(epoch),700);
  }catch(error){toast(error.message);$('scan-progress').hidden=true;$('refresh').classList.remove('is-scanning');$('viewport').classList.remove('is-loading');}
}
async function reloadFilter() {
  if(!state.job)return;
  clearTimeout(pollTimer);state.epoch++;state.pages.clear();$('viewport').classList.add('is-loading');$('viewport').scrollTop=0;await poll(state.epoch);
}
const observer = new IntersectionObserver(entries => {for(const entry of entries)if(entry.isIntersecting){const image=entry.target;if(image.dataset.src){image.src=image.dataset.src;delete image.dataset.src;}observer.unobserve(image);}}, {root:$('viewport'),rootMargin:'250px'});
function card(item,index) {
  state.nodes ||= new Map();let node=state.nodes.get(item.path);
  if(!node) {
    node=document.createElement('button');node.className='media-card';node.setAttribute('role','listitem');node.innerHTML='<div class="picture"><i class="placeholder" data-lucide="image"></i><img alt="" hidden><span class="play-icon" hidden><i data-lucide="play"></i></span><span class="badge" hidden></span></div><div class="card-caption"><div class="card-name"></div><div class="card-meta"></div><div class="card-date"></div></div>';
    node.style.setProperty('--entry-delay',Math.min(index % 20,9)*24+'ms');
    state.nodes.set(item.path,node);icons(node);
  }
  node.dataset.index=index;node.title=item.name;node.classList.toggle('selected',state.current?.path===item.path);
  node.onclick=()=>safely(()=>showViewer(Number(node.dataset.index)));
  node.oncontextmenu=event=>{event.preventDefault();contextMenu(event,[['folder-open','在资源管理器中显示',()=>api('file_action',item.path,'reveal')],['external-link','用默认程序打开',()=>api('file_action',item.path,'open')],['copy','复制路径',()=>api('file_action',item.path,'copy')],['trash-2','移到回收站',()=>trashItem(item)]]);};
  node.querySelector('.card-name').textContent=item.name;
  const meta=node.querySelector('.card-meta');meta.textContent=item.error ? '无法解码 · '+bytes(item.size) : (item.width ? `${item.width} × ${item.height}` : '正在读取')+' · '+bytes(item.size);meta.classList.toggle('card-error',!!item.error);meta.title=item.error||'';
  node.querySelector('.card-date').textContent=date(item.date);
  const badge=node.querySelector('.badge');badge.hidden=item.kind==='image'&&!item.live_path&&!item.motion_offset;badge.textContent=item.kind==='video'?duration(item.duration):(item.live_path||item.motion_offset)?'Live':item.kind.toUpperCase();node.querySelector('.play-icon').hidden=item.kind!=='video';
  const image=node.querySelector('img');
  if(!image.getAttribute('src')&&!image.dataset.src&&!item.error) {image.dataset.src=mediaURL(item);image.hidden=false;image.onload=()=>node.querySelector('.placeholder').style.display='none';image.onerror=()=>{image.hidden=true;node.querySelector('.placeholder').style.display='';};observer.observe(image);}
  return node;
}
async function renderGrid() {
  if(!state.job)return;
  const viewport=$('viewport'),grid=$('grid');const width=grid.clientWidth;
  const columns=Math.max(1,Math.floor((width+18)/(state.size+18))),tile=(width-(columns-1)*18)/columns,rowHeight=tile+85;
  const virtual=state.total>200;
  let start=0,end=state.total;
  if(virtual){start=Math.max(0,Math.floor(viewport.scrollTop/rowHeight)-2)*columns;end=Math.min(state.total,(Math.ceil((viewport.scrollTop+viewport.clientHeight)/rowHeight)+3)*columns);}
  const epoch=state.epoch;
  const needed=[];for(let page=Math.floor(start/200);page<=Math.floor(Math.max(0,end-1)/200);page++)if(!state.pages.has(page))needed.push(page);
  for(const page of needed){await fetchPage(page*200);if(epoch!==state.epoch)return;}
  grid.style.height=virtual?Math.ceil(state.total/columns)*rowHeight+'px':'';grid.style.display=virtual?'block':'grid';
  const keep=new Set();
  for(let index=start;index<end;index++){const item=itemAt(index);if(!item)continue;keep.add(item.path);const node=card(item,index);if(virtual){node.style.position='absolute';node.style.width=tile+'px';node.style.left=(index%columns)*(tile+18)+'px';node.style.top=Math.floor(index/columns)*rowHeight+'px';}else {node.style.position='';node.style.width='';node.style.left='';node.style.top='';}if(virtual){if(node.parentNode!==grid)grid.append(node);}else if(grid.children[index]!==node)grid.insertBefore(node,grid.children[index]||null);}
  for(const [path,node] of state.nodes||[]){if(!keep.has(path)){node.remove();state.nodes.delete(path);}}
  // Keep memory bounded to the first page plus pages near the viewport.
  for(const page of state.pages.keys())if(page!==0&&(page<Math.floor(start/200)-1||page>Math.floor(end/200)+1))state.pages.delete(page);
}
function scheduleRender(){if(renderScheduled)return;renderScheduled=true;requestAnimationFrame(()=>{renderScheduled=false;safely(renderGrid);});}
function contextMenu(event,actions){const menu=$('context-menu');menu.replaceChildren();for(const [icon,label,action]of actions){const button=document.createElement('button');button.innerHTML=`<i data-lucide="${icon}"></i><span>${escapeHTML(label)}</span>`;button.onclick=()=>{menu.hidden=true;safely(action);};menu.append(button);}menu.hidden=false;icons(menu);menu.style.left=Math.min(event.clientX,innerWidth-menu.offsetWidth-12)+'px';menu.style.top=Math.min(event.clientY,innerHeight-menu.offsetHeight-12)+'px';}
function confirmAction(title,description){$('confirm-title').textContent=title;$('confirm-description').textContent=description;$('confirm-dialog').showModal();return new Promise(resolve=>{const finish=value=>{$('confirm-dialog').close();resolve(value);};$('confirm-ok').onclick=()=>finish(true);$('confirm-cancel').onclick=()=>finish(false);$('confirm-dialog').oncancel=()=>resolve(false);});}
async function trashItem(item){if(await confirmAction('移到回收站',`确认将「${item.name}」移到回收站？`)){await api('file_action',item.path,'trash',true);closeViewer();await openFolder(state.folder);toast('文件已移到回收站');}}
function transform(){ $('viewer-image').style.transform=`translate(${state.x}px,${state.y}px) rotate(${state.rotation}deg) scale(${state.scale})`;$('zoom-label').textContent=Math.round(state.scale*100)+'%';window.havenGlass?.refresh(); }
function fit(){state.scale=1;state.x=0;state.y=0;transform();}
async function showViewer(index){
  if(index<0||index>=state.total)return;
  const item=await ensureItem(index);if(!item)return;state.viewerIndex=index;state.current=item;state.rotation=0;fit();
  $('viewer-name').textContent=item.name;$('viewer-count').textContent=`${index+1} / ${state.total}`;$('previous').disabled=index===0;$('next').disabled=index===state.total-1;
  const image=$('viewer-image'),video=$('viewer-video');video.pause();video.removeAttribute('src');video.load();image.removeAttribute('src');image.hidden=true;video.hidden=true;$('unsupported').hidden=true;$('viewer-loading').hidden=false;$('live-play').hidden=!(item.live_path||item.motion_offset);
  $('rotate').disabled=item.kind==='video';$('actual').disabled=item.kind==='video';
  if(!$('viewer').open){$('viewer').showModal();$('viewer-stage').focus({preventScroll:true});}
  if(item.kind==='video'){
    $('viewer-loading').hidden=true;
    if(['.mp4','.webm','.m4v','.mov'].includes(item.ext)){video.hidden=false;video.src=mediaURL(item,'original');}else $('unsupported').hidden=false;
  }else{
    image.hidden=false;image.onload=()=>{$('viewer-loading').hidden=true;transform();};image.onerror=()=>{$('viewer-loading').hidden=true;toast('此文件无法生成大图预览，可使用系统默认程序打开');};
    image.src=mediaURL(item,(['raw','heic'].includes(item.kind)||['.tif','.tiff'].includes(item.ext))?'preview':'original');
  }
  video.onerror=()=>{video.hidden=true;$('unsupported').hidden=false;};
  const fields=[['文件名',item.name],['路径',item.path],['分辨率',item.width?`${item.width} × ${item.height}`:'—'],['文件大小',bytes(item.size)],['拍摄时间',date(item.date)],['修改时间',date(item.mtime)],['类型',item.ext.slice(1).toUpperCase()],['相机',item.camera],['镜头',item.lens],['ISO',item.iso],['光圈',item.aperture?`f/${item.aperture}`:null],['快门',item.shutter?`${item.shutter} s`:null],['时长',item.duration?duration(item.duration):null]];
  $('details').innerHTML='<h3>文件详情</h3><dl>'+fields.filter(([,value])=>value).map(([label,value])=>`<dt>${label}</dt><dd>${escapeHTML(value)}</dd>`).join('')+'</dl>';scheduleRender();
}
function closeViewer(){$('viewer-video').pause();$('viewer').close();}
function showUpdate(result){if(!result.available)return;state.update=result.manifest;const data=state.update;$('update-version').textContent=`新版本 ${data.version}`;$('update-notes').textContent=data.notes||'新版本已发布';$('update-size').textContent=bytes(data.size);$('skip-update').hidden=!!data.mandatory;$('later-update').hidden=!!data.mandatory;$('download-progress').hidden=true;$('download-status').textContent='';$('install-update').disabled=false;if(!$('update-dialog').open)$('update-dialog').showModal();}
async function installUpdate(){await api('install_update',true);$('install-update').disabled=true;$('skip-update').disabled=true;$('later-update').disabled=true;$('download-progress').hidden=false;const poll=async()=>{const progress=await api('update_progress');$('download-progress').value=progress.progress||0;$('download-status').textContent=progress.state==='error'?progress.error:progress.state==='restarting'?'正在重启…':`正在下载 ${progress.progress||0}%`;if(progress.state==='downloading')setTimeout(()=>safely(poll),500);else if(progress.state==='error'){$('install-update').disabled=false;$('skip-update').disabled=false;$('later-update').disabled=false;}};await poll();}
async function init(){
  icons();glassSelect('sort');glassSelect('theme-select');const boot=await api('bootstrap');state.roots=boot.state.roots;state.expanded=new Set(boot.state.expanded);state.desktop=boot.desktop;state.size=boot.state.thumb_size||240;document.documentElement.dataset.theme=boot.state.theme;$('theme-select').value=boot.state.theme;syncSelect('theme-select');$('thumb-size').value=state.size;document.documentElement.style.setProperty('--tile',state.size+'px');$('auto-update').checked=boot.state.auto_update;$('recursive').checked=!!boot.state.recursive;$('version').textContent=boot.version;ensureTransparencyControl(Number.isFinite(Number(boot.state.glass_transparency))?Number(boot.state.glass_transparency):.24);
  $('window-controls').hidden=!state.desktop;
  $('resize-grip').hidden=!state.desktop;
  $('window-controls').onclick=event=>{const button=event.target.closest('[data-window-action]');if(button)safely(()=>api('window_action',button.dataset.windowAction));};
  const WINDOW_DRAG_BLOCKED='button,input,select,textarea,a,label,[role="button"],[data-no-drag]';
  if(state.desktop)for(const region of document.querySelectorAll('.pywebview-drag-region')){
    // Keep buttons, inputs and links interactive; everything else in the region drags the frameless window.
    region.addEventListener('mousedown',event=>{if(event.target.closest(WINDOW_DRAG_BLOCKED))event.stopPropagation();});
    region.addEventListener('dblclick',event=>{if(!event.target.closest(WINDOW_DRAG_BLOCKED))safely(()=>api('window_action','maximize'));});
  }
  if(state.desktop){
    let origin=null,pending=null,resizing=false;
    const applyResize=async()=>{if(!pending||resizing)return;resizing=true;const [width,height]=pending;pending=null;try{await api('resize_window',width,height);}catch(error){toast(error.message);}finally{resizing=false;if(pending)applyResize();}};
    $('resize-grip').onpointerdown=event=>{origin={x:event.screenX,y:event.screenY,width:innerWidth,height:innerHeight};$('resize-grip').setPointerCapture(event.pointerId);event.preventDefault();};
    $('resize-grip').onpointermove=event=>{if(!origin)return;pending=[origin.width+event.screenX-origin.x,origin.height+event.screenY-origin.y];applyResize();};
    $('resize-grip').onpointerup=$('resize-grip').onpointercancel=()=>{origin=null;pending=null;};
  }
  $('add-folder').onclick=$('empty-add').onclick=()=>safely(()=>addFolder());
  $('path-form').onsubmit=event=>{event.preventDefault();safely(async()=>{await addFolder($('folder-path').value.trim());$('path-dialog').close();});};
  $('refresh').onclick=()=>{state.children.clear();state.counts.clear();safely(async()=>{await renderTree();if(state.folder)await openFolder(state.folder);});};
  $('up-folder').onclick=()=>safely(async()=>{if(!state.folder)return;const parent=state.folder.replace(/[\\/][^\\/]+[\\/]?$/,'');if(parent&&parent!==state.folder)await openFolder(parent);});
  $('theme-button').onclick=()=>theme((themeTarget||document.documentElement.dataset.theme)==='dark'?'light':'dark');$('theme-select').onchange=event=>theme(event.target.value);
  $('search').oninput=event=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{state.query=event.target.value;safely(reloadFilter);},200);};
  $('filters').onclick=event=>{const button=event.target.closest('[data-kind]');if(!button)return;state.kind=button.dataset.kind;for(const tab of $('filters').children)tab.setAttribute('aria-selected',tab===button);safely(reloadFilter);};
  $('sort').onchange=event=>{state.sort=event.target.value;safely(reloadFilter);};$('sort-direction').onclick=()=>{state.descending=!state.descending;$('sort-direction').style.transform=state.descending?'rotate(180deg)':'';safely(reloadFilter);};
  $('thumb-size').oninput=event=>{state.size=Number(event.target.value);document.documentElement.style.setProperty('--tile',state.size+'px');scheduleRender();};$('thumb-size').onchange=()=>safely(()=>api('settings',{thumb_size:state.size}));
  $('recursive').onchange=()=>{if(state.folder)safely(()=>openFolder(state.folder));};$('viewport').onscroll=scheduleRender;new ResizeObserver(scheduleRender).observe($('viewport'));
  $('viewer-close').onclick=closeViewer;$('viewer').oncancel=event=>{event.preventDefault();closeViewer();};
  $('viewer').addEventListener('close',()=>{const video=$('viewer-video');video.removeAttribute('src');video.load();$('viewer-image').removeAttribute('src');$('details').hidden=true;});
  $('previous').onclick=()=>safely(()=>showViewer(state.viewerIndex-1));$('next').onclick=()=>safely(()=>showViewer(state.viewerIndex+1));$('rotate').onclick=()=>{state.rotation+=90;transform();};$('fit').onclick=fit;
  $('actual').onclick=()=>{const img=$('viewer-image');state.scale=img.naturalWidth/Math.max(1,img.clientWidth);state.x=state.y=0;transform();};
  $('info-button').onclick=()=>{$('details').hidden=!$('details').hidden;};
  $('reveal').onclick=()=>safely(()=>api('file_action',state.current.path,'reveal'));$('copy-path').onclick=()=>safely(async()=>{await api('file_action',state.current.path,'copy');toast('路径已复制');});$('system-open').onclick=()=>safely(()=>api('file_action',state.current.path,'open'));$('trash').onclick=()=>safely(()=>trashItem(state.current));
  $('live-play').onclick=()=>{const video=$('viewer-video');$('viewer-image').hidden=true;video.hidden=false;video.src=state.current.live_path?mediaURL({path:state.current.live_path},'original'):mediaURL(state.current,'motion');video.play().catch(()=>{});};
  $('viewer-stage').onwheel=event=>{
    if($('viewer-image').hidden)return;
    event.preventDefault();
    const image=$('viewer-image'),bounds=image.getBoundingClientRect();
    const next=Math.max(.1,Math.min(20,state.scale*Math.exp(-event.deltaY*.001)));
    const ratio=next/state.scale;
    state.x+=(event.clientX-bounds.left-bounds.width/2)*(1-ratio);
    state.y+=(event.clientY-bounds.top-bounds.height/2)*(1-ratio);
    state.scale=next;transform();
  };
  let drag=null;$('viewer-image').onpointerdown=event=>{drag={x:event.clientX,y:event.clientY,baseX:state.x,baseY:state.y};event.currentTarget.setPointerCapture(event.pointerId);event.currentTarget.classList.add('dragging');};$('viewer-image').onpointermove=event=>{if(!drag)return;state.x=drag.baseX+event.clientX-drag.x;state.y=drag.baseY+event.clientY-drag.y;transform();};$('viewer-image').onpointerup=$('viewer-image').onpointercancel=()=>{drag=null;$('viewer-image').classList.remove('dragging');};
  document.addEventListener('keydown',event=>{
    if(!$('viewer').open||event.target.closest('input,select')||$('confirm-dialog').open)return;
    if(event.key!=='ArrowRight'&&event.key!=='ArrowLeft')return;
    event.preventDefault();
    // Keep focus off the header buttons so arrow keys never paint a focus ring on them.
    const active=document.activeElement;
    if(active&&active!==$('viewer-stage')&&active.closest&&active.closest('#viewer'))$('viewer-stage').focus({preventScroll:true});
    safely(()=>showViewer(state.viewerIndex+(event.key==='ArrowRight'?1:-1)));
  });
  document.addEventListener('click',event=>{if(!event.target.closest('#context-menu'))$('context-menu').hidden=true;closeSelects();});document.addEventListener('keydown',event=>{if(event.key==='Escape'){ $('context-menu').hidden=true;closeSelects(); }});
  $('settings-button').onclick=()=>$('settings-dialog').showModal();document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>$(button.dataset.close).close());
  $('auto-update').onchange=event=>safely(()=>api('settings',{auto_update:event.target.checked}));$('history').onclick=()=>safely(()=>api('release_history'));
  $('check-update').onclick=()=>safely(async()=>{$('check-update').disabled=true;$('update-check-status').textContent='正在检查…';try{const result=await api('check_update',true);$('update-check-status').textContent=result.error||(result.available?'发现新版本':'已是最新版本');if(result.available){$('settings-dialog').close();showUpdate(result);}}finally{$('check-update').disabled=false;}});
  $('later-update').onclick=()=>$('update-dialog').close();$('skip-update').onclick=()=>safely(async()=>{await api('settings',{skipped_version:state.update.version});$('update-dialog').close();});$('install-update').onclick=()=>safely(installUpdate);$('update-dialog').oncancel=event=>{if(state.update?.mandatory||$('install-update').disabled)event.preventDefault();};
  $('sidebar').ondragover=event=>{event.preventDefault();$('sidebar').classList.add('drag-over');};$('sidebar').ondragleave=()=>$('sidebar').classList.remove('drag-over');$('sidebar').ondrop=event=>{event.preventDefault();$('sidebar').classList.remove('drag-over');for(const file of event.dataTransfer.files){const path=file.pywebviewFullPath||file.path;if(path)safely(()=>addFolder(path));}};
  window.addEventListener('haven:folder-added',event=>safely(async()=>{state.roots=event.detail.roots;if(event.detail.expanded)state.expanded=new Set(event.detail.expanded);else state.expanded.add(event.detail.path);await api('settings',{expanded:[...state.expanded]});await renderTree();await openFolder(event.detail.path);}));window.addEventListener('haven:update',event=>showUpdate(event.detail));window.addEventListener('haven:error',event=>toast(event.detail.message));
  await renderTree();if(boot.state.current&&state.roots.length)await openFolder(boot.state.current);
}
document.addEventListener('DOMContentLoaded',()=>safely(init));
