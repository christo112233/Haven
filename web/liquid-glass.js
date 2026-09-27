'use strict';

(() => {
  const token = window.HAVEN_TOKEN;
  const asset = path => `${path}?token=${encodeURIComponent(token)}`;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const surfaces = '#sidebar, .glass:not(.toolbar), .search, .icon-button, .primary, .secondary, .sort-controls, .tree-row, #toast, .panel-dialog, input[role="switch"], #folder-path';
  const springs = new WeakMap();
  let program, canvas, ctx, scene, blurredScene, blurCtx, lastTheme, themeFade;
  let pointer = {x: -200, y: -200}, cursorTarget = {x: -200, y: -200}, cursorVisible = false, hover = null, pressed = null;
  let cursorElement = null;
  let frame = 0, lastTick = 0, lastPaint = 0, sceneDirty = true, running = true;
  let activePill = null, sliderThumb = null;
  let sceneRevision = 0, lastInteraction = 0;
  let surfaceNodes = [], modalCanvas = null, activeDialog = null;
  const diagnostics = {ready:false, frames:0, surfaces:0, backend:'fallback', animations:0};
  window.havenGlass = {diagnostics, refresh: () => {sceneDirty = true;}, setTransparency: value => {document.documentElement.style.setProperty('--glass-transparency', String(Math.max(0, Math.min(1, Number(value) || 0))));sceneDirty = true;}, setThemeInstant: () => {themeFade=null;sceneDirty=true;if(diagnostics.ready)animate(performance.now(),true);}, renderOnce: () => {if(diagnostics.ready)animate(performance.now(),true);}};

  async function shaderSource(path) {
    const response = await fetch(asset(`/shaders/${path}`));
    if(!response.ok) throw new Error(`Shader load failed: ${path}`);
    let source = await response.text();
    const includes = [...source.matchAll(/#include "([^"]+)"/g)];
    for(const include of includes) source = source.replace(include[0], await shaderSource(include[1]));
    return source;
  }

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  function makeRenderer(target, vertex, fragment) {
    const context = target.getContext('webgl2', {alpha:true, antialias:false, premultipliedAlpha:false, preserveDrawingBuffer:true, powerPreference:'low-power'});
    if(!context) throw new Error('WebGL2 unavailable');
    const shaderProgram = context.createProgram();
    for(const [type, source] of [[context.VERTEX_SHADER,vertex],[context.FRAGMENT_SHADER,fragment]]) {
      const shader = compile(context,type,source);context.attachShader(shaderProgram,shader);context.deleteShader(shader);
    }
    context.linkProgram(shaderProgram);
    if(!context.getProgramParameter(shaderProgram,context.LINK_STATUS)) throw new Error(context.getProgramInfoLog(shaderProgram));
    context.useProgram(shaderProgram);
    const buffer = context.createBuffer();context.bindBuffer(context.ARRAY_BUFFER,buffer);
    context.bufferData(context.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),context.STATIC_DRAW);
    const position = context.getAttribLocation(shaderProgram,'a_position');context.enableVertexAttribArray(position);context.vertexAttribPointer(position,2,context.FLOAT,false,0,0);
    const sceneTexture = context.createTexture();context.bindTexture(context.TEXTURE_2D,sceneTexture);
    context.texParameteri(context.TEXTURE_2D,context.TEXTURE_MIN_FILTER,context.LINEAR);context.texParameteri(context.TEXTURE_2D,context.TEXTURE_MAG_FILTER,context.LINEAR);
    context.texParameteri(context.TEXTURE_2D,context.TEXTURE_WRAP_S,context.CLAMP_TO_EDGE);context.texParameteri(context.TEXTURE_2D,context.TEXTURE_WRAP_T,context.CLAMP_TO_EDGE);
    const blurredTexture=context.createTexture();context.bindTexture(context.TEXTURE_2D,blurredTexture);
    context.texParameteri(context.TEXTURE_2D,context.TEXTURE_MIN_FILTER,context.LINEAR);context.texParameteri(context.TEXTURE_2D,context.TEXTURE_MAG_FILTER,context.LINEAR);
    context.texParameteri(context.TEXTURE_2D,context.TEXTURE_WRAP_S,context.CLAMP_TO_EDGE);context.texParameteri(context.TEXTURE_2D,context.TEXTURE_WRAP_T,context.CLAMP_TO_EDGE);
    const uniforms = {};
    for(const name of ['u_scene','u_blurred_scene','u_resolution','u_scale','u_rect','u_trail','u_radius','u_tint','u_pointer','u_activity','u_time','u_strength','u_blur','u_glow','u_opacity','u_cursor','u_cursor_contrast']) uniforms[name] = context.getUniformLocation(shaderProgram,name);
    context.uniform1i(uniforms.u_scene,0);
    context.uniform1i(uniforms.u_blurred_scene,1);
    context.enable(context.BLEND);context.blendFunc(context.SRC_ALPHA,context.ONE_MINUS_SRC_ALPHA);
    return {gl:context,program:shaderProgram,texture:sceneTexture,blurredTexture,uniforms,target,revision:-1};
  }

  // Haven paints its own quiet backdrop: two soft light pools over a calm vertical gradient.
  const backdrops = {
    dark: {
      base: [[0,'#070f18'],[.48,'#0c1a26'],[1,'#091320']],
      glows: [[.12,.06,1.15,'64,150,206',.2],[.9,.96,1.05,'102,120,216',.16]],
      vignette: [[.45,'rgba(0,0,0,0)'],[1,'rgba(0,0,0,.42)']]
    },
    light: {
      base: [[0,'#f9fcfe'],[.5,'#eef5fa'],[1,'#e7f0f7']],
      glows: [[.1,.04,1.15,'132,186,228',.34],[.92,.98,1.05,'178,188,236',.32]],
      vignette: [[.45,'rgba(255,255,255,0)'],[1,'rgba(126,148,170,.22)']]
    }
  };

  function paintBackdrop(context, width, height, theme) {
    const palette = backdrops[theme === 'light' ? 'light' : 'dark'];
    const base = context.createLinearGradient(0, 0, width * .55, height);
    for (const [stop, color] of palette.base) base.addColorStop(stop, color);
    context.fillStyle = base; context.fillRect(0, 0, width, height);
    for (const [x, y, radius, rgb, alpha] of palette.glows) {
      const glow = context.createRadialGradient(width * x, height * y, 0, width * x, height * y, Math.max(width, height) * radius);
      glow.addColorStop(0, `rgba(${rgb},${alpha})`);
      glow.addColorStop(1, `rgba(${rgb},0)`);
      context.fillStyle = glow; context.fillRect(0, 0, width, height);
    }
    const vignette = context.createRadialGradient(width / 2, height * -.08, 0, width / 2, height * -.08, Math.max(width, height) * 1.3);
    for (const [stop, color] of palette.vignette) vignette.addColorStop(stop, color);
    context.fillStyle = vignette; context.fillRect(0, 0, width, height);
  }

  function beginThemeFade() {
    if (reducedMotion.matches || !scene || !scene.width) return;
    const fromLight=themeFade ? themeFade.fromLight+(themeFade.toLight-themeFade.fromLight)*(themeFade.progress||0) : Number(lastTheme==='light');
    const snapshot = source => {
      const target=document.createElement('canvas');
      target.width=source.width;target.height=source.height;
      target.getContext('2d',{alpha:false}).drawImage(source,0,0);
      return target;
    };
    themeFade = {fromScene:snapshot(scene),fromBlur:snapshot(blurredScene),fromLight,toLight:Number(document.documentElement.dataset.theme==='light'),progress:0,start:performance.now(),duration:520,snapshot};
    lastInteraction = performance.now(); sceneDirty = true;
  }

  function blendTheme(time) {
    if(!themeFade?.toScene)return;
    const progress=Math.min(1,(time-themeFade.start)/themeFade.duration);
    themeFade.progress=progress;
    ctx.drawImage(themeFade.toScene,0,0);
    blurCtx.drawImage(themeFade.toBlur,0,0);
    if(progress<1){
      ctx.globalAlpha=1-progress;ctx.drawImage(themeFade.fromScene,0,0);ctx.globalAlpha=1;
      blurCtx.globalAlpha=1-progress;blurCtx.drawImage(themeFade.fromBlur,0,0);blurCtx.globalAlpha=1;
    }else themeFade=null;
    sceneRevision++;
  }

  function captureScene() {
    const width = innerWidth, height = innerHeight;
    if(scene.width!==width||scene.height!==height){scene.width=width;scene.height=height;}
    const theme = document.documentElement.dataset.theme;
    paintBackdrop(ctx,width,height,theme);
    const viewing = !!document.querySelector('#viewer[open]');
    // Keep the underlying scene stable while a dialog is open. The dialog's
    // ::backdrop provides the frosted overlay; tinting this shared texture
    // would recolor every glass surface behind it and snap back on close.
    // Sample actual local images for glass that overlaps photo/video content.
    const media=activeDialog&&!viewing?[]:document.querySelectorAll(viewing?'#viewer-image, #viewer-video':'.picture img');
    for(const source of media) {
      const video=source.tagName==='VIDEO';
      const naturalWidth=video?source.videoWidth:source.naturalWidth;
      const naturalHeight=video?source.videoHeight:source.naturalHeight;
      if((video?source.readyState<2:!source.complete)||!naturalWidth||source.hidden||!source.checkVisibility())continue;
      const rect = source.getBoundingClientRect();
      if(rect.bottom<0||rect.top>height)continue;
      const localWidth=viewing?source.clientWidth:rect.width,localHeight=viewing?source.clientHeight:rect.height;
      const scale = Math.min(localWidth/naturalWidth,localHeight/naturalHeight);
      const w = naturalWidth*scale,h=naturalHeight*scale;
      ctx.save();
      const viewport=source.closest('#viewport, #viewer-stage');
      if(viewport){const clip=viewport.getBoundingClientRect();ctx.beginPath();ctx.rect(clip.x,clip.y,clip.width,clip.height);ctx.clip();}
      if(viewing){
        const matrix=new DOMMatrix(getComputedStyle(source).transform);
        ctx.translate(rect.x+rect.width/2,rect.y+rect.height/2);ctx.transform(matrix.a,matrix.b,matrix.c,matrix.d,0,0);
        ctx.drawImage(source,-w/2,-h/2,w,h);
      }else ctx.drawImage(source,rect.x+(rect.width-w)/2,rect.y+(rect.height-h)/2,w,h);
      ctx.restore();
    }
    // Dialogue panels sample a calm, evenly dimmed backdrop instead of the photos behind them.
    if(activeDialog&&activeDialog.id!=='viewer'){ctx.fillStyle=theme==='dark'?'rgba(4,17,28,.55)':'rgba(238,246,251,.62)';ctx.fillRect(0,0,width,height);}
    if(blurredScene.width!==width||blurredScene.height!==height){blurredScene.width=width;blurredScene.height=height;}
    blurCtx.filter='blur(20px)';blurCtx.drawImage(scene,0,0);blurCtx.filter='none';
    if(themeFade){
      themeFade.toScene=themeFade.snapshot(scene);
      themeFade.toBlur=themeFade.snapshot(blurredScene);
      blendTheme(performance.now());
    }
    sceneDirty=false;lastTheme=theme;sceneRevision++;
  }

  function spring(node, target, dt, special = false) {
    let value = springs.get(node);
    if(!value){value={x:target.x,y:target.y,w:target.w,h:target.h,vx:0,vy:0,vw:0,vh:0,activity:0};springs.set(node,value);}
    if(reducedMotion.matches){Object.assign(value,target);return value;}
    for(const [key,velocity] of [['x','vx'],['y','vy'],['w','vw'],['h','vh']]) {
      const difference=target[key]-value[key];
      value[velocity]+=(difference*(special?360:480)-value[velocity]*30)*dt;
      value[key]+=value[velocity]*dt;
    }
    value.activity += ((node===hover||node===pressed?1:0)-value.activity)*Math.min(1,dt*12);
    return value;
  }

  function updateCursor() {
    pointer.x = cursorTarget.x; pointer.y = cursorTarget.y;
    if (cursorElement) {
      const dialogBounds=activeDialog?.getBoundingClientRect();
      cursorElement.style.left = `${cursorTarget.x-(dialogBounds?.left||0)}px`;
      cursorElement.style.top = `${cursorTarget.y-(dialogBounds?.top||0)}px`;
      cursorElement.classList.toggle('is-visible', cursorVisible);
    }
  }

  function cursorTrail(bounds) {
    if (!cursorVisible) return [0, 0, 0, 0];
    const nearestX = Math.max(bounds.left, Math.min(cursorTarget.x, bounds.right));
    const nearestY = Math.max(bounds.top, Math.min(cursorTarget.y, bounds.bottom));
    return Math.hypot(cursorTarget.x - nearestX, cursorTarget.y - nearestY) < 32 ? [cursorTarget.x, cursorTarget.y, 24, 24] : [0, 0, 0, 0];
  }

  function distanceToBounds(bounds) {
    const x=Math.max(bounds.left,Math.min(cursorTarget.x,bounds.right));
    const y=Math.max(bounds.top,Math.min(cursorTarget.y,bounds.bottom));
    return Math.hypot(cursorTarget.x-x,cursorTarget.y-y);
  }

  function syncCursorLayer(dialog) {
    if (!cursorElement) return;
    if (dialog) {
      if (cursorElement.parentNode !== dialog) dialog.append(cursorElement);
    } else if (cursorElement.parentNode !== document.body) {
      document.body.append(cursorElement);
    }
    cursorElement.classList.toggle('is-modal', Boolean(dialog));
  }

  function rectangles(root, dt) {
    const rects=[];
    let mergedCursor=false;
    let mergeTarget=null, mergeDistance=32;
    if(cursorVisible && (root ? activeDialog===root : !activeDialog)) {
      const candidates=surfaceNodes.filter(node=>node.tagName==='BUTTON'||node.classList.contains('tree-row'));
      if(!root)candidates.push(...document.querySelectorAll('#filters button'));
      for(const node of candidates) {
        // The filter popover is a DOM layer above the shared WebGL canvas.
        // Keep its pointer cursor in the DOM so it cannot be painted underneath the panel.
        if(node.closest('#metadata-filter'))continue;
        if(!node.isConnected||!node.checkVisibility()||node.closest('dialog')!==root)continue;
        const distance=distanceToBounds(node.getBoundingClientRect());
        if(distance<mergeDistance){mergeTarget=node;mergeDistance=distance;}
      }
      if(!root){
        const input=document.getElementById('thumb-size');
        if(input){
          const bounds=input.getBoundingClientRect(),fraction=(Number(input.value)-Number(input.min))/(Number(input.max)-Number(input.min));
          const x=bounds.x+12+fraction*(bounds.width-24),y=bounds.y+bounds.height/2;
          const distance=distanceToBounds({left:x-12,right:x+12,top:y-10,bottom:y+10});
          if(distance<mergeDistance)mergeTarget=input;
        }
      }
    }
    for(const node of surfaceNodes) {
      if(node===root)continue;
      if(node.classList.contains('tree-row')&&!node.classList.contains('active')&&node!==hover&&node!==mergeTarget)continue;
      if(!node.isConnected||!node.checkVisibility()||node.closest('dialog')!==root)continue;
      const bounds=node.getBoundingClientRect();
      if(bounds.width<2||bounds.height<2||bounds.bottom<0||bounds.top>innerHeight)continue;
      const style=getComputedStyle(node);
      const radius=Math.min(parseFloat(style.borderTopLeftRadius)||8,bounds.width/2,bounds.height/2);
      const value=spring(node,{x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2,w:bounds.width,h:bounds.height},dt);
      const dialog=node.classList.contains('panel-dialog');
      const details=node.id==='details';
      const panel=node.id==='sidebar'||dialog||details;
      const tinted=node.classList.contains('primary')||node.classList.contains('active');
      const trail = node===mergeTarget ? cursorTrail({left:bounds.left, right:bounds.right, top:bounds.top, bottom:bounds.bottom}) : [0,0,0,0];
      if (trail[2]) mergedCursor=true;
      rects.push({...value,radius,panel,dialog,details,tinted,trail,modalSurface:!!root,blur:dialog||details?1:panel?.3:.2});
    }
    if(!root) {
      const selected=document.querySelector('#filters [aria-selected="true"]');
      if(selected){
        activePill ||= {};
        const bounds=selected.getBoundingClientRect();
        const value=spring(activePill,{x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2,w:bounds.width,h:bounds.height},dt,true);
        // Stretch the selection in the direction of travel, then let it settle.
        const trail=selected===mergeTarget?cursorTrail({left:bounds.left,right:bounds.right,top:bounds.top,bottom:bounds.bottom}):!reducedMotion.matches&&Math.abs(value.vx)>30?[value.x-Math.max(-36,Math.min(36,value.vx*.035)),value.y,value.w*.65,value.h*.85]:[0,0,0,0];
        if(selected===mergeTarget&&trail[2])mergedCursor=true;
        rects.push({...value,w:value.w+Math.min(22,Math.abs(value.vx)*.025),radius:bounds.height/2,tinted:true,activity:.65,trail});
        document.getElementById('filters').style.setProperty('--pill-left',`${value.x-value.w/2-document.getElementById('filters').getBoundingClientRect().x}px`);
      }
      if(mergeTarget?.matches?.('#filters button')&&mergeTarget!==selected){
        const bounds=mergeTarget.getBoundingClientRect();
        const value=spring(mergeTarget,{x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2,w:bounds.width,h:bounds.height},dt,true);
        const trail=cursorTrail({left:bounds.left,right:bounds.right,top:bounds.top,bottom:bounds.bottom});
        if(trail[2])mergedCursor=true;
        rects.push({...value,radius:bounds.height/2,tinted:true,activity:.6,trail});
      }
      const input=document.getElementById('thumb-size');
      if(input){
        const bounds=input.getBoundingClientRect(),fraction=(Number(input.value)-Number(input.min))/(Number(input.max)-Number(input.min));
        sliderThumb ||= {};
        const isPressed=pressed===input;
        const value=spring(sliderThumb,{x:bounds.x+12+fraction*(bounds.width-24),y:bounds.y+bounds.height/2,w:isPressed?32:24,h:isPressed?28:20},dt,true);
        const trail=input===mergeTarget?cursorTrail({left:value.x-value.w/2,right:value.x+value.w/2,top:value.y-value.h/2,bottom:value.y+value.h/2}):[0,0,0,0];
        if(trail[2])mergedCursor=true;
        rects.push({...value,radius:12,activity:isPressed?1:.25,tinted:true,trail});
      }
    }
    if(!root)cursorElement?.classList.toggle('is-gpu-free',cursorVisible&&!activeDialog&&!mergedCursor);
    const drawCursor = cursorVisible && root && activeDialog===root && !mergedCursor;
    if (drawCursor) {
      rects.push({x:cursorTarget.x,y:cursorTarget.y,w:24,h:24,radius:12,cursor:true,tinted:true,modalSurface:!!root,activity:pressed ? .7 : .2,blur:0});
    }
    return rects;
  }

  function paint(renderer, rects, time) {
    const {gl,uniforms,target}=renderer;
    const scale=Math.min(devicePixelRatio,1.5);
    const width=Math.round(innerWidth*scale),height=Math.round(innerHeight*scale);
    if(target.width!==width||target.height!==height){target.width=width;target.height=height;}
    gl.viewport(0,0,width,height);gl.disable(gl.SCISSOR_TEST);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    if(renderer.revision!==sceneRevision){
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,renderer.texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,scene);
      gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,renderer.blurredTexture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,blurredScene);
      renderer.revision=sceneRevision;
    }
    gl.uniform2f(uniforms.u_resolution,width,height);gl.uniform1f(uniforms.u_scale,scale);
    gl.uniform2f(uniforms.u_pointer,pointer.x,pointer.y);gl.uniform1f(uniforms.u_time,reducedMotion.matches?0:time/1000);
    const lightAmount=themeFade ? themeFade.fromLight+(themeFade.toLight-themeFade.fromLight)*themeFade.progress : Number(document.documentElement.dataset.theme==='light');
    for(const rect of rects){
      gl.uniform4f(uniforms.u_rect,rect.x,rect.y,rect.w,rect.h);gl.uniform1f(uniforms.u_radius,rect.radius);
      const trail=rect.trail||[0,0,0,0];gl.uniform4fv(uniforms.u_trail,trail);
      const darkTint=rect.cursor?[.7,.9,1,.08]:rect.dialog?[.03,.08,.14,.35]:rect.details?[.03,.1,.14,.58]:rect.panel?[.02,.065,.12,.52]:rect.tinted?[.5,.82,.94,.18]:[.025,.075,.13,.22];
      const lightTint=rect.cursor?[.65,.84,1,.07]:rect.dialog?[.99,1,1,.4]:rect.details?[.98,.99,1,.62]:rect.panel?[.98,.99,1,.5]:rect.tinted?[.35,.72,.95,.26]:[1,1,1,.42];
      const tint=darkTint.map((value,index)=>value+(lightTint[index]-value)*lightAmount);
      const transparency=Math.max(0,Math.min(1,parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--glass-transparency'))||0));
      tint[3] *= 1 - transparency;
      gl.uniform4fv(uniforms.u_tint,tint);gl.uniform1f(uniforms.u_activity,rect.activity||0);gl.uniform1f(uniforms.u_strength,rect.cursor?2.1:rect.panel?2.35:1.7);
      gl.uniform1f(uniforms.u_blur,rect.blur||0);
      gl.uniform1f(uniforms.u_glow,rect.cursor ? .55-.2*lightAmount : 1+((rect.modalSurface ? .24 : .52)-1)*lightAmount);
      gl.uniform1f(uniforms.u_opacity,rect.cursor ? .82 : 1+((rect.details ? .88 : rect.modalSurface ? .42 : 1)-1)*lightAmount);
      gl.uniform1f(uniforms.u_cursor,rect.cursor ? 1 : 0);
      gl.uniform1f(uniforms.u_cursor_contrast,rect.cursor ? lightAmount : 0);
      gl.enable(gl.SCISSOR_TEST);
      const minX=Math.min(rect.x-rect.w/2,trail[2]?trail[0]-trail[2]/2:rect.x-rect.w/2)-3;
      const maxX=Math.max(rect.x+rect.w/2,trail[2]?trail[0]+trail[2]/2:rect.x+rect.w/2)+3;
      const minY=Math.min(rect.y-rect.h/2,trail[2]?trail[1]-trail[3]/2:rect.y-rect.h/2)-3;
      const maxY=Math.max(rect.y+rect.h/2,trail[2]?trail[1]+trail[3]/2:rect.y+rect.h/2)+3;
      const left=Math.max(0,Math.floor(minX*scale));
      const bottom=Math.max(0,Math.floor((innerHeight-maxY)*scale));
      gl.scissor(left,bottom,Math.ceil((maxX-minX)*scale),Math.ceil((maxY-minY)*scale));
      gl.drawArrays(gl.TRIANGLES,0,6);
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  function refreshNodes() {
    surfaceNodes=[...document.querySelectorAll(surfaces)];sceneDirty=true;
    for(const node of surfaceNodes)node.classList.add('liquid-surface');
  }

  function animate(time, force=false) {
    if(!force)frame=requestAnimationFrame(animate);
    const video=document.getElementById('viewer-video');
    const videoPlaying=activeDialog?.id==='viewer'&&!video.hidden&&!video.paused&&video.readyState>=2;
    const busy=time-lastInteraction<1400||sceneDirty||videoPlaying;
    if(!running||(!force&&(document.hidden||time-lastPaint<(reducedMotion.matches?250:themeFade?32:videoPlaying?33:busy?16:150))))return;
    const dt=Math.min(.032,(time-lastTick)/1000||.016);lastTick=time;lastPaint=time;
    updateCursor();
    const dialog=[...document.querySelectorAll('dialog[open]')].at(-1)||null;
    if(dialog!==activeDialog){activeDialog=dialog;syncCursorLayer(dialog);sceneDirty=true;}
    if(videoPlaying)sceneDirty=true;
    if(sceneDirty||lastTheme!==document.documentElement.dataset.theme)captureScene();
    else if(themeFade)blendTheme(time);
    paint(program,rectangles(null,dt),time);
    if(modalCanvas&&activeDialog){
      // Top-layer dialogs need their own canvas; they cannot use the body's canvas.
      if(modalCanvas.target.parentNode!==activeDialog)activeDialog.prepend(modalCanvas.target);
      const bounds=activeDialog.getBoundingClientRect();
      modalCanvas.target.style.left=`${-bounds.left}px`;
      modalCanvas.target.style.top=`${-bounds.top}px`;
      if(modalCanvas.target.hidden)modalCanvas.target.hidden=false;
      paint(modalCanvas,rectangles(activeDialog,dt),time);
    }else if(modalCanvas&&!modalCanvas.target.hidden)modalCanvas.target.hidden=true;
    diagnostics.frames++;diagnostics.surfaces=surfaceNodes.length;
  }

  function installMotion() {
    document.addEventListener('pointermove',event=>{cursorTarget={x:event.clientX,y:event.clientY};cursorVisible=true;pointer={x:event.clientX,y:event.clientY};if(cursorElement){const bounds=activeDialog?.getBoundingClientRect();cursorElement.style.left=`${event.clientX-(bounds?.left||0)}px`;cursorElement.style.top=`${event.clientY-(bounds?.top||0)}px`;cursorElement.classList.add('is-visible');}hover=event.target.closest('.liquid-surface, #thumb-size');lastInteraction=performance.now();});
    document.addEventListener('pointerover',()=>{cursorVisible=true;});
    document.addEventListener('pointerout',event=>{if(!event.relatedTarget)cursorVisible=false;});
    document.addEventListener('pointerdown',event=>{pressed=event.target.closest('button,input');pressed?.classList.add('is-pressed');cursorElement?.classList.add('is-pressed');diagnostics.animations++;lastInteraction=performance.now();});
    document.addEventListener('pointerup',()=>{pressed?.classList.remove('is-pressed');pressed=null;cursorElement?.classList.remove('is-pressed');});
    document.addEventListener('pointercancel',()=>{pressed?.classList.remove('is-pressed');pressed=null;cursorElement?.classList.remove('is-pressed');});
    document.addEventListener('input',()=>{sceneDirty=true;lastInteraction=performance.now();});
    document.addEventListener('scroll',()=>{sceneDirty=true;lastInteraction=performance.now();},true);
    document.addEventListener('load',()=>{sceneDirty=true;},true);
    for(const event of ['loadeddata','seeked'])document.getElementById('viewer-video').addEventListener(event,()=>{sceneDirty=true;});
    window.addEventListener('resize',()=>{sceneDirty=true;lastInteraction=performance.now();});
    document.addEventListener('visibilitychange',()=>{lastTick=performance.now();sceneDirty=true;});
    for(const dialog of document.querySelectorAll('dialog')) {
      const show=dialog.showModal.bind(dialog),close=dialog.close.bind(dialog);
      let closing=null;
      dialog.showModal=()=>{if(closing){clearTimeout(closing);closing=null;}if(dialog.open)return;show();activeDialog=dialog;syncCursorLayer(dialog);dialog.getAnimations().forEach(animation=>animation.cancel());sceneDirty=true;refreshNodes();if(!reducedMotion.matches){dialog.animate([{opacity:0,transform:'translateY(18px) scale(.965)'},{opacity:1,transform:'translateY(0) scale(1)'}],{duration:360,easing:'cubic-bezier(.2,.85,.2,1)'});diagnostics.animations++;}};
      const finishClose=value=>{
        close(value);closing=null;
        activeDialog=[...document.querySelectorAll('dialog[open]')].at(-1)||null;
        syncCursorLayer(activeDialog);
        sceneDirty=true;
        if(diagnostics.ready)animate(performance.now(),true);
      };
      dialog.addEventListener('close',()=>{activeDialog=[...document.querySelectorAll('dialog[open]')].at(-1)||null;syncCursorLayer(activeDialog);sceneDirty=true;if(diagnostics.ready)animate(performance.now(),true);});
      dialog.close=value=>{
        if(!dialog.open)return;
        if(reducedMotion.matches){finishClose(value);return;}
        // Fade the panel and its backdrop together, so closing never snaps shut.
        dialog.animate([{opacity:1,transform:'translateY(0) scale(1)'},{opacity:0,transform:'translateY(9px) scale(.988)'}],{duration:200,easing:'cubic-bezier(.4,0,.7,.4)',fill:'forwards'});
        try{dialog.animate([{opacity:1},{opacity:0}],{duration:200,easing:'ease-out',pseudoElement:'::backdrop'});}catch(error){}
        closing=setTimeout(()=>finishClose(value),195);
      };
    }
    new MutationObserver(records=>{if(records.some(record=>record.type==='childList'||record.attributeName==='hidden'||record.attributeName==='open'||record.attributeName==='aria-selected'))refreshNodes();}).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','open','aria-selected']});
    new MutationObserver(()=>{if(document.documentElement.classList.contains('theme-capture'))return;beginThemeFade();sceneDirty=true;}).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  }

  async function init() {
    installMotion();
    cursorElement=document.getElementById('glass-cursor');
    try {
      const [vertex,fragment]=await Promise.all([shaderSource('liquid.vert'),shaderSource('liquid.frag')]);
      canvas=document.getElementById('liquid-canvas');
      program=makeRenderer(canvas,vertex,fragment);
      scene=document.createElement('canvas');ctx=scene.getContext('2d',{alpha:false});
      blurredScene=document.createElement('canvas');blurCtx=blurredScene.getContext('2d',{alpha:false});
      const modal=document.createElement('canvas');modal.className='liquid-canvas modal-liquid-canvas';modal.setAttribute('aria-hidden','true');
      modalCanvas=makeRenderer(modal,vertex,fragment);
      canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();running=false;document.documentElement.classList.remove('liquid-ready');diagnostics.ready=false;});
      canvas.addEventListener('webglcontextrestored',()=>location.reload());
      refreshNodes();document.documentElement.classList.add('liquid-ready');
      diagnostics.ready=true;diagnostics.backend='webgl2';requestAnimationFrame(animate);
    }catch(error){diagnostics.error=String(error);console.warn('Liquid glass fallback:',error);refreshNodes();}
  }
  document.addEventListener('DOMContentLoaded',init);
})();
