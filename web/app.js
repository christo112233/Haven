'use strict';
const $ = id => document.getElementById(id);
const icons = root => lucide.createIcons({root: root || document, attrs: {'aria-hidden': 'true'}});
const state = {job: null, folder: '', lastFolder: '', roots: [], expanded: new Set(), children: new Map(), counts: new Map(), rows: new Map(), pages: new Map(), total: 0, kind: 'all', sort: 'name', descending: false, query: '', size: 240, epoch: 0, viewerIndex: 0, current: null, scale: 1, rotation: 0, x: 0, y: 0, desktop: false, update: null, optimisticMoved: new Set(), silentScan: false, metadataFilters: {}, selection: new Set(), selectionMode: false, lastSelectedIndex: null, smartAlbums: [], smartAlbum: null, subfolders: [], subfoldersExpanded: false, session: null, pickMode: false, exportMode: 'copy', exportFolder: '', externalEditor: null, editors: [], exportJob: null};
const number = new Intl.NumberFormat('zh-CN');
const escapeHTML = text => String(text ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const basename = path => path.split(/[\\/]/).filter(Boolean).pop() || path;
const bytes = value => value >= 1024**3 ? (value / 1024**3).toFixed(1) + ' GB' : value >= 1024**2 ? (value / 1024**2).toFixed(1) + ' MB' : Math.max(1, Math.round(value / 1024)) + ' KB';
const date = value => new Date(value * 1000).toLocaleDateString('zh-CN', {year:'numeric',month:'2-digit',day:'2-digit'});
const duration = value => Math.floor((value || 0) / 60) + ':' + String(Math.floor((value || 0) % 60)).padStart(2, '0');
let toastTimer, searchTimer, folderSearchTimer, folderSearchRequest = 0, pollTimer, themeTransition, themeTarget = null, themeSequence = 0, renderScheduled = false, renderForcePending = false, detailsCloseTimer;
let gridRenderGeneration = 0, renderedGridKey = '', renderingGridKey = '', gridDirty = true, subfolderRequest = 0, subfolderNavigation = 0, subfolderAnimation = null;
let moveQueue = Promise.resolve();
const DRAG_PATH = 'application/x-haven-path', DRAG_PATHS = 'application/x-haven-paths';
function initSidebarResize() {
  const root=document.documentElement,handle=$('sidebar-resize'),storageKey='haven.sidebar-width';
  let preferred=Number(localStorage.getItem(storageKey))||null,drag=null;
  const defaultWidth=()=>innerWidth<=500?104:innerWidth<=700?145:innerWidth<=1100?200:232;
  const bounds=()=>{
    const compact=innerWidth<=500,narrow=innerWidth<=700;
    const padding=compact?8:narrow?10:innerWidth<=1100?14:18;
    const gap=compact?8:narrow?10:innerWidth<=1100?15:20;
    const mainWidth=compact?260:narrow?320:420;
    const minimum=defaultWidth();
    return {minimum,maximum:Math.max(minimum,Math.min(480,innerWidth-padding*2-gap-mainWidth))};
  };
  const apply=()=>{
    const {minimum,maximum}=bounds();
    const width=Math.max(minimum,Math.min(maximum,preferred||minimum));
    root.style.setProperty('--sidebar',`${width}px`);
    root.classList.toggle('sidebar-wide',width>=200);
    handle.setAttribute('aria-valuemin',String(minimum));
    handle.setAttribute('aria-valuemax',String(maximum));
    handle.setAttribute('aria-valuenow',String(width));
  };
  const setWidth=width=>{const {minimum,maximum}=bounds();preferred=Math.max(minimum,Math.min(maximum,Math.round(width)));apply();};
  const save=()=>{if(preferred)localStorage.setItem(storageKey,String(preferred));else localStorage.removeItem(storageKey);};
  handle.onpointerdown=event=>{
    if(event.button!==0)return;
    drag={id:event.pointerId,x:event.clientX,width:Number(handle.getAttribute('aria-valuenow'))};
    handle.setPointerCapture(event.pointerId);handle.classList.add('is-resizing');event.preventDefault();event.stopPropagation();
  };
  handle.onpointermove=event=>{if(drag?.id===event.pointerId)setWidth(drag.width+event.clientX-drag.x);};
  const endDrag=event=>{if(drag?.id!==event.pointerId)return;drag=null;handle.classList.remove('is-resizing');save();};
  handle.onpointerup=handle.onpointercancel=endDrag;
  handle.ondblclick=()=>{preferred=null;apply();save();};
  handle.onkeydown=event=>{
    if(event.key==='Home'){preferred=null;apply();save();}
    else if(event.key==='ArrowLeft'||event.key==='ArrowRight'){
      setWidth(Number(handle.getAttribute('aria-valuenow'))+(event.key==='ArrowRight'?1:-1)*(event.shiftKey?32:16));save();
    }else return;
    event.preventDefault();
  };
  window.addEventListener('resize',apply);
  apply();
}
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
  const select = typeof id === 'string' ? $(id) : id;
  const key = typeof id === 'string' ? id : select?.dataset.glassSelectId;
  if (!select || !key || glassSelects.has(key)) return glassSelects.get(key);
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
    id: key, select, shell, button, menu,
    sync() {
      const option = select.options[select.selectedIndex] || select.options[0];
      button.querySelector('.select-value').textContent = option ? option.textContent : '';
      if (select.hasAttribute('data-color-value')) button.dataset.color = select.value;
      for (const item of menu.children) item.setAttribute('aria-selected', String(item.dataset.value === select.value));
    },
    close() { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); shell.classList.remove('select-open'); if (menu.parentNode === document.body) { shell.append(menu); menu.classList.remove('metadata-select-menu'); menu.removeAttribute('style'); } },
    open() {
      closeSelects(); menu.hidden = false; button.setAttribute('aria-expanded', 'true'); shell.classList.add('select-open');
      if (shell.closest('.metadata-popover.is-constrained')) {
        document.body.append(menu);
        menu.classList.add('metadata-select-menu');
        const bounds = button.getBoundingClientRect();
        menu.style.width = `${Math.max(bounds.width, 154)}px`;
        const height = menu.offsetHeight;
        menu.style.left = `${Math.max(12, Math.min(bounds.left, innerWidth - menu.offsetWidth - 12))}px`;
        menu.style.top = `${bounds.bottom + 8 + height <= innerHeight - 12 ? bounds.bottom + 8 : Math.max(12, bounds.top - height - 8)}px`;
      }
      if (shell.closest('.smart-condition')) {
        const dialog = shell.closest('dialog');
        if (dialog && !menu.dataset.dialogMenu) {
          dialog.append(menu);
          menu.dataset.dialogMenu = 'true';
          menu.classList.add('smart-condition-menu');
        }
        const bounds = button.getBoundingClientRect();
        const container = dialog?.getBoundingClientRect();
        const menuHeight = menu.getBoundingClientRect().height;
        if (select.hasAttribute('data-color-value')) menu.style.width = `${bounds.width}px`;
        const below = bounds.bottom + 8 + menuHeight <= innerHeight - 12;
        const top = below ? bounds.bottom + 8 : Math.max(12, bounds.top - menuHeight - 8);
        menu.style.left = `${Math.max(12, bounds.left - (container?.left || 0))}px`;
        menu.style.top = `${Math.max(12, top - (container?.top || 0))}px`;
      }
    }
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
  glassSelects.set(key, component);
  icons(shell); component.sync();
  return component;
}
function syncSelect(id) { glassSelects.get(id)?.sync(); }
function glassSelectNode(select, key) { select.dataset.glassSelectId = key; return glassSelect(select); }
function refreshSelectOptions(id) { const component = glassSelects.get(id); if (!component) return; component.menu.replaceChildren(); for (const option of component.select.options) { const item=document.createElement('button'); item.type='button'; item.className='select-option'; item.setAttribute('role','option'); item.dataset.value=option.value; item.textContent=option.textContent; item.onclick=()=>{component.close();if(component.select.value!==option.value){component.select.value=option.value;component.select.dispatchEvent(new Event('change',{bubbles:true}));}component.sync();}; component.menu.append(item); } component.sync(); icons(component.menu); }
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
  await renderTree(); refreshFolderSearch(); await openFolder(result.path);
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
function renderFolderSearchResults(result){
  const host=$('folder-search-results'),items=result.items;
  host.replaceChildren();
  const status=document.createElement('div');status.className='folder-search-status';status.setAttribute('role','status');
  status.textContent=result.truncated?`显示前 ${number.format(items.length)} 个结果`:items.length?`${number.format(items.length)} 个文件夹`:'未找到文件夹';
  host.append(status);
  for(const item of items){
    const button=document.createElement('button');button.type='button';button.className='folder-search-result';button.title=item.path;
    const icon=document.createElement('i');icon.dataset.lucide='folder';
    const labels=document.createElement('span'),name=document.createElement('strong'),parent=document.createElement('small');
    name.textContent=item.name;parent.textContent=item.parent.split(/[\\/]/).filter(Boolean).slice(-2).join(' / ');parent.title=item.parent;labels.append(name,parent);button.append(icon,labels);
    button.onclick=()=>{$('folder-search').value='';updateFolderSearch();safely(()=>openSubfolder(item.path,true));};
    host.append(button);
  }
  icons(host);
}
function updateFolderSearch(){
  clearTimeout(folderSearchTimer);
  const query=$('folder-search').value.trim(),host=$('folder-search-results');
  const request=++folderSearchRequest;
  $('tree').hidden=Boolean(query);host.hidden=!query;
  if(!query){host.replaceChildren();return;}
  host.replaceChildren();
  const status=document.createElement('div');status.className='folder-search-status';status.setAttribute('role','status');status.textContent='正在搜索…';host.append(status);
  folderSearchTimer=setTimeout(async()=>{
    try{
      const result=await api('search_folders',query);
      if(request===folderSearchRequest)renderFolderSearchResults(result);
    }catch(error){
      if(request===folderSearchRequest)status.textContent=error.message||String(error);
    }
  },300);
}
function refreshFolderSearch(){if($('folder-search')?.value.trim())updateFolderSearch();}
async function restoreAfterSmartAlbumDelete() { state.smartAlbum = null; const folder = state.lastFolder || state.roots[0]; if (folder) await openFolder(folder); else resetEmpty(); }
function renderSubfolders() {
  const host=$('subfolders'),list=$('subfolders-list'),toggle=$('subfolders-toggle');
  const children=state.subfolders;
  host.hidden=!state.folder||Boolean(state.smartAlbum)||!children.length;
  if(host.hidden){list.replaceChildren();return;}
  $('subfolders-heading').textContent=`子文件夹 · ${number.format(children.length)}`;
  host.classList.toggle('is-expanded',state.subfoldersExpanded);
  const visible=state.subfoldersExpanded?children:children.slice(0,3);
  const existing=new Map([...list.children].map(button=>[button.dataset.path,button]));
  visible.forEach((child,index)=>{
    let button=existing.get(child.path);
    if(!button){
      button=document.createElement('button');button.type='button';button.className='subfolder-link glass';
      const icon=document.createElement('i');icon.dataset.lucide='folder';
      const label=document.createElement('span');button.append(icon,label);
    }
    button.dataset.path=child.path;button.title=child.name;button.setAttribute('aria-label',`打开子文件夹 ${child.name}`);
    button.querySelector('span').textContent=child.name;
    button.onclick=()=>safely(()=>openSubfolder(child.path));
    if(list.children[index]!==button)list.insertBefore(button,list.children[index]||null);
  });
  while(list.children.length>visible.length)list.lastElementChild.remove();
  toggle.hidden=children.length<=3;
  toggle.setAttribute('aria-expanded',String(state.subfoldersExpanded));
  toggle.querySelector('span').textContent=state.subfoldersExpanded?'收起':`还有 ${number.format(children.length-3)} 个`;
  icons(list);
}
function toggleSubfolders(){
  const list=$('subfolders-list');
  const start=list.getBoundingClientRect().height;
  subfolderAnimation?.cancel();subfolderAnimation=null;
  list.style.overflow='';
  state.subfoldersExpanded=!state.subfoldersExpanded;
  renderSubfolders();
  list.scrollTop=0;
  const end=list.getBoundingClientRect().height;
  if(start===end||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  list.style.overflow='hidden';
  const animation=list.animate([{height:`${start}px`,opacity:.7},{height:`${end}px`,opacity:1}],{duration:300,easing:'cubic-bezier(.18,.85,.25,1)'});
  subfolderAnimation=animation;
  const finish=()=>{if(subfolderAnimation===animation){list.style.overflow='';subfolderAnimation=null;}};
  animation.onfinish=finish;animation.oncancel=finish;
}
function clearSubfolders(){subfolderAnimation?.cancel();subfolderAnimation=null;$('subfolders-list').style.overflow='';subfolderRequest++;state.subfolders=[];state.subfoldersExpanded=false;renderSubfolders();}
async function loadSubfolders(path,epoch=state.epoch){
  const request=++subfolderRequest;
  try{
    const entry=await api('folders',path);
    if(request!==subfolderRequest||epoch!==state.epoch||!samePath(path,state.folder)||state.smartAlbum)return;
    state.children.set(path,entry);
    state.subfolders=entry.children;
    renderSubfolders();
  }catch(error){if(request===subfolderRequest&&epoch===state.epoch)toast(error.message||String(error));}
}
async function renderSmartAlbums() {
  state.smartAlbums = await api('list_smart_albums');
  const host = $('smart-albums-list');
  host.replaceChildren();
  for (const album of state.smartAlbums) {
    const row = document.createElement('div');
    row.className = 'smart-album-row'; row.dataset.id = album.id;
    row.innerHTML = '<i data-lucide="sparkles"></i><span></span><small></small><span class="album-actions"><button class="icon-button album-edit" title="编辑" aria-label="编辑"><i data-lucide="pencil"></i></button><button class="icon-button album-delete" title="删除" aria-label="删除"><i data-lucide="trash-2"></i></button></span>';
    row.querySelector('span').textContent = album.name;
    row.onclick = () => safely(async () => { subfolderNavigation++; state.smartAlbum = album.id; state.folder = ''; state.epoch++; clearSubfolders(); document.querySelectorAll('.smart-album-row').forEach(node => node.classList.toggle('active', node === row)); const result = await api('open_smart_album', album.id); state.job = result.job; state.pages.clear(); state.total = 0; $('folder-title').textContent = album.name; $('folder-parent').textContent = '智能相册'; $('folder-summary').textContent = '正在读取'; $('viewport').classList.add('is-loading'); await poll(state.epoch); });
    row.querySelector('.album-edit').onclick = event => { event.stopPropagation(); editSmartAlbum(album); };
    row.querySelector('.album-delete').onclick = event => { event.stopPropagation(); safely(async () => { await api('delete_smart_album', album.id); if (state.smartAlbum === album.id) await restoreAfterSmartAlbumDelete(); await renderSmartAlbums(); }); };
    row.oncontextmenu = event => { event.preventDefault(); contextMenu(event, [['trash-2', '删除智能相册', async () => { await api('delete_smart_album', album.id); if (state.smartAlbum === album.id) await restoreAfterSmartAlbumDelete(); await renderSmartAlbums(); }]]); };
    host.append(row);
  }
  icons(host);
}
function treeRow(path) {
  let row = state.rows.get(path);
  if (row) return row;
  row = document.createElement('div'); row.className = 'tree-row'; row.dataset.path = path;
  row.innerHTML = `<button class="tree-expand" aria-label="展开或折叠 ${escapeHTML(basename(path))}"><i data-lucide="chevron-right"></i></button><button class="folder-button" title="${escapeHTML(path)}"><i data-lucide="folder"></i><span class="folder-name">${escapeHTML(basename(path))}</span><small></small></button>`;
  row.querySelector('.folder-button').onclick = () => safely(() => openFolder(path));
  row.querySelector('.tree-expand').onclick = () => safely(() => toggleTree(path));
  row.ondragover = event => {
    if (!event.dataTransfer?.types.includes(DRAG_PATH) && !event.dataTransfer?.types.includes(DRAG_PATHS)) return;
    event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='move';row.classList.add('drop-target');
  };
  row.ondragleave = event => { if (!event.relatedTarget || !row.contains(event.relatedTarget)) row.classList.remove('drop-target'); };
  row.ondrop = event => {
    if (!event.dataTransfer?.types.includes(DRAG_PATH) && !event.dataTransfer?.types.includes(DRAG_PATHS)) return;
    event.preventDefault();event.stopPropagation();row.classList.remove('drop-target');
    let sources=[];
    try { sources=JSON.parse(event.dataTransfer.getData(DRAG_PATHS)); } catch (_) {}
    if(!Array.isArray(sources))sources=[];
    sources=[...new Set(sources.filter(source=>typeof source==='string'&&source))];
    if(!sources.length){const source=event.dataTransfer.getData(DRAG_PATH);if(source)sources=[source];}
    if(sources.length)safely(()=>queuePhotoMoves(sources,path));
  };
  row.oncontextmenu = event => {
    event.preventDefault();
    const actions = [['folder-open','在资源管理器中打开',() => api('file_action',path,'open')],['refresh-cw','刷新',async () => {forgetTree(path);await renderTree();refreshFolderSearch();await openFolder(path);}],['brush-cleaning','清理缓存',async () => {if(await confirmAction('清理缓存', '删除此目录及子目录的 Haven 缩略图与预览缓存。原始照片不会删除。')) {await api('clean_cache',path,true);await openFolder(state.folder);}}]];
    actions.unshift(['pencil','重命名',() => renamePath(path,basename(path),true)]);
    actions.push(['folder-plus','新建子文件夹',() => createChildFolder(path)]);
    if (state.roots.includes(path)) {
      actions.push(['folder-minus','移除根目录', async () => {const saved = await api('remove_folder',path);state.roots = saved.roots;forgetTree(path);await renderTree();if(saved.current) await openFolder(saved.current);else resetEmpty();refreshFolderSearch();}]);
    }
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
function samePath(left,right){return String(left||'').replace(/[\\/]+$/,'').toLowerCase()===String(right||'').replace(/[\\/]+$/,'').toLowerCase();}
function parentPath(path){return String(path).replace(/[\\/][^\\/]+[\\/]?$/,'')||String(path);}
function updateVisibleSummary(){
  const text=number.format(state.total)+' 个项目'+($('recursive').checked?' · 包含子文件夹':'');
  $('folder-summary').textContent=text;$('status').textContent=number.format(state.total)+' 个项目';
}
function queuePhotoMove(source,target,quiet=false){
  const task=moveQueue.then(()=>movePhotoToFolder(source,target,quiet),()=>movePhotoToFolder(source,target,quiet));
  moveQueue=task.catch(()=>{});
  return task;
}
async function queuePhotoMoves(sources,target){
  const results=await Promise.allSettled(sources.map(source=>queuePhotoMove(source,target,true)));
  let moved=0,firstError=null;
  results.forEach((result,index)=>{
    if(result.status==='rejected'){firstError ||= result.reason;return;}
    if(samePath(result.value.path,sources[index]))return;
    moved++;state.selection.delete(sources[index]);
  });
  if(!state.selection.size)state.lastSelectedIndex=null;
  updateBulkToolbar();scheduleRender();
  const failed=results.filter(result=>result.status==='rejected').length;
  if(failed)toast(`已移动 ${moved} 项，${failed} 项失败：${firstError?.message||firstError}`);
  else toast(moved?`已移动 ${moved} 项到「${basename(target)}」`:'照片已在目标文件夹');
  return {moved,failed};
}
async function movePhotoToFolder(source,target,quiet=false){
  try{
  const result=await api('move_file',source,target);
  const sourceFolder=result.old_parent||parentPath(source),targetFolder=result.parent||target;
  if(!samePath(result.path,source)&&state.folder&&samePath(state.folder,sourceFolder)){
    state.optimisticMoved.add(source);
    if(state.selection.has(source)||[...state.pages.values()].some(items=>items.some(item=>samePath(item.path,source))))state.total=Math.max(0,state.total-1);
    updateVisibleSummary();scheduleRender();
  }
  if(!quiet)toast(`已移动到「${basename(target)}」`);
  return result;
  }catch(error){
    throw error;
  }
}
async function createChildFolder(parent){
  const name=await requestRename('',true,'新建子文件夹');
  if(name===null)return;
  await api('create_folder',parent,name);
  state.expanded.add(parent);await api('settings',{expanded:[...state.expanded]});
  state.children.clear();state.counts.clear();await renderTree();refreshFolderSearch();if(samePath(parent,state.folder))await loadSubfolders(parent);toast('子文件夹已创建');
}
function forgetTree(path) {
  for (const key of [...state.children.keys()]) if (key === path || key.startsWith(path + '\\') || key.startsWith(path + '/')) state.children.delete(key);
  for (const key of [...state.counts.keys()]) if (key === path || key.startsWith(path + '\\') || key.startsWith(path + '/')) state.counts.delete(key);
  for (const [key, row] of [...state.rows]) if (key === path || key.startsWith(path + '\\') || key.startsWith(path + '/')) { row.remove(); state.rows.delete(key); }
  state.expanded.delete(path);
}
function markTreeSelection(path) { for (const [key, row] of state.rows) row.classList.toggle('active', key === path); }
function resetEmpty() {
  clearTimeout(pollTimer);subfolderNavigation++;state.epoch++;state.job=null;state.folder='';state.pages.clear();state.total=0;state.optimisticMoved.clear();state.silentScan=false;state.smartAlbum=null;state.selection.clear();updateBulkToolbar();
  clearSubfolders();
  state.children.clear();state.counts.clear();state.rows.clear();$('tree').replaceChildren();$('viewport').classList.remove('is-loading');
  $('grid').replaceChildren();$('grid').removeAttribute('style');$('empty').hidden=false;$('empty').querySelector('h2').textContent='打开你的照片文件夹';$('empty-add').hidden=false;
  $('folder-title').textContent='Haven';$('folder-summary').textContent='尚未添加文件夹';$('breadcrumbs').textContent='图库';$('status').textContent='0 个项目';$('scan-progress').hidden=true;
}
async function openSubfolder(path,refreshTree=false){
  const navigation=++subfolderNavigation;
  const root=state.roots.find(candidate=>normalizeClientPath(path).startsWith(normalizeClientPath(candidate).replace(/\/+$/,'')+'/'));
  if(root){
    for(let folder=parentPath(path);;folder=parentPath(folder)){
      if(refreshTree)state.children.delete(folder);
      state.expanded.add(folder);
      if(samePath(folder,root))break;
    }
    await api('settings',{expanded:[...state.expanded]});
    if(navigation!==subfolderNavigation)return;
    await renderTree();
    if(navigation!==subfolderNavigation)return;
    state.rows.get(path)?.scrollIntoView({block:'nearest'});
  }
  if(navigation===subfolderNavigation)await openFolder(path);
}
async function openFolder(path,silent=false) {
  clearTimeout(pollTimer);subfolderNavigation++;state.epoch++;state.folder=path;state.lastFolder=path;state.smartAlbum=null;state.selection.clear();updateBulkToolbar();state.job=null;state.silentScan=silent;
  clearSubfolders();void loadSubfolders(path);
  if(!silent){state.pages.clear();state.total=0;state.optimisticMoved.clear();}
  // Keep the previous photos on screen (dimmed) until the new folder is ready, instead of blanking the view.
  if(!silent){
  $('viewport').classList.add('is-loading');$('viewport').scrollTop=0;$('warning').hidden=true;
  if($('grid').children.length){$('empty').hidden=true;}else{$('empty').hidden=false;$('empty').querySelector('h2').textContent='正在扫描文件夹…';$('empty-add').hidden=true;}
  $('folder-title').textContent=basename(path);$('folder-parent').textContent=path;$('folder-summary').textContent='正在读取本地文件';
  const segments = path.split(/[\\/]/).filter(Boolean);$('breadcrumbs').replaceChildren();
  segments.forEach((name,index) => {if(index) {const arrow=document.createElement('i');arrow.dataset.lucide='chevron-right';$('breadcrumbs').append(arrow);}const button=document.createElement('button');button.textContent=name;button.title=name;button.onclick=()=>safely(()=>openFolder(segments.slice(0,index+1).join('\\')));$('breadcrumbs').append(button);}); icons($('breadcrumbs'));
  }
  const epoch=state.epoch; const result=await api('open_folder',path,$('recursive').checked);if(epoch!==state.epoch)return;state.job=result.job;
  if(!silent)$('refresh').classList.add('is-scanning');
  markTreeSelection(path); await poll(epoch);
}
async function fetchPage(offset) {
  const epoch = state.epoch;
  const result = await api('page',state.job,offset,200,state.query,state.kind,state.sort,state.descending,state.metadataFilters);
  if(epoch!==state.epoch)return null;
  state.pages.set(Math.floor(offset/200),result.items);state.total=result.filtered;return result;
}
function itemAt(index) { const item=state.pages.get(Math.floor(index/200))?.[index%200];return item&&!state.optimisticMoved.has(item.path)?item:null; }
async function ensureItem(index) { if(!itemAt(index)) await fetchPage(Math.floor(index/200)*200); return itemAt(index); }
async function poll(epoch) {
  if (epoch !== state.epoch || !state.job) return;
  try {
    const first = await fetchPage(0);if(!first || epoch!==state.epoch)return;
    const silent=state.silentScan&&epoch===state.epoch;
    $('scan-progress').hidden=silent||['ready','error'].includes(first.state);
    $('refresh').classList.toggle('is-scanning',!silent&&!['ready','error'].includes(first.state));
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
    if(first.state==='ready'){if(state.optimisticMoved.size)state.optimisticMoved.clear();state.silentScan=false;}
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
    node=document.createElement('button');node.className='media-card';node.setAttribute('role','listitem');node.innerHTML='<div class="picture"><div class="card-markers"></div><i class="placeholder" data-lucide="image"></i><img alt="" hidden><span class="play-icon" hidden><i data-lucide="play"></i></span><span class="badge" hidden></span><span class="round-pick" hidden><i data-lucide="check"></i></span></div><div class="card-caption"><div class="card-name"></div><div class="card-meta"></div><div class="card-date"></div></div>';
    node.draggable=true;
    node.style.setProperty('--entry-delay',Math.min(index % 20,9)*24+'ms');
    state.nodes.set(item.path,node);icons(node);
  }
  node.dataset.index=index;node.title=item.name;node.classList.toggle('selected',state.selection.has(item.path)||(state.current?.path===item.path&&$('viewer')?.open));
  const roundPick=node.querySelector('.round-pick');if(roundPick)roundPick.hidden=!state.session||!isPicked(item.path);
  node.ondragstart=event=>{const paths=state.selection.has(item.path)?[...state.selection]:[item.path];event.dataTransfer.setData(DRAG_PATH,item.path);event.dataTransfer.setData(DRAG_PATHS,JSON.stringify(paths));event.dataTransfer.effectAllowed='move';node.classList.add('dragging');if(paths.length>1)node.dataset.dragCount=`${paths.length} 项`;};
  node.ondragend=()=>{node.classList.remove('dragging');delete node.dataset.dragCount;};
  node.onclick=event=>{if(state.selectionMode||event.ctrlKey||event.metaKey||event.shiftKey){event.preventDefault();toggleCardSelection(item,index,event);return;}if(state.session&&state.pickMode){event.preventDefault();safely(()=>toggleRoundPick(item.path));return;}safely(()=>showViewer(Number(node.dataset.index)));};
  node.oncontextmenu=event=>{event.preventDefault();contextMenu(event,[['pencil','重命名',()=>renamePath(item.path,item.name,false)],['folder-open','在资源管理器中显示',()=>api('file_action',item.path,'reveal')],['external-link','用默认程序打开',()=>api('file_action',item.path,'open')],['copy','复制路径',()=>api('file_action',item.path,'copy')],['trash-2','移到回收站',()=>trashItem(item)]]);};
  node.oncontextmenu=event=>{event.preventDefault();contextMenu(event,[['star','设置评分',()=>promptRating([item.path])],['heart','收藏',()=>applyMetadata([item.path],{favorite:true})],['flag','旗帜',()=>applyMetadata([item.path],{flagged:true})],['tag','添加标签',()=>promptTags([item.path])],['pencil','重命名',()=>renamePath(item.path,item.name,false)],['folder-open','在资源管理器中显示',()=>api('file_action',item.path,'reveal')],['trash-2','移到回收站',()=>trashItem(item)]]);};
  node.oncontextmenu=event=>{event.preventDefault();contextMenu(event,[['star','设置评分',()=>promptRating([item.path])],['heart',item.favorite?'取消收藏':'收藏',()=>toggleMetadata([item.path],'favorite')],['flag',item.flagged?'取消旗帜':'旗帜',()=>toggleMetadata([item.path],'flagged')],['circle-x',item.rejected?'取消 Rejected':'标记 Rejected',()=>toggleMetadata([item.path],'rejected')],['tag','添加标签',()=>promptTags([item.path])],['pencil','重命名',()=>renamePath(item.path,item.name,false)],['folder-open','在资源管理器中显示',()=>api('file_action',item.path,'reveal')],['trash-2','移到回收站',()=>trashItem(item)]]);};
  node.oncontextmenu=event=>{event.preventDefault();contextMenu(event,[['star','设置评分',()=>promptRating([item.path])],['heart',item.favorite?'取消收藏':'收藏',()=>toggleMetadata([item.path],'favorite')],['flag',item.flagged?'取消旗帜':'旗帜',()=>toggleMetadata([item.path],'flagged')],['circle-x',item.rejected?'取消 Rejected':'标记 Rejected',()=>toggleMetadata([item.path],'rejected')],['tag','管理标签',()=>promptTags([item.path])],['palette','颜色标签',()=>promptColor([item.path])],['pencil','重命名',()=>renamePath(item.path,item.name,false)],['folder-open','在资源管理器中显示',()=>api('file_action',item.path,'reveal')],['check-check',isPicked(item.path)?'移出本轮':'选入本轮',()=>{if(!state.session)openSessionDialog('start');else safely(()=>toggleRoundPick(item.path));}],['external-link','在外部编辑器中打开',()=>openExportDialog([item.path],'open')],['folder-output','导出到文件夹…',()=>openExportDialog([item.path],'export')],['trash-2','移到回收站',()=>trashItem(item)]]);};
  node.querySelector('.card-name').textContent=item.name;
  const meta=node.querySelector('.card-meta');meta.textContent=item.error ? '无法解码 · '+bytes(item.size) : (item.width ? `${item.width} × ${item.height}` : '正在读取')+' · '+bytes(item.size);meta.classList.toggle('card-error',!!item.error);meta.title=item.error||'';
  if(item.rating)meta.textContent += ` · ${'★'.repeat(item.rating)}`;
  node.querySelector('.card-date').textContent=date(item.date);
  const markers=node.querySelector('.card-markers');if(markers){markers.replaceChildren();for(const [key,icon,label] of [['favorite','heart','收藏'],['flagged','flag','旗帜'],['rejected','circle-x','Rejected']])if(item[key]){const mark=document.createElement('span');mark.className='card-marker '+key;mark.title=label;mark.innerHTML=`<i data-lucide="${icon}"></i>`;markers.append(mark);}if(item.tags?.length){const mark=document.createElement('span');mark.className='card-marker tagged';mark.title=`标签：${item.tags.join(', ')}`;mark.innerHTML='<i data-lucide="tag"></i>';markers.append(mark);}if(item.color_label){const dot=document.createElement('span');dot.className='color-dot';dot.title=`颜色标签：${item.color_label}`;dot.style.color=item.color_label;markers.append(dot);}icons(markers);}
  const badge=node.querySelector('.badge');badge.hidden=item.kind==='image'&&!item.live_path&&!item.motion_offset;badge.textContent=item.kind==='video'?duration(item.duration):(item.live_path||item.motion_offset)?'Live':item.kind.toUpperCase();node.querySelector('.play-icon').hidden=item.kind!=='video';
  const image=node.querySelector('img');
  if(!image.getAttribute('src')&&!image.dataset.src&&!item.error) {image.dataset.src=mediaURL(item);image.hidden=false;image.onload=()=>node.querySelector('.placeholder').style.display='none';image.onerror=()=>{image.hidden=true;node.querySelector('.placeholder').style.display='';};observer.observe(image);}
  return node;
}
function toggleCardSelection(item,index,event){
  if(event.shiftKey&&state.lastSelectedIndex!==null){const start=Math.min(state.lastSelectedIndex,index),end=Math.max(state.lastSelectedIndex,index);for(let i=start;i<=end;i++){const selected=itemAt(i);if(selected)state.selection.add(selected.path);}}
  else if(state.selection.has(item.path))state.selection.delete(item.path);else state.selection.add(item.path);
  state.lastSelectedIndex=index;updateBulkToolbar();scheduleRender();
}
function updateBulkToolbar(){const bar=$('bulk-toolbar');if(!bar)return;bar.hidden=!state.selection.size;$('selection-count').textContent=`已选择 ${state.selection.size} 项`;const button=$('selection-mode');if(button){button.classList.toggle('is-active',state.selectionMode);button.setAttribute('aria-pressed',String(state.selectionMode));button.title=state.selectionMode?'退出选择模式':'选择照片';}const status=$('selection-mode-status');if(status)status.hidden=!state.selectionMode;}
function toggleSelectionMode(){state.selectionMode=!state.selectionMode;if(!state.selectionMode){state.selection.clear();state.lastSelectedIndex=null;}updateBulkToolbar();scheduleRender();}
async function applyMetadata(paths,patch){const result=await api('update_photo_metadata',paths,patch);for(const items of state.pages.values()){for(const item of items){const key=Object.keys(result.metadata).find(candidate=>normalizeClientPath(candidate)===normalizeClientPath(item.path));const value=key&&result.metadata[key];if(value)Object.assign(item,value);}}if(state.current){const currentKey=Object.keys(result.metadata).find(candidate=>normalizeClientPath(candidate)===normalizeClientPath(state.current.path));if(currentKey)Object.assign(state.current,result.metadata[currentKey]);syncViewerMetadata();}const knownTags=await api('list_tags');$('tag-suggestions').replaceChildren(...knownTags.map(tag=>{const option=document.createElement('option');option.value=tag.name;return option;}));toast(`已更新 ${result.count} 项`);updateBulkToolbar();if(state.smartAlbum){const albumJob=await api('open_smart_album',state.smartAlbum);state.epoch++;state.job=albumJob.job;state.pages.clear();state.total=0;await poll(state.epoch);}else if(Object.keys(state.metadataFilters).length)await reloadFilter();else scheduleRender();}
function normalizeClientPath(path){return String(path||'').replace(/[\\/]+/g,'/').toLowerCase();}
function itemsForPaths(paths){const wanted=new Set(paths.map(normalizeClientPath)),items=[];for(const page of state.pages.values())for(const item of page)if(wanted.has(normalizeClientPath(item.path)))items.push(item);return items;}
async function toggleMetadata(paths,key){const items=itemsForPaths(paths),value=items.length>0&&items.every(item=>Boolean(item[key]));await applyMetadata(paths,{[key]:!value});}
function syncViewerMetadata(){const item=state.current;if(!item)return;for(const key of ['favorite','flagged','rejected']){const button=$(`viewer-${key}`);if(!button)continue;button.classList.toggle('is-active',Boolean(item[key]));button.setAttribute('aria-pressed',String(Boolean(item[key])));button.title=item[key]?`取消${key==='favorite'?'收藏':key==='flagged'?'旗帜':'Rejected'}`:key==='favorite'?'收藏':key==='flagged'?'旗帜':'标记 Rejected';}const tagButton=$('viewer-tag');if(tagButton){tagButton.classList.toggle('is-active',Boolean(item.tags?.length));tagButton.title=item.tags?.length?'管理标签':'添加标签';}const colorButton=$('viewer-color');if(colorButton){colorButton.classList.toggle('is-active',Boolean(item.color_label));colorButton.style.color=item.color_label||'';colorButton.title=item.color_label?`颜色标签：${item.color_label}`:'设置颜色标签';}const rating=$('viewer-rating-value');if(rating){rating.textContent=item.rating?`★ ${item.rating}/5`:'未评分';rating.setAttribute('aria-label',item.rating?`当前评分 ${item.rating} 星`:'当前未评分');}renderViewerDetails(item);}
function renderViewerDetails(item){
  if(!item)return;
  const fields=[['文件名',item.name],['路径',item.path],['分辨率',item.width?`${item.width} × ${item.height}`:'—'],['文件大小',bytes(item.size)],['拍摄时间',date(item.date)],['修改时间',date(item.mtime)],['类型',item.ext.slice(1).toUpperCase()],['相机',item.camera],['镜头',item.lens],['ISO',item.iso],['光圈',item.aperture?`f/${item.aperture}`:null],['快门',item.shutter?`${item.shutter} s`:null],['时长',item.duration?duration(item.duration):null]];
  fields.push(['标签',item.tags?.join(', ')||'未设置'],['评分',item.rating?`${item.rating} 星`:'未评分'],['状态',item.rejected?'Rejected':item.flagged?'旗帜':item.favorite?'收藏':'普通']);
  $('details').innerHTML='<h3>文件详情</h3><dl>'+fields.filter(([,value])=>value).map(([label,value])=>`<dt>${label}</dt><dd>${escapeHTML(value)}</dd>`).join('')+'</dl>';
}
function promptColor(paths){
  const dialog=$('color-dialog'), choices=[...document.querySelectorAll('#color-choices [data-color]')], current=itemsForPaths(paths);
  const shared=current.length&&current.every(item=>item.color_label===current[0].color_label)?current[0].color_label:null;
  choices.forEach(button=>button.classList.toggle('is-active',button.dataset.color===shared));
  dialog.showModal();
  return new Promise(resolve=>{let done=false;const finish=async value=>{if(done)return;done=true;dialog.close();if(value!==undefined)await applyMetadata(paths,{color_label:value});resolve();};choices.forEach(button=>button.onclick=()=>finish(button.dataset.color));$('color-clear').onclick=()=>finish(null);$('color-cancel').onclick=()=>finish();$('color-dialog-close').onclick=()=>finish();dialog.oncancel=event=>{event.preventDefault();finish();};});
}
function selectedPaths(){return [...state.selection];}
function isPicked(path){return Boolean(state.session)&&(state.session.picks||[]).some(p=>samePath(p,path));}
function sessionTarget(){const s=state.session;if(!s)return '';const loc=(s.location||'').replace(/[\\/]+$/,'');const name=(s.name||'').trim();return loc&&name?loc+'\\'+name:loc||name;}
function defaultSessionName(){const d=new Date();return `选片 ${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function previewSessionPath(){$('session-preview').textContent=sessionTargetFromInputs();}
function sessionTargetFromInputs(){const loc=($('session-location').value||'').replace(/[\\/]+$/,'');const name=($('session-name').value||'').trim();return loc&&name?loc+'\\'+name:loc||name;}
let sessionDialogMode='start';let pendingExportPaths=[];let pendingExportAction='export';let pendingExportEndsSession=false;
async function persistSession(){await api('settings',{session:state.session});}
function syncSessionUI(){
  const active=Boolean(state.session),banner=$('session-banner'),btn=$('start-session');
  if(btn)btn.querySelector('span').textContent=active?'本轮选片':'开始选片';
  if(!banner)return;
  banner.hidden=!active;
  if(active){
    $('session-target').textContent=sessionTarget()||'未设置目标';
    $('session-count').textContent=`已选 ${(state.session.picks||[]).length} 张`;
    $('session-pick-toggle').setAttribute('aria-pressed',String(state.pickMode));
    $('session-pick-toggle').querySelector('span').textContent=state.pickMode?'挑片中':'浏览';
  }
}
async function toggleRoundPick(path){
  if(!state.session)return;
  const picks=state.session.picks||[];
  const idx=picks.findIndex(p=>samePath(p,path));
  if(idx>=0)picks.splice(idx,1);else picks.push(path);
  state.session.picks=picks;
  await persistSession();syncSessionUI();syncViewerRound();scheduleRender();
}
async function addRoundPicks(paths){
  if(!state.session){openSessionDialog('start');return;}
  const picks=state.session.picks||[];
  for(const p of paths)if(!picks.some(x=>samePath(x,p)))picks.push(p);
  state.session.picks=picks;
  await persistSession();syncSessionUI();scheduleRender();toast(`已加入 ${paths.length} 项`);
}
function openSessionDialog(mode,paths=[]){
  sessionDialogMode=mode;pendingExportPaths=paths;
  $('session-dialog-title').textContent=mode==='change'?'更改选片目标':(mode==='quick'?'选择导出目标':'开始新一轮选片');
  $('session-location').value=state.session?.location||state.exportFolder||'';
  $('session-name').value=state.session?.name||defaultSessionName();
  previewSessionPath();$('session-dialog').showModal();
  requestAnimationFrame(()=>$('session-location').focus());
}
async function endSession(){
  state.session=null;state.pickMode=false;
  await api('settings',{session:null});syncSessionUI();syncViewerRound();scheduleRender();
}
async function populateEditors(){
  if(!state.editors.length)state.editors=await api('detect_editors');
  const sel=$('export-editor');sel.replaceChildren();
  for(const e of state.editors){const opt=document.createElement('option');opt.value=e.id;opt.textContent=e.name+(e.available===false?'（未找到）':'');opt.disabled=e.available===false&&e.id!=='default';sel.append(opt);}
  if(state.externalEditor&&state.externalEditor.exe){const opt=document.createElement('option');opt.value='custom';opt.textContent=state.externalEditor.name||'自定义编辑器';sel.append(opt);}
  const preferred=state.externalEditor?.id||(state.editors.some(e=>e.id==='photoshop'&&e.available!==false)?'photoshop':'default');
  if([...sel.options].some(o=>o.value===preferred))sel.value=preferred;
  refreshSelectOptions('export-editor');
}
function syncExportDialog(){
  const isOpen=$('export-action').value==='open';
  $('export-editor-row').hidden=!isOpen;
  $('export-lr-hint').hidden=!(isOpen&&$('export-editor').value==='lightroom');
  $('export-lr-hint').textContent='Lightroom 批量打开能力有限，建议改用「导出到文件夹」';
  $('export-options').hidden=isOpen;
  $('export-change-target').hidden=isOpen;
  $('export-target').closest('.settings-row').hidden=isOpen;
  $('export-mode').closest('.settings-row').hidden=isOpen;
}
async function openExportDialog(paths,action='export',quickTarget=null,endsSession=false){
  if(action==='export'&&!quickTarget&&!endsSession){openSessionDialog('quick',paths);return;}
  pendingExportPaths=paths;pendingExportAction=action;pendingExportEndsSession=endsSession;
  $('export-target').textContent=endsSession?sessionTarget():(quickTarget||'');
  $('export-mode').value=state.exportMode||'copy';syncSelect('export-mode');
  $('export-action').value=action;syncSelect('export-action');
  $('export-progress').hidden=true;$('export-run').disabled=false;
  await populateEditors();syncExportDialog();
  $('export-dialog').showModal();
}
function renderExportProgress(p){
  const total=p.total||0,done=(p.copied||0)+(p.moved||0)+(p.skipped||0)+(p.failed||0);
  $('export-progress').querySelector('progress').value=total?done/total*100:0;
  $('export-progress-text').textContent=`${done} / ${total}`;
}
async function finishExport(p){
  $('export-dialog').close();
  const n=(p.copied||0)+(p.moved||0),skipped=p.skipped||0,failed=p.failed||0;
  const verb=p.mode==='move'?'移动':'复制';
  toast(`已${verb} ${n} 项，跳过 ${skipped} 项，失败 ${failed} 项`);
  if(failed&&p.errors?.length)toast(p.errors.slice(0,3).join('；'));
  if(pendingExportEndsSession)await endSession();
  if(p.mode==='move'&&state.folder)await openFolder(state.folder);
}
async function pollExport(jobId){
  for(;;){
    const p=await api('export_progress',jobId);
    renderExportProgress(p);
    if(p.state==='done'){await finishExport(p);return;}
    if(p.state==='error'){toast(p.error||'导出失败');$('export-run').disabled=false;return;}
    await new Promise(r=>setTimeout(r,400));
  }
}
async function runExportAction(){
  const action=$('export-action').value;
  const paths=pendingExportPaths.length?pendingExportPaths:(state.session?(state.session.picks||[]):[]);
  if(!paths.length)throw new Error('没有要处理的照片');
  if(action==='open'){
    const result=await api('open_external',paths,$('export-editor').value);
    $('export-dialog').close();
    toast(`已在 ${result.editor} 中打开 ${result.opened} 张`);
    if(result.capability==='limited'&&result.hint)toast(result.hint);
    if(pendingExportEndsSession)await endSession();
    return;
  }
  const target=state.session?sessionTarget():$('export-target').textContent;
  if(!target)throw new Error('请选择导出目标文件夹');
  const mode=$('export-mode').value;
  if(mode==='move'&&!(await confirmAction('移动原图','将把选中的原图从图库移出（移动）到目标文件夹，确定继续？')))return;
  const options={mode,collision:$('export-collision').value,include_companions:$('export-companions').checked,preserve_structure:$('export-structure').checked,open_folder_after:$('export-open-folder').checked};
  const result=await api('export_photos',paths,target,options);
  $('export-progress').hidden=false;$('export-run').disabled=true;
  await pollExport(result.job);
}
function syncViewerRound(){
  const btn=$('viewer-round');if(!btn)return;
  const picked=state.current&&isPicked(state.current.path);
  btn.classList.toggle('is-active',Boolean(picked));
  btn.setAttribute('aria-pressed',String(Boolean(picked)));
  btn.title=state.session?(picked?'移出本轮':'选入本轮'):'开始选片';
}
function promptTags(paths,remove=false){
  const dialog=$('tag-dialog'),input=$('tag-input'),current=$('tag-current');
  const items=itemsForPaths(paths),known=[...new Set(items.flatMap(item=>item.tags||[]))];
  const removed=new Set();
  $('tag-dialog-title').textContent=remove?'移除标签':'管理标签';
  input.placeholder=remove?'输入要移除的标签，多个标签用逗号分隔':'输入新标签，多个标签用逗号分隔'; input.value=''; current.replaceChildren();
  const render=()=>{current.replaceChildren();if(!known.length){const empty=document.createElement('span');empty.className='tag-empty';empty.textContent='当前没有标签';current.append(empty);return;}for(const tag of known){const chip=document.createElement('button');chip.type='button';chip.className='tag-chip'+(removed.has(tag)?' is-removed':'');chip.title=removed.has(tag)?'恢复标签':'删除标签';chip.innerHTML=`<span>${escapeHTML(tag)}</span><i data-lucide="${removed.has(tag)?'rotate-ccw':'x'}"></i>`;chip.onclick=()=>{removed.has(tag)?removed.delete(tag):removed.add(tag);render();};current.append(chip);}icons(current);};
  render(); dialog.showModal(); requestAnimationFrame(()=>input.focus());
  return new Promise(resolve=>{let done=false;const finish=async value=>{if(done)return;done=true;dialog.close();const typed=value.split(',').map(tag=>tag.trim()).filter(Boolean);const patch={};if(removed.size)patch.tags_remove=[...removed];if(typed.length)patch[remove?'tags_remove':'tags_add']=typed;if(Object.keys(patch).length)await applyMetadata(paths,patch);resolve();};$('tag-form').onsubmit=event=>{event.preventDefault();finish(input.value);};$('tag-cancel').onclick=()=>{done=true;dialog.close();resolve();};$('tag-dialog-close').onclick=()=>{done=true;dialog.close();resolve();};dialog.oncancel=event=>{event.preventDefault();done=true;dialog.close();resolve();};});
}
async function promptRating(paths){const dialog=$('rating-dialog');dialog.showModal();const choices=[...document.querySelectorAll('#rating-choices button')];choices.forEach(button=>button.classList.remove('is-active'));const current=itemsForPaths(paths);const shared=current.length&&current.every(item=>item.rating===current[0].rating)?current[0].rating:null;choices.forEach(button=>button.classList.toggle('is-active',Number(button.dataset.rating)<=Number(shared||0)));return new Promise(resolve=>{let done=false;const finish=async value=>{if(done)return;done=true;dialog.close();await applyMetadata(paths,{rating:value});resolve();};choices.forEach(button=>button.onclick=()=>finish(Number(button.dataset.rating)));$('rating-clear').onclick=()=>finish(null);$('rating-cancel').onclick=()=>{done=true;dialog.close();resolve();};$('rating-dialog-close').onclick=()=>{done=true;dialog.close();resolve();};dialog.oncancel=event=>{event.preventDefault();done=true;dialog.close();resolve();};});}
function readMetadataFilters(){const filters={};const tags=$('filter-tags').value.split(',').map(value=>value.trim()).filter(Boolean);if(tags.length)filters.tags=tags;const rating=$('filter-rating').value;if(rating)filters.rating=rating==='unrated'?'unrated':Number(rating);if(rating&&rating!=='unrated')filters.rating_op=$('filter-rating-op').value;const color=$('filter-color').value;if(color)filters.color_label=color;for(const key of ['favorite','flagged','rejected'])if($('filter-'+key).checked)filters[key]=true;return filters;}
function clearMetadataFilters(){state.metadataFilters={};$('filter-tags').value='';$('filter-rating').value='';$('filter-color').value='';for(const key of ['favorite','flagged','rejected'])$('filter-'+key).checked=false;}
function positionMetadataFilter(){
  const panel=$('metadata-filter');
  if(panel.hidden)return;
  closeSelects();
  const button=$('metadata-filter-button').getBoundingClientRect();
  const width=panel.offsetWidth;
  const left=Math.max(12,Math.min(innerWidth-width-12,button.left+button.width/2-width/2));
  const top=button.bottom+8;
  panel.style.setProperty('--filter-left',`${left}px`);
  panel.style.setProperty('--filter-top',`${top}px`);
  panel.style.setProperty('--filter-origin-x',`${button.left+button.width/2-left}px`);
  panel.classList.remove('is-constrained');
  panel.classList.toggle('is-constrained',panel.offsetHeight>innerHeight-top-12);
}
function visibleGrid() {
  const viewport=$('viewport'),grid=$('grid');const width=grid.clientWidth;
  const columns=Math.max(1,Math.floor((width+18)/(state.size+18))),tile=(width-(columns-1)*18)/columns,rowHeight=tile+85;
  const start=Math.max(0,Math.floor(viewport.scrollTop/rowHeight)-2)*columns;
  const end=Math.min(state.total,(Math.ceil((viewport.scrollTop+viewport.clientHeight)/rowHeight)+3)*columns);
  return {width,columns,tile,rowHeight,start:Math.min(start,state.total),end};
}
function gridKey(layout){return [state.epoch,state.total,layout.width,$('viewport').clientHeight,layout.columns,layout.start,layout.end].join(':');}
async function renderGrid(force=true) {
  if(force)gridDirty=true;
  if(!state.job)return;
  let layout=visibleGrid(),key=gridKey(layout);
  if(!force&&(key===renderingGridKey||(!gridDirty&&key===renderedGridKey)))return;
  const epoch=state.epoch,generation=++gridRenderGeneration;
  renderingGridKey=key;
  try {
    for(;;){
      const needed=[];
      for(let page=Math.floor(layout.start/200);page<=Math.floor(Math.max(0,layout.end-1)/200);page++)if(!state.pages.has(page))needed.push(page);
      for(const page of needed){await fetchPage(page*200);if(epoch!==state.epoch||generation!==gridRenderGeneration)return;}
      const next=visibleGrid(),nextKey=gridKey(next);
      if(nextKey===key)break;
      layout=next;key=nextKey;renderingGridKey=key;
    }
    if(!gridDirty&&key===renderedGridKey)return;
    const grid=$('grid');
    grid.style.height=Math.ceil(state.total/layout.columns)*layout.rowHeight+'px';grid.style.display='block';
    const latest=visibleGrid(),latestKey=gridKey(latest);
    if(latestKey!==key){scheduleRender(false);return;}
    const keep=new Set();
    for(let index=layout.start;index<layout.end;index++){const item=itemAt(index);if(!item)continue;keep.add(item.path);const node=card(item,index);node.style.position='absolute';node.style.width=layout.tile+'px';node.style.left=(index%layout.columns)*(layout.tile+18)+'px';node.style.top=Math.floor(index/layout.columns)*layout.rowHeight+'px';if(node.parentNode!==grid)grid.append(node);}
    for(const [path,node] of state.nodes||[]){if(!keep.has(path)){observer.unobserve(node.querySelector('img'));node.remove();state.nodes.delete(path);}}
    // Keep memory bounded to the first page plus pages near the viewport.
    for(const page of state.pages.keys())if(page!==0&&(page<Math.floor(layout.start/200)-1||page>Math.floor(layout.end/200)+1))state.pages.delete(page);
    renderedGridKey=key;gridDirty=false;
  } finally {
    if(generation===gridRenderGeneration)renderingGridKey='';
  }
}
function scheduleRender(force=true){renderForcePending ||= force;if(renderScheduled)return;renderScheduled=true;requestAnimationFrame(()=>{renderScheduled=false;const pending=renderForcePending;renderForcePending=false;safely(()=>renderGrid(pending));});}
function contextMenu(event,actions){const menu=$('context-menu');menu.replaceChildren();for(const [icon,label,action]of actions){const button=document.createElement('button');button.innerHTML=`<i data-lucide="${icon}"></i><span>${escapeHTML(label)}</span>`;button.onclick=()=>{menu.hidden=true;safely(action);};menu.append(button);}menu.hidden=false;icons(menu);menu.style.left=Math.min(event.clientX,innerWidth-menu.offsetWidth-12)+'px';menu.style.top=Math.min(event.clientY,innerHeight-menu.offsetHeight-12)+'px';}
function requestRename(currentName,directory=false,heading=''){
  const dialog=$('rename-dialog'),input=$('rename-name'),form=$('rename-form');
  $('rename-title').textContent=heading|| (directory?'重命名文件夹':'重命名文件');
  input.value=currentName;
  dialog.showModal();
  requestAnimationFrame(()=>{input.focus();const extension=directory?input.value.length:Math.max(0,input.value.lastIndexOf('.'));input.setSelectionRange(0,extension||input.value.length);});
  return new Promise(resolve=>{
    let settled=false;
    const finish=value=>{if(settled)return;settled=true;dialog.close();resolve(value);};
    form.onsubmit=event=>{event.preventDefault();finish(input.value.trim());};
    $('rename-cancel').onclick=()=>finish(null);
    $('rename-close').onclick=()=>finish(null);
    dialog.oncancel=event=>{event.preventDefault();finish(null);};
  });
}
async function renamePath(path,currentName,directory=false){
  const next=await requestRename(currentName,directory);
  if(next===null||next===currentName)return;
  const result=await api('rename',path,next);
  if(directory){
    state.roots=result.roots||state.roots;state.expanded=new Set(result.expanded||[]);forgetTree(path);await renderTree();refreshFolderSearch();
    if(result.current){state.folder=result.current;await openFolder(result.current);}else resetEmpty();
  }else if(state.folder)await openFolder(state.folder);
  toast(`${directory?'文件夹':'文件'}已重命名`);
}
function confirmAction(title,description){$('confirm-title').textContent=title;$('confirm-description').textContent=description;$('confirm-dialog').showModal();return new Promise(resolve=>{const finish=value=>{$('confirm-dialog').close();resolve(value);};$('confirm-ok').onclick=()=>finish(true);$('confirm-cancel').onclick=()=>finish(false);$('confirm-dialog').oncancel=()=>resolve(false);});}
async function trashItem(item){if(await confirmAction('移到回收站',`确认将「${item.name}」移到回收站？`)){await api('file_action',item.path,'trash',true);closeViewer();await openFolder(state.folder);toast('文件已移到回收站');}}
async function trashRejected(){
  if(!state.folder){toast('请先打开一个文件夹');return;}
  const recursive=$('recursive').checked;
  const {count}=await api('count_rejected',state.folder,recursive);
  if(!count){toast('没有已拒照片');return;}
  const scope=recursive?'当前文件夹（含子文件夹）':'当前文件夹';
  if(!(await confirmAction('移入回收站',`将 ${scope} 中的 ${count} 张已拒照片移入回收站？`)))return;
  const result=await api('trash_rejected',state.folder,recursive,true);
  $('metadata-filter').hidden=true;closeSelects();
  toast(`已移入回收站 ${result.count} 张`);
  await openFolder(state.folder);
}
function transform(){ $('viewer-image').style.transform=`translate(${state.x}px,${state.y}px) rotate(${state.rotation}deg) scale(${state.scale})`;$('zoom-label').textContent=Math.round(state.scale*100)+'%';window.havenGlass?.refresh(); }
function fit(){state.scale=1;state.x=0;state.y=0;transform();}
function setDetailsOpen(open){
  const details=$('details');
  if(!details)return;
  clearTimeout(detailsCloseTimer);
  if(open){
    details.hidden=false;
    details.classList.remove('details-closing','details-opening');
    void details.offsetWidth;
    details.classList.add('details-opening');
    return;
  }
  if(details.hidden)return;
  details.classList.remove('details-opening','details-closing');
  if(matchMedia('(prefers-reduced-motion: reduce)').matches){details.hidden=true;return;}
  void details.offsetWidth;
  details.classList.add('details-closing');
  detailsCloseTimer=setTimeout(()=>{details.hidden=true;details.classList.remove('details-closing');},240);
}
function toggleDetails(){const details=$('details');setDetailsOpen(details.hidden||details.classList.contains('details-closing'));}
async function showViewer(index){
  if(index<0||index>=state.total)return;
  const item=await ensureItem(index);if(!item)return;state.viewerIndex=index;state.current=item;state.rotation=0;fit();
  $('viewer-name').textContent=item.name;$('viewer-count').textContent=`${index+1} / ${state.total}`;$('previous').disabled=index===0;$('next').disabled=index===state.total-1;syncViewerMetadata();syncViewerRound();
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
  renderViewerDetails(item);scheduleRender();
}
function closeViewer(){setDetailsOpen(false);$('viewer-video').pause();$('viewer').close();scheduleRender();}
function showUpdate(result){if(!result.available)return;state.update=result.manifest;const data=state.update;$('update-version').textContent=`新版本 ${data.version}`;$('update-notes').textContent=data.notes||'新版本已发布';$('update-size').textContent=bytes(data.size);$('skip-update').hidden=!!data.mandatory;$('later-update').hidden=!!data.mandatory;$('download-progress').hidden=true;$('download-status').textContent='';$('install-update').disabled=false;if(!$('update-dialog').open)$('update-dialog').showModal();}
async function installUpdate(){await api('install_update',true);$('install-update').disabled=true;$('skip-update').disabled=true;$('later-update').disabled=true;$('download-progress').hidden=false;const poll=async()=>{const progress=await api('update_progress');$('download-progress').value=progress.progress||0;$('download-status').textContent=progress.state==='error'?progress.error:progress.state==='restarting'?'正在重启…':`正在下载 ${progress.progress||0}%`;if(progress.state==='downloading')setTimeout(()=>safely(poll),500);else if(progress.state==='error'){$('install-update').disabled=false;$('skip-update').disabled=false;$('later-update').disabled=false;}};await poll();}
function conditionRows(){return [...document.querySelectorAll('#smart-album-conditions .smart-condition')].map(row=>{const input=row.querySelector('input[data-value]'),color=row.querySelector('select[data-color-value]'),boolean=row.querySelector('input[data-boolean-value]');return {field:row.querySelector('select[data-field]').value,operator:row.querySelector('select[data-operator]').value,value:!boolean.parentElement.hidden?boolean.checked? 'true':'false':color&&!color.hidden?color.value:input?.value.trim()||''};}).filter(row=>row.value!==''||row.operator==='is_empty');}
function configureConditionRow(row){
  const field=row.querySelector('[data-field]'),operator=row.querySelector('[data-operator]'),value=row.querySelector('input[data-value]');
  let color=row.querySelector('select[data-color-value]');
  if(!color){
    color=document.createElement('select');color.dataset.colorValue='true';color.className='condition-color-value';color.setAttribute('aria-label','颜色标签');
    color.innerHTML='<option value="">选择颜色</option><option value="red">红色</option><option value="yellow">黄色</option><option value="green">绿色</option><option value="blue">蓝色</option><option value="purple">紫色</option>';
    const shell=document.createElement('div');shell.className='select-shell condition-select condition-color-select';shell.append(color);row.append(shell);
  }
  let boolean=row.querySelector('input[data-boolean-value]');
  if(!boolean){const label=document.createElement('label');label.className='condition-boolean-value';label.innerHTML='<input type="checkbox" data-boolean-value checked><span></span>';row.append(label);boolean=label.querySelector('input');}
  const syncBoolean=()=>{const labels={favorite:['已收藏','未收藏'],flagged:['有旗帜','无旗帜'],rejected:['已标记 Rejected','未标记 Rejected']};boolean.nextElementSibling.textContent=labels[field.value]?.[boolean.checked?0:1]||'';};
  const sync=()=>{
    const isBool=['favorite','flagged','rejected'].includes(field.value),isColor=field.value==='color_label';
    operator.innerHTML=isBool?'<option value="=">等于</option>':field.value==='tags'?'<option value="contains">包含</option><option value="not_contains">不包含</option>':field.value==='rating'?'<option value=">=">至少</option><option value="=">等于</option><option value="<=">至多</option><option value="is_empty">未评分</option>':'<option value="=">等于</option>';
    value.hidden=isColor||isBool;color.hidden=!isColor;color.parentElement.hidden=!isColor;boolean.parentElement.hidden=!isBool;
    value.type='text';value.placeholder=field.value==='rating'?'1-5 或留空':'值';value.disabled=field.value==='rating'&&operator.value==='is_empty';
    if(isColor&&value.value){color.value=value.value;syncSelect(color.id);}
    syncBoolean();
  };
  field.onchange=sync;operator.onchange=sync;color.onchange=()=>{value.value=color.value;};boolean.onchange=syncBoolean;sync();
}
function addConditionRow(){const host=$('smart-album-conditions'),row=host.firstElementChild.cloneNode(true);row.querySelector('[data-value]').value='';host.append(row);configureConditionRow(row);}
let editingSmartAlbumId=null, conditionSequence=0;
function buildConditionRow(condition={}){
  const row=document.createElement('div');row.className='smart-condition';
  row.innerHTML='<select data-field><option value="rating">评分</option><option value="tags">标签</option><option value="color_label">颜色标签</option><option value="favorite">收藏</option><option value="flagged">旗帜</option><option value="rejected">Rejected</option></select><select data-operator></select><input data-value placeholder="值"><button type="button" class="icon-button condition-remove" title="移除条件" aria-label="移除条件"><i data-lucide="x"></i></button>';
  row.querySelector('[data-field]').value=condition.field||'rating';configureConditionRow(row);
  const field=row.querySelector('[data-field]'),operator=row.querySelector('[data-operator]'),input=row.querySelector('input[data-value]'),color=row.querySelector('select[data-color-value]'),boolean=row.querySelector('input[data-boolean-value]');
  if(condition.operator)operator.value=condition.operator;
  if(condition.value!==undefined&&condition.value!=='unrated'){input.value=String(condition.value);color.value=String(condition.value);boolean.checked=condition.value!==false&&condition.value!=='false';}
  input.disabled=operator.value==='is_empty';
  row.querySelector('.condition-remove').onclick=()=>{if(document.querySelectorAll('#smart-album-conditions .smart-condition').length>1)row.remove();};
  field.id=`condition-field-${++conditionSequence}`;operator.id=`condition-operator-${conditionSequence}`;color.id=`condition-color-${conditionSequence}`;
  for(const select of [field,operator]){const shell=document.createElement('div');shell.className='select-shell condition-select';select.replaceWith(shell);shell.append(select);glassSelectNode(select,select.id);}
  const colorControl=glassSelectNode(color,color.id);colorControl.button.classList.add('color-select-button');colorControl.menu.classList.add('color-select-menu');
  field.addEventListener('change',()=>refreshSelectOptions(operator.id));configureConditionRow(row);icons(row);return row;
}
 function openSmartAlbumEditor(album=null){editingSmartAlbumId=album?.id||null;const dialog=$('smart-album-dialog');dialog.querySelector('h2').textContent=album?'编辑智能相册':'新建智能相册';$('smart-album-name').value=album?.name||'';$('smart-album-logic').value=album?.definition?.logic||'and';syncSelect('smart-album-logic');const host=$('smart-album-conditions');host.replaceChildren(...((album?.definition?.conditions||[{}]).map(buildConditionRow)));dialog.showModal();}
function createSmartAlbum(){openSmartAlbumEditor();}
function editSmartAlbum(album){openSmartAlbumEditor(album);}
function bindSmartAlbumForm(){const form=$('smart-album-form');form.onsubmit=event=>safely(async()=>{event.preventDefault();const name=$('smart-album-name').value.trim();const conditions=conditionRows().map(row=>({field:row.field,operator:row.operator,value:row.operator==='is_empty'?'unrated':['favorite','flagged','rejected'].includes(row.field)?row.value.toLowerCase()==='true':row.field==='rating'?Number(row.value):row.value}));if(!name||!conditions.length)throw new Error('请填写相册名称并至少添加一个条件');const definition={logic:$('smart-album-logic').value,conditions};if(editingSmartAlbumId)await api('update_smart_album',editingSmartAlbumId,name,definition);else await api('create_smart_album',name,definition);dialogClose('smart-album-dialog');await renderSmartAlbums();});$('add-smart-condition').onclick=()=>{$('smart-album-conditions').append(buildConditionRow());};}
function dialogClose(id){const dialog=$(id);if(dialog?.open)dialog.close();}
async function init(){
  initSidebarResize();
  glassSelect('filter-rating-op');glassSelect('filter-rating');glassSelect('filter-color');glassSelect('smart-album-logic');glassSelect('export-mode');glassSelect('export-action');glassSelect('export-editor');glassSelect('export-collision');glassSelect('export-mode-setting');
  icons();glassSelect('sort');glassSelect('theme-select');const boot=await api('bootstrap');state.roots=boot.state.roots;state.expanded=new Set(boot.state.expanded);state.desktop=boot.desktop;state.size=boot.state.thumb_size||240;state.exportMode=boot.state.export_mode||'copy';state.exportFolder=boot.state.export_folder||'';state.externalEditor=boot.state.external_editor||null;state.session=boot.state.session||null;document.documentElement.dataset.theme=boot.state.theme;$('theme-select').value=boot.state.theme;syncSelect('theme-select');$('export-mode-setting').value=state.exportMode;syncSelect('export-mode-setting');$('thumb-size').value=state.size;document.documentElement.style.setProperty('--tile',state.size+'px');$('auto-update').checked=boot.state.auto_update;$('recursive').checked=!!boot.state.recursive;$('version').textContent=boot.version;ensureTransparencyControl(Number.isFinite(Number(boot.state.glass_transparency))?Number(boot.state.glass_transparency):.24);
  const knownTags=await api('list_tags');$('tag-suggestions').replaceChildren(...knownTags.map(tag=>{const option=document.createElement('option');option.value=tag.name;return option;}));
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
  $('refresh').onclick=()=>{state.children.clear();state.counts.clear();safely(async()=>{await renderTree();refreshFolderSearch();if(state.folder)await openFolder(state.folder);});};
  $('folder-search').oninput=updateFolderSearch;
  $('folder-search').onkeydown=event=>{if(event.key==='Escape'){$('folder-search').value='';updateFolderSearch();}else if(event.key==='Enter'){event.preventDefault();$('folder-search-results').querySelector('.folder-search-result')?.click();}};
  $('subfolders-toggle').onclick=toggleSubfolders;
  $('up-folder').onclick=()=>safely(async()=>{if(!state.folder)return;const parent=state.folder.replace(/[\\/][^\\/]+[\\/]?$/,'');if(parent&&parent!==state.folder)await openFolder(parent);});
  $('theme-button').onclick=()=>theme((themeTarget||document.documentElement.dataset.theme)==='dark'?'light':'dark');$('theme-select').onchange=event=>theme(event.target.value);
  $('search').oninput=event=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{state.query=event.target.value;safely(reloadFilter);},200);};
  $('filters').onclick=event=>{const button=event.target.closest('[data-kind]');if(!button)return;state.kind=button.dataset.kind;for(const tab of $('filters').children)tab.setAttribute('aria-selected',tab===button);safely(reloadFilter);};
  $('metadata-filter-button').onclick=event=>{event.stopPropagation();const panel=$('metadata-filter');panel.hidden=!panel.hidden;if(panel.hidden)closeSelects();else positionMetadataFilter();};$('metadata-filter-close').onclick=()=>{$('metadata-filter').hidden=true;closeSelects();};$('filter-apply').onclick=()=>{state.metadataFilters=readMetadataFilters();$('metadata-filter').hidden=true;closeSelects();safely(reloadFilter);};$('filter-clear').onclick=()=>{clearMetadataFilters();$('metadata-filter').hidden=true;closeSelects();safely(reloadFilter);};$('trash-rejected').onclick=()=>safely(trashRejected);
  window.addEventListener('resize',positionMetadataFilter);
  $('selection-mode').onclick=toggleSelectionMode;
  $('clear-selection').onclick=()=>{state.selection.clear();state.lastSelectedIndex=null;updateBulkToolbar();scheduleRender();};
  $('start-session').onclick=()=>{if(state.session)openSessionDialog('change');else openSessionDialog('start');};
  $('session-finish').onclick=()=>safely(()=>openExportDialog(state.session?.picks||[],'export',null,true));
  $('session-cancel').onclick=()=>safely(async()=>{if(await confirmAction('取消本轮','丢弃本轮已选的照片？不会删除任何文件。')){await endSession();toast('本轮已取消');}});
  $('session-pick-toggle').onclick=()=>{state.pickMode=!state.pickMode;syncSessionUI();scheduleRender();};
  $('session-browse').onclick=()=>safely(async()=>{if(!state.desktop){$('session-location').focus();return;}const r=await api('pick_folder');if(r.path){$('session-location').value=r.path;previewSessionPath();}});
  $('session-location').oninput=previewSessionPath;$('session-name').oninput=previewSessionPath;
  $('session-form').onsubmit=event=>{event.preventDefault();safely(async()=>{
    const target=sessionTargetFromInputs();if(!target)throw new Error('请填写导出位置和文件夹名称');
    const location=$('session-location').value.trim(),name=$('session-name').value.trim();
    if(sessionDialogMode==='quick'){
      $('session-dialog').close();
      await api('settings',{export_folder:location});state.exportFolder=location;
      await openExportDialog(pendingExportPaths,'export',target);
      return;
    }
    const picks=(sessionDialogMode==='change'&&state.session)?state.session.picks:[];
    state.session={location,name,target,picks};state.pickMode=true;
    await api('settings',{session:state.session,export_folder:location});state.exportFolder=location;
    $('session-dialog').close();syncSessionUI();scheduleRender();
    toast(sessionDialogMode==='change'?'选片目标已更新':'选片已开始，点击照片挑入本轮');
  });};
  $('viewer-round').onclick=()=>safely(async()=>{if(!state.session){openSessionDialog('start');return;}await toggleRoundPick(state.current.path);});
  $('export-action').onchange=syncExportDialog;$('export-editor').onchange=syncExportDialog;
  $('export-change-target').onclick=()=>{$('export-dialog').close();if(pendingExportEndsSession)openSessionDialog('change');else openSessionDialog('quick',pendingExportPaths);};
  $('export-cancel').onclick=()=>$('export-dialog').close();
  $('export-run').onclick=()=>safely(runExportAction);
  $('export-mode-setting').onchange=event=>safely(async()=>{state.exportMode=event.target.value;await api('settings',{export_mode:event.target.value});});
  window.addEventListener('haven:export-progress',event=>{if($('export-dialog').open)renderExportProgress(event.detail);});
  $('add-smart-album').onclick=()=>createSmartAlbum();
  configureConditionRow($('smart-album-conditions').firstElementChild);
  bindSmartAlbumForm();
  document.querySelectorAll('[data-bulk]').forEach(button=>button.onclick=()=>safely(async()=>{const paths=selectedPaths();if(!paths.length)return;const action=button.dataset.bulk;if(action==='tag-add')await promptTags(paths);else if(action==='rating')await promptRating(paths);else if(action==='color')await promptColor(paths);else if(['favorite','flagged','rejected'].includes(action))await toggleMetadata(paths,action);else if(action==='round')await addRoundPicks(paths);}));
  $('sort').onchange=event=>{state.sort=event.target.value;safely(reloadFilter);};$('sort-direction').onclick=()=>{state.descending=!state.descending;$('sort-direction').style.transform=state.descending?'rotate(180deg)':'';safely(reloadFilter);};
  $('thumb-size').oninput=event=>{state.size=Number(event.target.value);document.documentElement.style.setProperty('--tile',state.size+'px');scheduleRender();};$('thumb-size').onchange=()=>safely(()=>api('settings',{thumb_size:state.size}));
  $('recursive').onchange=()=>{if(state.folder)safely(()=>openFolder(state.folder));};$('viewport').onscroll=()=>scheduleRender(false);new ResizeObserver(()=>scheduleRender()).observe($('viewport'));
  $('viewer-close').onclick=closeViewer;$('viewer').oncancel=event=>{event.preventDefault();closeViewer();};
  $('viewer').addEventListener('close',()=>{const video=$('viewer-video');video.removeAttribute('src');video.load();$('viewer-image').removeAttribute('src');setDetailsOpen(false);});
  $('previous').onclick=()=>safely(()=>showViewer(state.viewerIndex-1));$('next').onclick=()=>safely(()=>showViewer(state.viewerIndex+1));$('rotate').onclick=()=>{state.rotation+=90;transform();};$('fit').onclick=fit;
  $('actual').onclick=()=>{const img=$('viewer-image');state.scale=img.naturalWidth/Math.max(1,img.clientWidth);state.x=state.y=0;transform();};
  $('info-button').onclick=toggleDetails;
  $('reveal').onclick=()=>safely(()=>api('file_action',state.current.path,'reveal'));$('copy-path').onclick=()=>safely(async()=>{await api('file_action',state.current.path,'copy');toast('路径已复制');});$('system-open').onclick=()=>safely(()=>api('file_action',state.current.path,'open'));$('trash').onclick=()=>safely(()=>trashItem(state.current));
  $('live-play').onclick=()=>{const video=$('viewer-video');$('viewer-image').hidden=true;video.hidden=false;video.src=state.current.live_path?mediaURL({path:state.current.live_path},'original'):mediaURL(state.current,'motion');video.play().catch(()=>{});};
  $('viewer-rating').onclick=()=>safely(()=>promptRating([state.current.path]));$('viewer-tag').onclick=()=>safely(()=>promptTags([state.current.path]));$('viewer-color').onclick=()=>safely(()=>promptColor([state.current.path]));
  for(const key of ['favorite','flagged','rejected'])$(`viewer-${key}`).onclick=()=>safely(()=>toggleMetadata([state.current.path],key));
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
    if(!$('viewer').open||event.isComposing||event.ctrlKey||event.metaKey||event.altKey||event.target.closest('input,select,textarea,[contenteditable="true"]')||document.querySelector('dialog[open]:not(#viewer)'))return;
    if(event.key===' '){
      if($('viewer-image').hidden||event.target.closest('button,[role="button"]'))return;
      event.preventDefault();fit();return;
    }
    const key=event.key.toLowerCase();
    if(key==='f'){
      event.preventDefault();
      if(!event.repeat)toggleDetails();
      return;
    }
    if(!['ArrowRight','ArrowLeft'].includes(event.key)&&key!=='a'&&key!=='d')return;
    event.preventDefault();
    // Keep focus off the header buttons so arrow keys never paint a focus ring on them.
    const active=document.activeElement;
    if(active&&active!==$('viewer-stage')&&active.closest&&active.closest('#viewer'))$('viewer-stage').focus({preventScroll:true});
    safely(()=>showViewer(state.viewerIndex+(event.key==='ArrowRight'||key==='d'?1:-1)));
  });
  document.addEventListener('click',event=>{if(!event.target.closest('#context-menu'))$('context-menu').hidden=true;closeSelects();});document.addEventListener('keydown',event=>{if(event.key==='Escape'){ $('context-menu').hidden=true;closeSelects(); }});
  $('settings-button').onclick=()=>$('settings-dialog').showModal();document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>$(button.dataset.close).close());
  $('auto-update').onchange=event=>safely(()=>api('settings',{auto_update:event.target.checked}));$('history').onclick=()=>safely(()=>api('release_history'));
  $('check-update').onclick=()=>safely(async()=>{$('check-update').disabled=true;$('update-check-status').textContent='正在检查…';try{const result=await api('check_update',true);$('update-check-status').textContent=result.error||(result.available?'发现新版本':'已是最新版本');if(result.available){$('settings-dialog').close();showUpdate(result);}}finally{$('check-update').disabled=false;}});
  $('later-update').onclick=()=>$('update-dialog').close();$('skip-update').onclick=()=>safely(async()=>{await api('settings',{skipped_version:state.update.version});$('update-dialog').close();});$('install-update').onclick=()=>safely(installUpdate);$('update-dialog').oncancel=event=>{if(state.update?.mandatory||$('install-update').disabled)event.preventDefault();};
  $('sidebar').ondragover=event=>{event.preventDefault();$('sidebar').classList.add('drag-over');};$('sidebar').ondragleave=()=>$('sidebar').classList.remove('drag-over');$('sidebar').ondrop=event=>{event.preventDefault();$('sidebar').classList.remove('drag-over');if(state.desktop)return;for(const file of event.dataTransfer.files){const path=file.pywebviewFullPath||file.path;if(path)safely(()=>addFolder(path));}};
  window.addEventListener('haven:folder-added',event=>safely(async()=>{state.roots=event.detail.roots;if(event.detail.expanded)state.expanded=new Set(event.detail.expanded);else state.expanded.add(event.detail.path);await api('settings',{expanded:[...state.expanded]});await renderTree();refreshFolderSearch();await openFolder(event.detail.path);}));window.addEventListener('haven:update',event=>showUpdate(event.detail));window.addEventListener('haven:error',event=>toast(event.detail.message));
  syncSessionUI();
  await renderTree();await renderSmartAlbums();if(boot.state.current&&state.roots.length)await openFolder(boot.state.current);
}
document.addEventListener('DOMContentLoaded',()=>safely(init));
