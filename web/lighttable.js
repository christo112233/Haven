'use strict';
/*
 * 观片台 (light table) — a session-only darkroom for laying photos on a lit board.
 *
 * The interaction model (dark room, lit board, loose placement, lamp timing,
 * loupe, space-to-look-closer) is inspired by the macOS app 观片台 / LightTable
 * (MIT, Copyright (c) 2026 fuyuan9972-svg). This file is an independent
 * JavaScript implementation for Haven's web frontend; no LightTable asset,
 * binary, audio file or model is used. See THIRD_PARTY_NOTICES.md.
 *
 * Nothing here is persisted: closing the app discards the board, by design.
 */
(function () {
  const NORMAL_LENS = 260;
  const NORMAL_MAG = 1.5;
  const EIGHT_MAG = 8;
  const NORMAL_FIELD = NORMAL_LENS / NORMAL_MAG;
  const MAX_PREVIEWS = 8;
  const BAR_RESERVE = 128;

  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const smoothstep = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
  const quintic = (x) => { const t = clamp(x, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };
  const easeInOut = (x) => { const t = clamp(x, 0, 1); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
  const easeOutCubic = (x) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
  // Slight overshoot so the photo settles instead of snapping flat.
  const easeOutBack = (x) => { const t = clamp(x, 0, 1) - 1; return 1 + 2.4 * t * t * t + 1.4 * t * t; };

  const state = {
    items: [], open: false, selected: null,
    lampOn: true, brightness: 1, temperature: 5000,
    loupe: false, closeUp: false, spaceLoupe: false, magnify: 'eight',
    pointer: null, inside: false, overUI: false, lensD: NORMAL_LENS,
    closeBlend: 0, field: NORMAL_FIELD, backingD: NORMAL_LENS,
    drag: null, lastTap: null, z: 1,
    arrangeRaf: 0, arrangeEntries: null, layoutStyle: null,
    lampRaf: 0, lensRaf: 0, drawRaf: 0,
    dpr: 1, area: { x: 0, y: 0, w: 0, h: 0 },
    lastW: 0, lastH: 0, previews: new Map()
  };
  let els = null;

  function samePath(a, b) {
    return String(a || '').replace(/[\\/]+$/, '').toLowerCase() === String(b || '').replace(/[\\/]+$/, '').toLowerCase();
  }

  function baseName(path) {
    const parts = String(path || '').split(/[\\/]/);
    return parts[parts.length - 1] || String(path || '');
  }

  function itemByPath(path) {
    return state.items.find((item) => samePath(item.path, path)) || null;
  }

  /* --------------------------------------------------------------- prefs */
  // Device-local look settings ride in Haven's settings file, not the shared
  // library: the lamp, its brightness and the sound switch belong to a machine.

  let pendingSettings = null;
  let brightnessTimer = 0;
  let spaceLoupeTimer = 0;

  function saveSettings(patch) {
    if (typeof api !== 'function') return;
    try {
      const result = api('settings', patch);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (error) { /* an older backend simply keeps the session value */ }
  }

  function applySettings(settings) {
    if (!settings) return;
    if (typeof settings.lighttable_lamp === 'boolean') state.lampOn = settings.lighttable_lamp;
    const brightness = Number(settings.lighttable_brightness);
    if (Number.isFinite(brightness)) state.brightness = clamp(brightness, 0.2, 1.6);
    if (typeof settings.lighttable_sound === 'boolean') state.sound = settings.lighttable_sound;
    const temperature = Number(settings.lighttable_temperature);
    if (Number.isFinite(temperature)) state.temperature = clamp(temperature, 3000, 6500);
    if (settings.lighttable_magnify === "eight" || settings.lighttable_magnify === "original") {
      state.magnify = settings.lighttable_magnify;
    }
    if (!els) {
      pendingSettings = settings;
      return;
    }
    if (els.bar) els.bar.addEventListener('click', () => {
      const active = document.activeElement;
      if (active && active !== document.body && els.bar.contains(active)) active.blur();
    });
    if (els.brightness) els.brightness.value = String(Math.round(state.brightness * 100));
    applyTemperature();
    syncLamp();
    syncSound();
    if (state.open) {
      applyLamp(state.lampOn ? 1.1 : -1);
      if (els.hint) els.hint.textContent = t('web.lighttable.hint');
    }
  }

  /* --------------------------------------------------------------- audio */
  // Small UI sounds are synthesised with Web Audio so Haven ships no audio
  // assets and inherits no third-party audio licence.

  let audioEngine = null;

  function audioContext() {
    if (audioEngine === false) return null;
    if (!audioEngine) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        audioEngine = false;
        return null;
      }
      try {
        audioEngine = new Ctx();
      } catch (error) {
        audioEngine = false;
        return null;
      }
    }
    if (audioEngine.state === 'suspended') audioEngine.resume().catch(() => {});
    return audioEngine;
  }

  function noiseHit(context, at, frequency, quality, level, duration, decay) {
    const length = Math.max(1, Math.ceil(context.sampleRate * duration));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index++) {
      const progress = index / length;
      data[index] = (Math.random() * 2 - 1) * Math.pow(1 - progress, decay || 3.4);
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = quality;
    const gain = context.createGain();
    gain.gain.setValueAtTime(Math.max(0.0001, level), at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(context.destination);
    source.start(at);
    source.stop(at + duration + 0.012);
  }

  function toneHit(context, at, from, to, level, duration, type) {
    const oscillator = context.createOscillator();
    oscillator.type = type || 'sine';
    oscillator.frequency.setValueAtTime(Math.max(1, from), at);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + duration);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, level), at + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + duration + 0.012);
  }

  function playClick() {
    if (!state.sound) return;
    const context = audioContext();
    if (!context || context.state === 'closed') return;
    const at = context.currentTime + 0.002;
    noiseHit(context, at, 2800, 1.5, 0.030, 0.030, 4.2);
    toneHit(context, at, 520, 430, 0.009, 0.030, 'triangle');
  }

  function playTick() {
    if (!state.sound) return;
    const context = audioContext();
    if (!context || context.state === 'closed') return;
    const at = context.currentTime + 0.002;
    noiseHit(context, at, 3200, 1.8, 0.020, 0.022, 4.6);
    toneHit(context, at, 880, 760, 0.006, 0.024, 'triangle');
  }

  function playPick() {
    if (!state.sound) return;
    const context = audioContext();
    if (!context || context.state === 'closed') return;
    const at = context.currentTime + 0.002;
    noiseHit(context, at, 2600, 1.2, 0.018, 0.034, 4.6);
    toneHit(context, at, 430, 620, 0.007, 0.040, 'sine');
  }

  function playPlace() {
    if (!state.sound) return;
    const context = audioContext();
    if (!context || context.state === 'closed') return;
    const at = context.currentTime + 0.002;
    noiseHit(context, at, 760, 0.9, 0.026, 0.038, 4.0);
    toneHit(context, at, 180, 104, 0.026, 0.085, 'sine');
  }

  function playShuffle() {
    if (!state.sound) return;
    const context = audioContext();
    if (!context || context.state === 'closed') return;
    const at = context.currentTime + 0.002;
    noiseHit(context, at, 1350, 0.6, 0.030, 0.20, 1.5);
    noiseHit(context, at + 0.07, 950, 0.55, 0.020, 0.17, 1.7);
  }

  function playSwitch(on) {
    if (!state.sound) return;
    const context = audioContext();
    if (!context || context.state === 'closed') return;
    const at = context.currentTime + 0.002;
    if (on) {
      noiseHit(context, at, 1600, 0.85, 0.075, 0.050, 3.2);
      toneHit(context, at, 118, 66, 0.055, 0.16, 'sine');
      noiseHit(context, at + 0.055, 1050, 0.70, 0.038, 0.045, 4.0);
      noiseHit(context, at + 0.012, 3400, 2.2, 0.013, 0.018, 5.0);
    } else {
      noiseHit(context, at, 1050, 0.75, 0.055, 0.055, 3.4);
      toneHit(context, at, 96, 52, 0.045, 0.13, 'sine');
    }
  }

  function refreshArea() {
    const w = innerWidth;
    const h = innerHeight;
    let area = { x: w * 0.05, y: h * 0.07, w: w * 0.9, h: Math.max(160, h - h * 0.07 - BAR_RESERVE) };
    const board = els && els.board ? els.board.getBoundingClientRect() : null;
    if (board && board.width > 60 && board.height > 60) {
      const pad = Math.max(14, Math.min(28, Math.min(board.width, board.height) * 0.03));
      area = {
        x: board.left + pad,
        y: board.top + pad,
        w: board.width - pad * 2,
        h: board.height - pad * 2
      };
    }
    state.area = area;
    state.dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);
  }

  let badgeValue = 0;
  let badgeTimer = 0;

  function syncCount() {
    if (!els) return;
    const count = state.items.length;
    if (els.count) els.count.textContent = t('web.lighttable.count', { count });
    const badge = document.getElementById('lighttable-count');
    if (badge) {
      const previous = badgeValue;
      badgeValue = count;
      clearTimeout(badgeTimer);
      badge.classList.remove('is-new', 'is-bump', 'is-out');
      if (count === 0) {
        if (previous === 0 || reduceMotion()) {
          badge.hidden = true;
          badge.textContent = '0';
        } else {
          badge.textContent = '0';
          badge.hidden = false;
          void badge.offsetWidth;
          badge.classList.add('is-out');
          badgeTimer = setTimeout(() => {
            badge.hidden = true;
            badge.classList.remove('is-out');
          }, 240);
        }
      } else {
        badge.textContent = String(count);
        badge.hidden = false;
        if (!reduceMotion()) {
          void badge.offsetWidth;
          badge.classList.add(previous === 0 ? 'is-new' : 'is-bump');
        }
      }
    }
    renderEmpty();
  }

  function renderEmpty() {
    if (!els) return;
    if (els.empty) els.empty.hidden = state.items.length > 0;
  }

  function syncLamp() {
    if (!els || !els.lamp) return;
    els.lamp.setAttribute('aria-pressed', String(state.lampOn));
    els.lampLabel.textContent = state.lampOn ? t('web.lighttable.lamp-off') : t('web.lighttable.lamp-on');
    els.lamp.title = state.lampOn ? t('web.lighttable.lamp-off') : t('web.lighttable.lamp-on');
  }

  function syncLoupe() {
    if (!els) return;
    if (els.loupeToggle) els.loupeToggle.setAttribute('aria-pressed', String(state.loupe));
    if (els.mag) els.mag.hidden = !state.loupe;
    for (const button of (els.mag ? els.mag.querySelectorAll('[data-mag]') : [])) {
      button.setAttribute('aria-pressed', String(button.dataset.mag === state.magnify));
    }
    if (!state.loupe) {
      cancelAnimationFrame(state.drawRaf);
      state.drawRaf = 0;
      hideLens();
    }
  }

  function syncSound() {
    if (!els || !els.sound) return;
    els.sound.setAttribute('aria-pressed', String(state.sound));
    els.sound.classList.toggle('is-muted', !state.sound);
    const label = state.sound ? t('web.lighttable.sound-mute') : t('web.lighttable.sound-unmute');
    els.sound.title = label;
    els.sound.setAttribute('aria-label', label);
  }

  /* ---------------------------------------------------------------- items */

  function add(items) {
    const incoming = Array.isArray(items) ? items : (items ? [items] : []);
    const added = [];
    for (const raw of incoming) {
      const path = typeof raw === 'string' ? raw : raw && raw.path;
      if (!path || state.items.some((item) => samePath(item.path, path))) continue;
      state.items.push({
        path,
        name: (raw && raw.name) || baseName(path),
        aspect: 1.5,
        layout: null,
        el: null,
        img: null,
        z: 0
      });
      added.push(path);
    }
    if (!added.length) {
      if (incoming.length) toast(t('web.lighttable.already'));
      return 0;
    }
    if (state.open) {
      for (const item of state.items) if (!item.el) ensurePhoto(item);
      layoutMissing();
      for (const item of state.items) apply(item);
    }
    syncCount();
    toast(t('web.lighttable.added', { count: added.length }));
    return added.length;
  }

  function removeItem(item) {
    if (!item) return;
    dropFromArrangement(item);
    const index = state.items.indexOf(item);
    if (index < 0) return;
    state.items.splice(index, 1);
    if (item.el) item.el.remove();
    if (samePath(state.selected, item.path)) select(null);
    syncCount();
  }

  async function clearAll() {
    if (!state.items.length) return;
    const confirmed = await confirmAction(t('web.lighttable.clear-title'), t('web.lighttable.clear-body'));
    if (!confirmed) return;
    stopArranging();
    for (const item of state.items) if (item.el) item.el.remove();
    state.items = [];
    state.selected = null;
    state.previews.clear();
    syncCount();
    toast(t('web.lighttable.cleared'));
  }

  function ensurePhoto(item) {
    if (item.el) return item.el;
    const el = document.createElement('div');
    el.className = 'lt-photo';
    el.dataset.path = item.path;
    el.style.aspectRatio = String(item.aspect);
    el.setAttribute('role', 'listitem');
    el.setAttribute('aria-label', item.name);

    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    img.addEventListener('load', () => {
      if (!img.naturalWidth || !img.naturalHeight) return;
      item.aspect = img.naturalWidth / img.naturalHeight;
      el.style.aspectRatio = String(item.aspect);
      fitItem(item);
    });
    img.src = mediaURL({ path: item.path }, 'thumb');

    const rotate = document.createElement('span');
    rotate.className = 'lt-handle lt-rotate';
    rotate.setAttribute('aria-hidden', 'true');
    const resize = document.createElement('span');
    resize.className = 'lt-handle lt-resize';
    resize.setAttribute('aria-hidden', 'true');

    el.append(img, rotate, resize);
    els.stage.append(el);
    item.el = el;
    item.img = img;
    upgradeImage(item);
    return el;
  }

  function upgradeImage(item) {
    const display = new Image();
    display.decoding = 'async';
    display.onload = () => {
      if (!item.el) return;
      if (display.naturalWidth && display.naturalHeight) {
        item.aspect = display.naturalWidth / display.naturalHeight;
        item.el.style.aspectRatio = String(item.aspect);
        fitItem(item);
      }
      item.img.src = display.src;
      item.el.dataset.tier = 'display';
    };
    display.onerror = () => {
      // Older builds without the display tier: fall back to the preview once.
      const preview = new Image();
      preview.onload = () => {
        if (!item.el) return;
        if (preview.naturalWidth && preview.naturalHeight) {
          item.aspect = preview.naturalWidth / preview.naturalHeight;
          item.el.style.aspectRatio = String(item.aspect);
        }
        item.img.src = preview.src;
        item.el.dataset.tier = 'preview';
      };
      preview.src = mediaURL({ path: item.path }, 'preview');
    };
    display.src = mediaURL({ path: item.path }, 'display');
  }

  /* --------------------------------------------------------------- layout */

  function defaultWidth() {
    return clamp(Math.min(state.area.w, state.area.h) * 0.32, 150, 620);
  }

  function displayAspect(item) {
    return item.frameAspect || item.aspect || 1.5;
  }

  function itemRect(item) {
    const layout = item.layout;
    if (!layout) return null;
    const height = layout.w / displayAspect(item);
    return { x: layout.x - layout.w / 2, y: layout.y - height / 2, w: layout.w, h: height };
  }

  function overlaps(box, items, pad) {
    for (const other of items) {
      const rect = itemRect(other);
      if (!rect) continue;
      if (Math.abs((rect.x + rect.w / 2) - (box.x + box.w / 2)) < (rect.w + box.w) / 2 + pad &&
          Math.abs((rect.y + rect.h / 2) - (box.y + box.h / 2)) < (rect.h + box.h) / 2 + pad) return true;
    }
    return false;
  }

  function layoutGrid() {
    const area = state.area;
    const total = state.items.length;
    if (!total) return;
    if (total === 1) {
      const item = state.items[0];
      const width = clamp(Math.min(area.w * 0.52, area.h * 0.66), 150, 760);
      if (!item.layout) {
        item.layout = {
          x: area.x + area.w / 2,
          y: area.y + area.h / 2,
          w: width,
          angle: (Math.random() - 0.5) * 3.6
        };
        item.z = ++state.z;
      }
      return;
    }
    const columns = Math.max(1, Math.round(Math.sqrt(total * area.w / area.h)));
    const rows = Math.ceil(total / columns);
    const cellW = area.w / columns;
    const cellH = area.h / rows;
    const base = clamp(Math.min(cellW * 0.82, cellH * 0.82 * 1.42), 120, 560);
    state.items.forEach((item, index) => {
      if (item.layout) return;
      const row = Math.floor(index / columns);
      const column = index % columns;
      const inRow = Math.min(columns, total - row * columns);
      const offset = ((columns - inRow) * cellW) / 2;
      const width = clamp(base * (0.94 + Math.random() * 0.12), 120, area.w * 0.8);
      const height = width / (item.aspect || 1.5);
      const x = area.x + offset + cellW * (column + 0.5) + (Math.random() - 0.5) * Math.min(26, cellW * 0.14);
      const y = area.y + cellH * (row + 0.5) + (Math.random() - 0.5) * Math.min(26, cellH * 0.16);
      item.layout = {
        x: clamp(x, area.x + width / 2, area.x + area.w - width / 2),
        y: clamp(y, area.y + height / 2, area.y + area.h - height / 2),
        w: width,
        angle: (Math.random() - 0.5) * 6.4
      };
      item.z = ++state.z;
    });
  }

  function placeNew(item) {
    const area = state.area;
    const width = defaultWidth() * (0.94 + Math.random() * 0.12);
    const height = width / (item.aspect || 1.5);
    for (let attempt = 0; attempt < 90; attempt++) {
      const x = area.x + width / 2 + Math.random() * Math.max(1, area.w - width);
      const y = area.y + height / 2 + Math.random() * Math.max(1, area.h - height);
      const box = { x: x - width / 2, y: y - height / 2, w: width, h: height };
      if (!overlaps(box, state.items.filter((candidate) => candidate !== item), 16)) {
        item.layout = { x, y, w: width, angle: (Math.random() - 0.5) * 6.4 };
        item.z = ++state.z;
        return;
      }
    }
    item.layout = {
      x: area.x + area.w - width / 2 - 14,
      y: area.y + area.h - height / 2 - 14,
      w: width,
      angle: (Math.random() - 0.5) * 4
    };
    item.z = ++state.z;
  }

  function layoutMissing() {
    if (!state.items.length) return;
    const missing = state.items.filter((item) => !item.layout);
    if (!missing.length) return;
    if (missing.length === state.items.length) layoutGrid();
    else for (const item of missing) placeNew(item);
  }

  /* ------------------------------------------------------------- arranging */

  function gapFor(area) {
    return clamp(Math.min(area.w, area.h) * 0.018, 10, 26);
  }

  function meanAspect(items) {
    if (!items.length) return 1.5;
    return items.reduce((sum, item) => sum + (item.aspect || 1.5), 0) / items.length;
  }

  function rowsAtHeight(items, height, width, gap) {
    const rows = [];
    let row = [];
    let used = 0;
    for (const item of items) {
      const itemWidth = height * (item.aspect || 1.5);
      if (row.length && used + gap + itemWidth > width) {
        rows.push(row);
        row = [];
        used = 0;
      }
      used += (row.length ? gap : 0) + itemWidth;
      row.push(item);
    }
    if (row.length) rows.push(row);
    return rows;
  }

  // Rows share one height and are stretched to the full width: the familiar
  // photo-book / contact-sheet rhythm.
  function justifiedTargets(items, area, gap) {
    if (!items.length) return [];
    if (items.length === 1) {
      const item = items[0];
      const aspect = item.aspect || 1.5;
      const width = Math.min(area.w * 0.7, area.h * 0.8 * aspect);
      return [{ item, x: area.x + area.w / 2, y: area.y + area.h / 2, w: width, angle: 0 }];
    }
    const average = meanAspect(items);
    const guess = clamp(Math.round(Math.sqrt(items.length * area.w / (area.h * average))), 1, items.length);
    let best = null;
    for (let rows = Math.max(1, guess - 2); rows <= Math.min(items.length, guess + 2); rows++) {
      const height = (area.h - gap * (rows - 1)) / rows;
      if (height < 36) continue;
      const packed = rowsAtHeight(items, height, area.w, gap);
      if (!packed.length) continue;
      const heights = [];
      const widths = [];
      packed.forEach((row, index) => {
        const last = index === packed.length - 1;
        const sumAspect = row.reduce((sum, item) => sum + (item.aspect || 1.5), 0);
        const naturalWidth = height * sumAspect + gap * (row.length - 1);
        if (last && packed.length > 1 && naturalWidth < area.w * 0.82) {
          heights.push(height);
          widths.push(naturalWidth);
        } else {
          const rowWidth = area.w - gap * (row.length - 1);
          heights.push(rowWidth / sumAspect);
          widths.push(area.w);
        }
      });
      const totalHeight = heights.reduce((sum, value) => sum + value, 0) + gap * (packed.length - 1);
      const overflow = totalHeight > area.h + 0.5 ? 3 : 0;
      const fill = Math.abs(totalHeight / area.h - 1) * 3;
      const orphan = packed.length > 1 && packed[packed.length - 1].length === 1 && items.length > 4 ? 1.5 : 0;
      const rowGap = Math.abs(packed.length - guess) * 0.6;
      const giant = heights.some((value) => value > area.h * 0.44) ? 1.6 : 0;
      const score = fill + overflow + orphan + rowGap + giant;
      if (!best || score < best.score) best = { packed, heights, widths, score };
    }
    if (!best) return pouredTargets(items, area, gap);
    const totalHeight = best.heights.reduce((sum, value) => sum + value, 0) + gap * (best.packed.length - 1);
    const scale = Math.min(1, area.h / totalHeight);
    const targets = [];
    let y = area.y + (area.h - totalHeight * scale) / 2;
    best.packed.forEach((row, index) => {
      const rowHeight = best.heights[index] * scale;
      const rowWidth = best.widths[index] * scale;
      let x = area.x + (area.w - rowWidth) / 2;
      for (const item of row) {
        const width = rowHeight * (item.aspect || 1.5);
        targets.push({ item, x: x + width / 2, y: y + rowHeight / 2, w: width, angle: 0 });
        x += width + gap * scale;
      }
      y += rowHeight + gap * scale;
    });
    return targets;
  }

  // One hero photo on the left, the rest arranged in a column on the right.
  function heroTargets(items, area, gap, hero) {
    if (!hero || items.length === 1) return justifiedTargets(items, area, gap);
    const rest = items.filter((item) => item !== hero);
    const ratio = rest.length <= 2 ? 0.58 : 0.56;
    const heroArea = { x: area.x, y: area.y, w: area.w * ratio - gap / 2, h: area.h };
    const restArea = { x: area.x + area.w * ratio + gap / 2, y: area.y, w: area.w * (1 - ratio) - gap / 2, h: area.h };
    const aspect = hero.aspect || 1.5;
    const width = Math.min(heroArea.w, heroArea.h * aspect);
    const targets = [{ item: hero, x: heroArea.x + heroArea.w / 2, y: heroArea.y + heroArea.h / 2, w: width, angle: 0 }];
    return targets.concat(justifiedTargets(rest, restArea, gap * 0.85));
  }

  // Contact sheet: every photo gets the same 3:2 frame, cropped cover-style
  // inside it, laid out on a strict grid.
  const SHEET_ASPECT = 1.5;

  function sheetTargets(items, area, gap) {
    if (!items.length) return [];
    let best = null;
    for (let cols = 1; cols <= items.length; cols++) {
      const rows = Math.ceil(items.length / cols);
      const frameW = (area.w - gap * (cols - 1)) / cols;
      const frameH = frameW / SHEET_ASPECT;
      if (frameW <= 0 || frameH <= 0) continue;
      const totalH = rows * frameH + gap * (rows - 1);
      if (totalH > area.h + 0.5) continue;
      const score = frameW * frameH;
      if (!best || score > best.score) best = { cols, frameW, frameH, score };
    }
    if (!best) {
      // Too many photos for 3:2 frames: scale a single-column grid down.
      const cols = Math.max(1, Math.round(Math.sqrt(items.length * area.w / (area.h * SHEET_ASPECT))));
      const rows = Math.ceil(items.length / cols);
      const frameW = Math.min((area.w - gap * (cols - 1)) / cols, ((area.h - gap * (rows - 1)) / rows) * SHEET_ASPECT);
      best = { cols, frameW, frameH: frameW / SHEET_ASPECT, score: 0 };
    }
    const rows = Math.ceil(items.length / best.cols);
    const totalH = rows * best.frameH + gap * (rows - 1);
    const startY = area.y + (area.h - totalH) / 2;
    const targets = [];
    items.forEach((item, index) => {
      const row = Math.floor(index / best.cols);
      const column = index % best.cols;
      const inRow = Math.min(best.cols, items.length - row * best.cols);
      const offset = ((best.cols - inRow) * (best.frameW + gap)) / 2;
      item.frameAspect = SHEET_ASPECT;
      targets.push({
        item,
        x: area.x + offset + column * (best.frameW + gap) + best.frameW / 2,
        y: startY + row * (best.frameH + gap) + best.frameH / 2,
        w: best.frameW,
        angle: 0
      });
    });
    return targets;
  }

  // Golden-angle spiral: photos seem tossed onto the light table, with gentle
  // overlap and alternating tilt.
  function scatterTargets(items, area, gap) {
    if (!items.length) return [];
    const base = clamp(Math.min(area.w, area.h) * 0.25, 110, 340);
    const centerX = area.x + area.w / 2;
    const centerY = area.y + area.h / 2;
    const radiusX = area.w * 0.38;
    const radiusY = area.h * 0.38;
    const total = items.length;
    return items.map((item, index) => {
      const angle = index * 2.399963229728653;
      const radius = Math.sqrt((index + 0.55) / total);
      const aspect = item.aspect || 1.5;
      let width = clamp(base * (0.84 + Math.random() * 0.32), 90, area.w * 0.9);
      let height = width / aspect;
      if (height > area.h * 0.9) {
        height = area.h * 0.9;
        width = height * aspect;
      }
      let x = centerX + Math.cos(angle) * radiusX * radius + (Math.random() - 0.5) * 20;
      let y = centerY + Math.sin(angle) * radiusY * radius + (Math.random() - 0.5) * 20;
      x = clamp(x, area.x + width / 2, area.x + area.w - width / 2);
      y = clamp(y, area.y + height / 2, area.y + area.h - height / 2);
      const rotation = (index % 2 === 0 ? 1 : -1) * (1 + Math.random() * 2.4);
      return { item, x, y, w: width, angle: rotation };
    });
  }

  // The "just poured out of the sleeve" default used when photos arrive / reset.
  function pouredTargets(items, area, gap) {
    if (!items.length) return [];
    const total = items.length;
    if (total === 1) return justifiedTargets(items, area, gap);
    const columns = Math.max(1, Math.round(Math.sqrt(total * area.w / area.h)));
    const rows = Math.ceil(total / columns);
    const cellW = area.w / columns;
    const cellH = area.h / rows;
    return items.map((item, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const inRow = Math.min(columns, total - row * columns);
      const offset = ((columns - inRow) * cellW) / 2;
      const aspect = item.aspect || 1.5;
      let width = clamp(Math.min(cellW * 0.82, cellH * 0.82 * 1.42) * (0.94 + Math.random() * 0.12), 90, area.w * 0.8);
      let height = width / aspect;
      if (height > cellH * 0.86) {
        height = cellH * 0.86;
        width = height * aspect;
      }
      const x = clamp(area.x + offset + cellW * (column + 0.5) + (Math.random() - 0.5) * Math.min(24, cellW * 0.12), area.x + width / 2, area.x + area.w - width / 2);
      const y = clamp(area.y + cellH * (row + 0.5) + (Math.random() - 0.5) * Math.min(24, cellH * 0.14), area.y + height / 2, area.y + area.h - height / 2);
      return { item, x, y, w: width, angle: (Math.random() - 0.5) * 5.4 };
    });
  }

  function stopArranging() {
    cancelAnimationFrame(state.arrangeRaf);
    state.arrangeRaf = 0;
    state.arrangeEntries = null;
  }

  function dropFromArrangement(item) {
    if (!state.arrangeEntries) return;
    state.arrangeEntries = state.arrangeEntries.filter((entry) => entry.item !== item);
    if (!state.arrangeEntries.length) stopArranging();
  }

  function applyTargets(targets, options) {
    if (!targets.length) return;
    stopArranging();
    const entries = targets.map((target, index) => ({
      item: target.item,
      from: { ...target.item.layout },
      to: { x: target.x, y: target.y, w: target.w, angle: target.angle },
      delay: reduceMotion() ? 0 : Math.min(index * 9, 220)
    }));
    const duration = reduceMotion() ? 0 : (options && options.duration ? options.duration : 480);
    if (!duration) {
      for (const entry of entries) {
        entry.item.layout = { ...entry.to };
        apply(entry.item);
      }
      return;
    }
    const started = performance.now();
    state.arrangeEntries = entries;
    const step = (now) => {
      const active = state.arrangeEntries;
      if (!active || !active.length) {
        state.arrangeRaf = 0;
        return;
      }
      let running = false;
      for (const entry of active) {
        const progress = clamp((now - started - entry.delay) / duration, 0, 1);
        if (progress < 1) running = true;
        const eased = easeInOut(progress);
        const from = entry.from;
        const to = entry.to;
        const delta = ((to.angle - from.angle + 540) % 360) - 180;
        entry.item.layout = {
          x: from.x + (to.x - from.x) * eased,
          y: from.y + (to.y - from.y) * eased,
          w: from.w + (to.w - from.w) * eased,
          angle: from.angle + delta * eased
        };
        apply(entry.item);
      }
      if (running) state.arrangeRaf = requestAnimationFrame(step);
      else {
        state.arrangeRaf = 0;
        state.arrangeEntries = null;
      }
    };
    state.arrangeRaf = requestAnimationFrame(step);
  }

  function arrange(style) {
    closeLayoutMenu();
    if (!state.items.length) return;
    const area = state.area;
    const gap = gapFor(area);
    for (const item of state.items) item.frameAspect = null;
    let targets = [];
    if (style === 'justified') targets = justifiedTargets(state.items, area, gap);
    else if (style === 'hero') {
      const hero = itemByPath(state.selected) || state.items[0];
      targets = heroTargets(state.items, area, gap, hero);
      if (hero) raise(hero);
    } else if (style === 'sheet') targets = sheetTargets(state.items, area, gap);
    else if (style === 'scatter') targets = scatterTargets(state.items, area, gap);
    if (!targets.length) return;
    applyTargets(targets, { duration: 480 });
    state.layoutStyle = style;
    playShuffle();
  }

  function resetLayout() {
    closeLayoutMenu();
    if (!state.items.length) return;
    for (const item of state.items) item.frameAspect = null;
    applyTargets(pouredTargets(state.items, state.area, gapFor(state.area)), { duration: 480 });
    state.layoutStyle = null;
    playShuffle();
  }

  function positionLayoutMenu() {
    if (!els.layout || !els.layoutMenu) return;
    const rect = els.layout.getBoundingClientRect();
    els.layoutMenu.style.left = '0px';
    els.layoutMenu.style.bottom = '0px';
    const measured = els.layoutMenu.getBoundingClientRect();
    const left = clamp(rect.left + rect.width / 2 - measured.width / 2, 12, Math.max(12, innerWidth - measured.width - 12));
    const bottom = clamp(innerHeight - rect.top + 10, 12, Math.max(12, innerHeight - 12));
    els.layoutMenu.style.left = left + 'px';
    els.layoutMenu.style.bottom = bottom + 'px';
  }

  function openLayoutMenu() {
    if (!els.layoutMenu) return;
    els.layoutMenu.hidden = false;
    positionLayoutMenu();
  }

  // Keep the hint clear of the toolbar, whatever width the bar takes in the
  // current language and window size.
  function positionHint() {
    if (!els || !els.hint || !els.bar) return;
    const rect = els.bar.getBoundingClientRect();
    if (!rect.height) return;
    els.hint.style.bottom = Math.round(innerHeight - rect.top + 10) + 'px';
  }

  function closeLayoutMenu() {
    if (els.layoutMenu) els.layoutMenu.hidden = true;
  }

  function toggleLayoutMenu() {
    if (!els.layoutMenu) return;
    if (els.layoutMenu.hidden) openLayoutMenu();
    else closeLayoutMenu();
  }

  function fitItem(item) {
    if (!item.layout) return;
    const area = state.area;
    const aspect = displayAspect(item);
    const maxWidth = Math.min(area.w, area.h * aspect);
    const width = clamp(Math.min(item.layout.w, maxWidth), Math.min(90, maxWidth), maxWidth);
    item.layout.w = width;
    const height = width / aspect;
    item.layout.x = clamp(item.layout.x, area.x + width / 2, area.x + area.w - width / 2);
    item.layout.y = clamp(item.layout.y, area.y + height / 2, area.y + area.h - height / 2);
    apply(item);
  }

  function apply(item) {
    if (!item.el || !item.layout) return;
    const layout = item.layout;
    item.el.style.left = layout.x + 'px';
    item.el.style.top = layout.y + 'px';
    item.el.style.width = layout.w + 'px';
    item.el.style.transform = 'translate(-50%, -50%) rotate(' + layout.angle + 'deg) scale(var(--lt-lift, 1))';
    item.el.style.zIndex = String(item.z);
    const aspect = displayAspect(item);
    item.el.style.aspectRatio = String(aspect);
    item.el.style.height = Math.max(1, Math.round(layout.w / aspect)) + 'px';
    item.el.classList.toggle('framed', Boolean(item.frameAspect));
  }

  const liftFrames = new WeakMap();

  function animateLift(item, target, duration) {
    if (!item.el) return;
    cancelAnimationFrame(liftFrames.get(item) || 0);
    const startValue = item.lift || 1;
    const started = performance.now();
    const step = (now) => {
      const progress = clamp((now - started) / duration, 0, 1);
      const eased = target > startValue ? easeOutCubic(progress) : easeOutBack(progress);
      const value = startValue + (target - startValue) * eased;
      item.lift = value;
      item.el.style.setProperty('--lt-lift', value.toFixed(4));
      if (progress < 1) {
        liftFrames.set(item, requestAnimationFrame(step));
      } else {
        item.lift = target;
        item.el.style.setProperty('--lt-lift', target.toFixed(4));
        liftFrames.delete(item);
      }
    };
    liftFrames.set(item, requestAnimationFrame(step));
  }

  function liftPhoto(item) {
    if (!item || !item.el) return;
    item.el.classList.add('is-lifting');
    playPick();
    animateLift(item, reduceMotion() ? 1 : 1.045, 150);
  }

  function settlePhoto(item, silent) {
    if (!item || !item.el) return;
    item.el.classList.remove('is-lifting');
    if (!silent) playPlace();
    animateLift(item, 1, reduceMotion() ? 1 : 340);
  }

  function applyAll() {
    for (const item of state.items) apply(item);
  }

  function raise(item) {
    item.z = ++state.z;
    if (item.el) item.el.style.zIndex = String(item.z);
  }

  function select(path) {
    state.selected = path || null;
    for (const item of state.items) {
      if (item.el) item.el.classList.toggle('selected', Boolean(state.selected) && samePath(item.path, state.selected));
    }
  }

  function resetItem(item) {
    if (!item.layout) return;
    item.layout.angle = 0;
    item.layout.w = defaultWidth();
    fitItem(item);
    scheduleDraw();
  }

  /* ------------------------------------------------------------- darkroom */

  function panelWhite(power) {
    if (power <= 1) return 0.32 + 0.58 * Math.sqrt(clamp(power, 0.1, 1));
    return 0.90 + (power - 1) * 0.08;
  }

  function applyLamp(tSeconds) {
    let transmission = 0;
    let flare = 0;
    if (state.lampOn) {
      if (tSeconds >= 1.1) {
        transmission = 1;
      } else {
        transmission = smoothstep(tSeconds / 0.12);
        if (tSeconds < 0.16) flare = smoothstep(tSeconds / 0.16);
        else if (tSeconds < 0.28) flare = 1;
        else flare = 1 - quintic((tSeconds - 0.28) / (1.1 - 0.28));
      }
    }
    const power = state.brightness;
    const level = Math.sqrt(clamp(power, 0.1, 1));
    const stops = 0.8 * flare * Math.sqrt(clamp(power, 0.1, 1));
    const photo = (0.16 + 0.84 * level * transmission) * Math.pow(2, 0.42 * stops);
    const panel = 0.05 + 0.95 * panelWhite(power) * transmission;
    const glare = flare * transmission * 0.34;
    const root = els.root;
    root.style.setProperty('--lt-panel', panel.toFixed(4));
    root.style.setProperty('--lt-photo', photo.toFixed(4));
    root.style.setProperty('--lt-flare', glare.toFixed(4));
    root.style.setProperty('--lt-room', (transmission * (0.03 + 0.14 * panel)).toFixed(4));
  }

  const TEMPERATURE_PRESETS = { warm: 3200, neutral: 5000, cool: 6500 };

  function temperatureKind(kelvin) {
    if (kelvin < 4200) return 'warm';
    if (kelvin > 5800) return 'cool';
    return 'neutral';
  }

  function syncTemperature() {
    if (!els || !els.tempLabel) return;
    const name = t('web.lighttable.temp-' + temperatureKind(state.temperature));
    els.tempLabel.textContent = name;
    const label = t('web.lighttable.temp-title', { name });
    if (els.temp) {
      els.temp.title = label;
      els.temp.setAttribute('aria-label', label);
    }
  }

  function applyTemperature() {
    const kelvin = clamp(Number(state.temperature) || 5000, 3000, 6500);
    const warm = clamp((5000 - kelvin) / 1800, 0, 1);
    const cool = clamp((kelvin - 5000) / 1500, 0, 1);
    if (els) {
      const root = els.root;
      const board = {
        r: Math.round(255 - 18 * cool),
        g: Math.round(250 + 2 * cool - 20 * warm),
        b: Math.round(238 + 17 * cool - 44 * warm)
      };
      const glow = {
        r: Math.round(255 - 75 * cool),
        g: Math.round(238 + 8 * cool - 42 * warm),
        b: Math.round(200 + 55 * cool - 70 * warm)
      };
      root.style.setProperty('--lt-board-rgb', board.r + ', ' + board.g + ', ' + board.b);
      root.style.setProperty('--lt-glow-rgb', glow.r + ', ' + glow.g + ', ' + glow.b);
      root.style.setProperty('--lt-sepia', (warm * 0.14).toFixed(3));
      root.style.setProperty('--lt-cool-shift', cool.toFixed(3));
    }
    syncTemperature();
  }

  function setTemperature(kelvin, quiet) {
    const value = clamp(Number(kelvin) || 5000, 3000, 6500);
    if (Math.round(value) === Math.round(state.temperature)) return;
    state.temperature = value;
    saveSettings({ lighttable_temperature: value });
    applyTemperature();
    if (!quiet) playTick();
  }

  function cycleTemperature() {
    const kind = temperatureKind(state.temperature);
    setTemperature(kind === 'warm' ? TEMPERATURE_PRESETS.neutral
      : kind === 'neutral' ? TEMPERATURE_PRESETS.cool
      : TEMPERATURE_PRESETS.warm);
  }

  function setLamp(on, animate) {
    const changed = Boolean(on) !== state.lampOn;
    state.lampOn = Boolean(on);
    syncLamp();
    if (changed) {
      saveSettings({ lighttable_lamp: state.lampOn });
      playSwitch(state.lampOn);
    }
    cancelAnimationFrame(state.lampRaf);
    state.lampRaf = 0;
    if (!state.lampOn) {
      els.root.classList.remove('lt-animating');
      applyLamp(-1);
      return;
    }
    if (!animate || reduceMotion()) {
      els.root.classList.remove('lt-animating');
      applyLamp(1.1);
      return;
    }
    els.root.classList.add('lt-animating');
    const started = performance.now();
    const step = (now) => {
      const elapsed = (now - started) / 1000;
      applyLamp(Math.min(1.1, elapsed));
      if (elapsed < 1.1) {
        state.lampRaf = requestAnimationFrame(step);
      } else {
        state.lampRaf = 0;
        applyLamp(1.1);
        els.root.classList.remove('lt-animating');
      }
    };
    state.lampRaf = requestAnimationFrame(step);
  }

  function open() {
    if (state.open) return;
    refreshArea();
    state.lastW = innerWidth;
    state.lastH = innerHeight;
    state.open = true;
    state.inside = false;
    state.pointer = null;
    els.root.hidden = false;
    refreshArea();
    select(null);
    for (const item of state.items) ensurePhoto(item);
    if (!state.items.some((item) => item.layout)) layoutGrid();
    else layoutMissing();
    applyAll();
    syncCount();
    syncLamp();
    syncLoupe();
    if (els.brightness) els.brightness.value = String(Math.round(state.brightness * 100));
    // Restore the remembered lamp state as-is: the ignition animation and switch
    // sound belong to actually pressing the lamp, not to re-entering a lit table.
    applyLamp(state.lampOn ? 1.1 : -1);
    syncLamp();
    if (els.hint) els.hint.textContent = t('web.lighttable.hint');
    positionHint();
  }

  function close() {
    if (!state.open) return;
    if (state.spaceLoupe) {
      state.loupe = false;
      state.spaceLoupe = false;
      syncLoupe();
    }
    clearTimeout(spaceLoupeTimer);
    spaceLoupeTimer = 0;
    stopArranging();
    closeLayoutMenu();
    state.open = false;
    state.drag = null;
    state.pointer = null;
    state.inside = false;
    cancelAnimationFrame(state.drawRaf);
    state.drawRaf = 0;
    cancelAnimationFrame(state.lampRaf);
    state.lampRaf = 0;
    cancelAnimationFrame(state.lensRaf);
    state.lensRaf = 0;
    state.closeUp = false;
    state.closeBlend = 0;
    state.field = NORMAL_FIELD;
    state.lensD = NORMAL_LENS;
    setBacking(NORMAL_LENS);
    els.root.hidden = true;
    els.root.classList.remove('lt-animating', 'lt-no-cursor');
    hideLens();
    select(null);
  }

  /* --------------------------------------------------------------- pointer */

  function localPoint(event) {
    return { x: event.clientX, y: event.clientY };
  }

  function onPointerDown(event) {
    if (!state.open || event.button !== 0) return;
    // Toolbar, magnifier pill, empty card and the layout menu must not clear
    // the photo selection (the hero layout reads it).
    if (event.target.closest('.lt-bar, #lt-mag, #lt-empty, #lt-layout-menu')) return;
    const photo = event.target.closest('.lt-photo');
    if (!photo) {
      select(null);
      return;
    }
    const item = itemByPath(photo.dataset.path);
    if (!item || !item.layout) return;
    event.preventDefault();
    const point = localPoint(event);
    select(item.path);
    raise(item);
    dropFromArrangement(item);
    const now = performance.now();
    const last = state.lastTap;
    state.lastTap = { path: item.path, time: now, x: point.x, y: point.y };
    if (last && samePath(last.path, item.path) && now - last.time < 340 &&
        Math.hypot(point.x - last.x, point.y - last.y) < 12) {
      state.lastTap = null;
      settlePhoto(item, true);
      resetItem(item);
      scheduleDraw();
      return;
    }
    liftPhoto(item);
    const handle = event.target.closest('.lt-handle');
    const mode = handle ? (handle.classList.contains('lt-rotate') ? 'rotate' : 'scale')
      : (event.shiftKey ? 'rotate' : 'move');
    state.drag = {
      mode,
      item,
      start: point,
      base: { x: item.layout.x, y: item.layout.y, w: item.layout.w, angle: item.layout.angle },
      started: performance.now()
    };
    if (mode === 'rotate') {
      const dx = point.x - item.layout.x;
      const dy = point.y - item.layout.y;
      state.drag.startAngle = Math.atan2(dy, dx) * 180 / Math.PI - item.layout.angle;
    }
    if (mode === 'scale') {
      const dx = point.x - item.layout.x;
      const dy = point.y - item.layout.y;
      state.drag.startDistance = Math.max(6, Math.hypot(dx, dy));
    }
    if (els.root.setPointerCapture) {
      try { els.root.setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
    }
  }

  function onPointerMove(event) {
    if (!state.open) return;
    const point = localPoint(event);
    state.pointer = point;
    state.inside = true;
    state.overUI = Boolean(event.target.closest && event.target.closest('.lt-bar, #lt-mag'));
    if (state.drag) {
      event.preventDefault();
      const item = state.drag.item;
      if (!item.layout) return;
      const base = state.drag.base;
      if (state.drag.mode === 'move') {
        item.layout.x = base.x + point.x - state.drag.start.x;
        item.layout.y = base.y + point.y - state.drag.start.y;
      } else if (state.drag.mode === 'rotate') {
        const angle = Math.atan2(point.y - item.layout.y, point.x - item.layout.x) * 180 / Math.PI;
        item.layout.angle = angle - state.drag.startAngle;
      } else if (state.drag.mode === 'scale') {
        const distance = Math.max(6, Math.hypot(point.x - item.layout.x, point.y - item.layout.y));
        item.layout.w = clamp(base.w * (distance / state.drag.startDistance), 110, Math.max(state.area.w, state.area.h) * 0.92);
      }
      apply(item);
    }
    positionLoupe();
    scheduleDraw();
  }

  function onPointerUp(event) {
    if (!state.drag) return;
    settlePhoto(state.drag.item);
    state.drag = null;
    if (els.root.releasePointerCapture) {
      try { els.root.releasePointerCapture(event.pointerId); } catch (error) { /* ignore */ }
    }
  }

  function onWheel(event) {
    if (!state.open) return;
    const photo = event.target.closest('.lt-photo');
    if (!photo) return;
    const item = itemByPath(photo.dataset.path);
    if (!item || !item.layout) return;
    event.preventDefault();
    dropFromArrangement(item);
    const factor = Math.exp(-event.deltaY * 0.0014);
    item.layout.w = clamp(item.layout.w * factor, 110, Math.max(state.area.w, state.area.h) * 0.92);
    apply(item);
    positionLoupe();
    scheduleDraw();
  }

  function onDoubleClick(event) {
    const photo = event.target.closest('.lt-photo');
    if (!photo) return;
    const item = itemByPath(photo.dataset.path);
    if (item) {
      dropFromArrangement(item);
      resetItem(item);
    }
  }

  function onPointerLeave() {
    state.inside = false;
    state.pointer = null;
    state.overUI = false;
    hideLens();
  }

  /* ----------------------------------------------------------------- loupe */

  function closeLensSize() {
    return Math.max(NORMAL_LENS, Math.min(innerWidth, innerHeight) * 0.94);
  }

  function closeFieldTarget() {
    return state.magnify === 'eight' ? closeLensSize() / EIGHT_MAG : NORMAL_FIELD;
  }

  function lensDiameterFor(blend) {
    return NORMAL_LENS + (closeLensSize() - NORMAL_LENS) * blend;
  }

  function setBacking(diameter) {
    if (!els || !els.loupe) return;
    state.backingD = Math.max(NORMAL_LENS, diameter);
    const size = Math.ceil(state.backingD * state.dpr);
    if (els.loupe.width !== size || els.loupe.height !== size) {
      els.loupe.width = size;
      els.loupe.height = size;
    }
  }

  function clampLensCenter(point, diameter) {
    const radius = diameter / 2;
    const inset = radius + Math.max(8, radius * 0.025);
    return {
      x: clamp(point.x, inset, Math.max(inset, innerWidth - inset)),
      y: clamp(point.y, inset, Math.max(inset, innerHeight - inset))
    };
  }

  let lensVisible = false;
  let lensHiding = false;
  let lensHideTimer = 0;

  function cancelLensHide() {
    clearTimeout(lensHideTimer);
    lensHideTimer = 0;
  }

  function currentLensLook(canvas) {
    const style = getComputedStyle(canvas);
    const opacity = Number(style.opacity);
    let scale = 1;
    const matrix = /matrix\(([^)]+)\)/.exec(style.transform);
    if (matrix) {
      const first = Number(matrix[1].split(',')[0]);
      if (Number.isFinite(first) && first > 0) scale = first;
    }
    return {
      opacity: Number.isFinite(opacity) ? clamp(opacity, 0, 1) : 1,
      scale
    };
  }

  function showLens() {
    if (!els || !els.loupe) return;
    cancelLensHide();
    if (lensVisible) return;
    const canvas = els.loupe;
    const resuming = lensHiding;
    const look = resuming ? currentLensLook(canvas) : { opacity: 0, scale: 0.86 };
    lensVisible = true;
    lensHiding = false;
    canvas.hidden = false;
    if (reduceMotion() || typeof canvas.animate !== 'function') {
      canvas.style.opacity = '';
      canvas.style.transform = '';
      return;
    }
    if (typeof canvas.getAnimations === 'function') {
      for (const animation of canvas.getAnimations()) animation.cancel();
    }
    try {
      canvas.animate(
        [{ opacity: look.opacity, transform: 'scale(' + look.scale + ')' },
         { opacity: 1, transform: 'scale(1)' }],
        { duration: 190, easing: 'cubic-bezier(.2, .85, .25, 1)' }
      );
    } catch (error) { /* animation is cosmetic */ }
  }

  function concealLens() {
    if (!els || !els.loupe) return;
    cancelLensHide();
    const canvas = els.loupe;
    if (!lensVisible) {
      if (!lensHiding) canvas.hidden = true;
      return;
    }
    const look = currentLensLook(canvas);
    lensVisible = false;
    lensHiding = true;
    if (reduceMotion() || typeof canvas.animate !== 'function') {
      lensHiding = false;
      canvas.hidden = true;
      canvas.style.opacity = '';
      canvas.style.transform = '';
      return;
    }
    if (typeof canvas.getAnimations === 'function') {
      for (const animation of canvas.getAnimations()) animation.cancel();
    }
    try {
      const fade = canvas.animate(
        [{ opacity: look.opacity, transform: 'scale(' + look.scale + ')' },
         { opacity: 0, transform: 'scale(0.9)' }],
        { duration: 150, easing: 'ease-in' }
      );
      fade.onfinish = () => {
        lensHiding = false;
        if (!lensVisible) canvas.hidden = true;
      };
      fade.oncancel = () => { lensHiding = false; };
    } catch (error) {
      lensHiding = false;
      canvas.hidden = true;
    }
  }

  function hideLens() {
    if (els) els.root.classList.remove('lt-no-cursor');
    concealLens();
  }

  // A short grace period keeps the lens from blinking when the pointer crosses
  // the gap between two photos.
  function scheduleLensHide() {
    if (!els || !els.loupe || !lensVisible) return;
    if (lensHideTimer) return;
    lensHideTimer = setTimeout(() => {
      lensHideTimer = 0;
      hideLens();
    }, 120);
  }

  function positionLoupe() {
    if (!els.loupe || !state.pointer) return;
    if (!state.open || !state.loupe) {
      hideLens();
      return;
    }
    const diameter = state.lensD;
    const clamped = clampLensCenter(state.pointer, diameter);
    const x = state.pointer.x + (clamped.x - state.pointer.x) * state.closeBlend;
    const y = state.pointer.y + (clamped.y - state.pointer.y) * state.closeBlend;
    els.loupe.style.width = diameter + 'px';
    els.loupe.style.height = diameter + 'px';
    els.loupe.style.left = (x - diameter / 2) + 'px';
    els.loupe.style.top = (y - diameter / 2) + 'px';
  }

  // Lens diameter and sampled field travel on one timeline, so pushing in is a
  // continuous zoom instead of a jump to maximum magnification.
  function trackLens(blendTarget, fieldTarget, duration, easing) {
    cancelAnimationFrame(state.lensRaf);
    state.lensRaf = 0;
    const fromBlend = state.closeBlend;
    const fromField = Math.max(1, state.field);
    const targetDiameter = lensDiameterFor(blendTarget);
    setBacking(Math.max(state.lensD, targetDiameter, NORMAL_LENS));
    const finish = () => {
      state.closeBlend = blendTarget;
      state.field = fieldTarget;
      state.lensD = targetDiameter;
      if (blendTarget === 0) setBacking(NORMAL_LENS);
      positionLoupe();
      scheduleDraw();
    };
    if (reduceMotion() || duration <= 0) {
      finish();
      return;
    }
    const ease = easing || easeInOut;
    const started = performance.now();
    const step = (now) => {
      const progress = clamp((now - started) / (duration * 1000), 0, 1);
      const eased = ease(progress);
      state.closeBlend = fromBlend + (blendTarget - fromBlend) * eased;
      state.field = fromField * Math.pow(fieldTarget / fromField, eased);
      state.lensD = lensDiameterFor(state.closeBlend);
      positionLoupe();
      scheduleDraw();
      if (progress < 1) {
        state.lensRaf = requestAnimationFrame(step);
      } else {
        state.lensRaf = 0;
        finish();
      }
    };
    state.lensRaf = requestAnimationFrame(step);
  }

  function setMagnify(mode) {
    if (!mode || state.magnify === mode) return;
    state.magnify = mode;
    saveSettings({ lighttable_magnify: mode });
    playTick();
    syncLoupe();
    if (state.closeUp) trackLens(1, closeFieldTarget(), 0.26, easeInOut);
    else scheduleDraw();
  }

  function setCloseUp(on) {
    if (!state.loupe) return;
    const next = Boolean(on);
    if (next === state.closeUp) return;
    state.closeUp = next;
    // A lens pushed in: gentle start, soft landing, then eased back out.
    trackLens(next ? 1 : 0, next ? closeFieldTarget() : NORMAL_FIELD,
      next ? 0.46 : 0.36, next ? smoothstep : easeInOut);
  }

  function disableLoupe() {
    clearTimeout(spaceLoupeTimer);
    spaceLoupeTimer = 0;
    if (!state.loupe) return;
    state.loupe = false;
    state.spaceLoupe = false;
    state.closeUp = false;
    state.closeBlend = 0;
    state.field = NORMAL_FIELD;
    state.lensD = NORMAL_LENS;
    cancelAnimationFrame(state.lensRaf);
    state.lensRaf = 0;
    setBacking(NORMAL_LENS);
    syncLoupe();
    hideLens();
    positionLoupe();
    scheduleDraw();
  }

  function scheduleSpaceLoupeOff() {
    if (!state.spaceLoupe) return;
    clearTimeout(spaceLoupeTimer);
    // Let the lens finish shrinking before the temporary magnifier disappears.
    spaceLoupeTimer = setTimeout(() => {
      spaceLoupeTimer = 0;
      if (state.spaceLoupe) disableLoupe();
    }, 420);
  }

  function toggleLoupe() {
    playTick();
    if (state.spaceLoupe) {
      // Keep the magnifier that Space switched on.
      state.spaceLoupe = false;
      clearTimeout(spaceLoupeTimer);
      spaceLoupeTimer = 0;
      syncLoupe();
      return;
    }
    if (state.loupe) {
      disableLoupe();
      return;
    }
    state.loupe = true;
    syncLoupe();
    positionLoupe();
    scheduleDraw();
  }

  function previewFor(item) {
    const cached = state.previews.get(item.path);
    if (cached) {
      state.previews.delete(item.path);
      state.previews.set(item.path, cached);
      return cached.loaded ? cached.image : null;
    }
    while (state.previews.size >= MAX_PREVIEWS) {
      const oldest = state.previews.keys().next().value;
      state.previews.delete(oldest);
    }
    const entry = { image: new Image(), loaded: false };
    entry.image.decoding = 'async';
    entry.image.onload = () => {
      entry.loaded = true;
      scheduleDraw();
    };
    entry.image.src = mediaURL({ path: item.path }, 'preview');
    state.previews.set(item.path, entry);
    return null;
  }

  function hitTest(px, py) {
    let best = null;
    for (const item of state.items) {
      const layout = item.layout;
      if (!layout) continue;
      const dx = px - layout.x;
      const dy = py - layout.y;
      const angle = layout.angle * Math.PI / 180;
      const localX = dx * Math.cos(angle) + dy * Math.sin(angle);
      const localY = -dx * Math.sin(angle) + dy * Math.cos(angle);
      const height = layout.w / displayAspect(item);
      if (Math.abs(localX) <= layout.w / 2 && Math.abs(localY) <= height / 2) {
        if (!best || item.z > best.item.z) best = { item, localX, localY, width: layout.w, height };
      }
    }
    return best;
  }

  function scheduleDraw() {
    if (state.drawRaf) return;
    state.drawRaf = requestAnimationFrame(() => {
      state.drawRaf = 0;
      drawLoupe();
    });
  }

  function drawLoupe() {
    if (!els.loupe) return;
    if (!state.open || !state.loupe || !state.pointer || !state.inside || state.overUI) {
      hideLens();
      return;
    }
    const hit = hitTest(state.pointer.x, state.pointer.y);
    if (!hit) {
      scheduleLensHide();
      return;
    }
    const item = hit.item;
    const source = previewFor(item) || item.img;
    if (!source || !source.naturalWidth || !source.naturalHeight) {
      hideLens();
      return;
    }
    const canvas = els.loupe;
    const size = canvas.width;
    if (!size) return;
    const scaleFactor = size / Math.max(1, state.lensD);
    const radius = size / 2;
    const ctx = canvas.getContext('2d');
    showLens();
    els.root.classList.add('lt-no-cursor');

    const width = hit.width;
    const height = hit.height;
    const naturalWidth = source.naturalWidth;
    const naturalHeight = source.naturalHeight;
    const u = 0.5 + hit.localX / width;
    const v = 0.5 + hit.localY / height;
    // The photo is drawn cover-style inside its frame, so map the pointer
    // through the same scale/offset the browser uses.
    const cover = Math.max(width / naturalWidth, height / naturalHeight);
    const offsetX = (naturalWidth * cover - width) / 2;
    const offsetY = (naturalHeight * cover - height) / 2;
    const sourceX = clamp((u * width + offsetX) / cover, 0, naturalWidth);
    const sourceY = clamp((v * height + offsetY) / cover, 0, naturalHeight);
    const magnification = state.lensD / Math.max(1, state.field);
    const backingPerImage = magnification * cover * scaleFactor;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(radius, radius, radius - 1, 0, Math.PI * 2);
    ctx.clip();
    // The lens sees the lit board around the photo, not a black void.
    const panel = Number.parseFloat(getComputedStyle(els.root).getPropertyValue('--lt-panel')) || 0.9;
    const boardLevel = clamp(panel, 0, 1);
    ctx.fillStyle = 'rgb(' + Math.round(255 * boardLevel) + ',' + Math.round(248 * boardLevel) + ',' + Math.round(235 * boardLevel) + ')';
    ctx.fillRect(0, 0, size, size);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.save();
    ctx.translate(radius, radius);
    ctx.scale(backingPerImage, backingPerImage);
    ctx.translate(-sourceX, -sourceY);
    ctx.drawImage(source, 0, 0);
    ctx.restore();

    // Slight refraction at the rim: redraw the field a touch larger under a ring mask.
    ctx.save();
    ctx.beginPath();
    ctx.arc(radius, radius, radius - 1, 0, Math.PI * 2);
    ctx.arc(radius, radius, radius * 0.93, 0, Math.PI * 2, true);
    ctx.clip('evenodd');
    ctx.globalAlpha = 0.12;
    ctx.translate(radius, radius);
    ctx.scale(backingPerImage * 1.008, backingPerImage * 1.008);
    ctx.translate(-sourceX, -sourceY);
    ctx.drawImage(source, 0, 0);
    ctx.restore();

    // A faint aiming dot replaces the hidden pointer inside the glass.
    ctx.beginPath();
    ctx.arc(radius, radius, Math.max(1.2, scaleFactor * 1.1), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.32)';
    ctx.fill();

    // Warm lamp light mixing into the glass.
    const gloss = ctx.createLinearGradient(0, 0, size, size);
    gloss.addColorStop(0, 'rgba(255, 250, 236, 0.42)');
    gloss.addColorStop(0.30, 'rgba(255, 252, 244, 0.06)');
    gloss.addColorStop(0.62, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = gloss;
    ctx.fillRect(0, 0, size, size);

    const rim = ctx.createRadialGradient(radius, radius, radius * 0.70, radius, radius, radius);
    rim.addColorStop(0, 'rgba(0, 0, 0, 0)');
    rim.addColorStop(0.80, 'rgba(0, 0, 0, 0)');
    rim.addColorStop(0.94, 'rgba(0, 0, 0, 0.30)');
    rim.addColorStop(1, 'rgba(0, 0, 0, 0.66)');
    ctx.fillStyle = rim;
    ctx.fillRect(0, 0, size, size);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = Math.max(1, 1.4 * scaleFactor);
    ctx.beginPath();
    ctx.arc(radius, radius, radius - 1.2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /* -------------------------------------------------------------- keyboard */

  function onKeyDown(event) {
    if (!state.open || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    // Let modal dialogs keep their own keyboard handling.
    if (document.querySelector('dialog[open]')) return;
    // Space must never reach a focused toolbar button (macOS WebKit can fire a
    // click on every repeat, which used to rattle out one sound per repeat).
    if (event.code === 'Space') {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        clearTimeout(spaceLoupeTimer);
        spaceLoupeTimer = 0;
        if (!state.loupe) {
          state.loupe = true;
          state.spaceLoupe = true;
          syncLoupe();
        }
        setCloseUp(true);
      }
      return;
    }
    if (event.repeat) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target && target.closest('input, textarea, select, [contenteditable="true"]')) {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (els.layoutMenu && !els.layoutMenu.hidden) {
        closeLayoutMenu();
        return;
      }
      playClick();
      if (state.closeUp) {
        setCloseUp(false);
        scheduleSpaceLoupeOff();
      } else close();
      return;
    }
    if (event.key.toLowerCase() === 't') {
      event.preventDefault();
      toggleLayoutMenu();
      return;
    }
    if (event.key === 'Tab') {
      if (state.loupe && state.closeUp) {
        event.preventDefault();
        setMagnify(state.magnify === 'eight' ? 'original' : 'eight');
      }
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'l') {
      event.preventDefault();
      setLamp(!state.lampOn, true);
    } else if (key === 'v') {
      event.preventDefault();
      toggleLoupe();
    } else if (key === 'delete' || key === 'backspace') {
      if (!state.selected) return;
      event.preventDefault();
      const item = itemByPath(state.selected);
      if (!item) return;
      removeItem(item);
      toast(t('web.lighttable.removed'));
    }
  }

  function onKeyUp(event) {
    if (!state.open) return;
    if (event.code === 'Space') {
      event.preventDefault();
      event.stopPropagation();
      setCloseUp(false);
      scheduleSpaceLoupeOff();
    }
  }

  /* --------------------------------------------------------------- binding */

  function onResize() {
    if (!state.open) return;
    const previousDpr = state.dpr;
    refreshArea();
    if (state.dpr !== previousDpr) {
      setBacking(Math.max(state.lensD, state.closeUp ? closeLensSize() : NORMAL_LENS));
      positionLoupe();
      scheduleDraw();
    }
    const width = innerWidth;
    const height = innerHeight;
    if (Math.abs(width - state.lastW) > 2 || Math.abs(height - state.lastH) > 2) {
      state.lastW = width;
      state.lastH = height;
      stopArranging();
      closeLayoutMenu();
      for (const item of state.items) if (item.layout) fitItem(item);
      setBacking(Math.max(state.lensD, state.closeUp ? closeLensSize() : NORMAL_LENS));
      if (state.closeUp) trackLens(1, closeFieldTarget(), 0.2, easeInOut);
      positionLoupe();
      positionHint();
      scheduleDraw();
    }
  }

  function init() {
    const root = document.getElementById('lighttable');
    if (!root) return;
    els = {
      root,
      board: root.querySelector('.lt-board'),
      stage: document.getElementById('lt-stage'),
      empty: document.getElementById('lt-empty'),
      loupe: document.getElementById('lt-loupe'),
      mag: document.getElementById('lt-mag'),
      bar: root.querySelector('.lt-bar'),
      lamp: document.getElementById('lt-lamp'),
      lampLabel: document.getElementById('lt-lamp-label'),
      brightness: document.getElementById('lt-brightness'),
      temp: document.getElementById('lt-temp'),
      tempLabel: document.getElementById('lt-temp-label'),
      loupeToggle: document.getElementById('lt-loupe-toggle'),
      sound: document.getElementById('lt-sound'),
      layout: document.getElementById('lt-layout'),
      reset: document.getElementById('lt-reset'),
      layoutMenu: document.getElementById('lt-layout-menu'),
      count: document.getElementById('lt-count'),
      clear: document.getElementById('lt-clear'),
      close: document.getElementById('lt-close'),
      hint: document.getElementById('lt-hint'),
      openButton: document.getElementById('lighttable-open')
    };
    state.dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);
    refreshArea();
    setBacking(NORMAL_LENS);
    if (typeof applyI18n === 'function') applyI18n(document);

    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointermove', onPointerMove);
    root.addEventListener('pointerup', onPointerUp);
    root.addEventListener('pointercancel', onPointerUp);
    root.addEventListener('pointerleave', onPointerLeave);
    root.addEventListener('wheel', onWheel, { passive: false });
    root.addEventListener('dblclick', onDoubleClick);
    root.addEventListener('contextmenu', (event) => { if (event.target.closest('.lt-photo')) event.preventDefault(); });
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', () => {
      if (!state.spaceLoupe) return;
      setCloseUp(false);
      disableLoupe();
    });

    if (els.openButton) els.openButton.addEventListener('click', () => {
      audioContext();
      playClick();
      if (state.open) close(); else open();
    });
    if (els.lamp) els.lamp.addEventListener('click', () => {
      audioContext();
      setLamp(!state.lampOn, true);
    });
    if (els.brightness) els.brightness.addEventListener('input', () => {
      state.brightness = clamp(Number(els.brightness.value) / 100, 0.2, 1.6);
      clearTimeout(brightnessTimer);
      brightnessTimer = setTimeout(() => saveSettings({ lighttable_brightness: state.brightness }), 300);
      if (state.lampOn && !state.lampRaf) applyLamp(1.1);
    });
    if (els.bar) els.bar.addEventListener('click', () => {
      const active = document.activeElement;
      if (active && active !== document.body && els.bar.contains(active)) active.blur();
    });
    if (els.temp) {
      els.temp.addEventListener('click', () => { audioContext(); cycleTemperature(); });
      els.temp.addEventListener('dblclick', () => setTemperature(TEMPERATURE_PRESETS.neutral));
    }
    if (els.brightness) els.brightness.addEventListener('dblclick', () => {
      state.brightness = 1;
      els.brightness.value = '100';
      saveSettings({ lighttable_brightness: 1 });
      cancelAnimationFrame(state.lampRaf);
      state.lampRaf = 0;
      els.root.classList.remove('lt-animating');
      if (state.lampOn) applyLamp(1.1);
      playTick();
    });
    if (els.loupeToggle) els.loupeToggle.addEventListener('click', toggleLoupe);
    if (els.mag) els.mag.addEventListener('click', (event) => {
      const button = event.target.closest('[data-mag]');
      if (!button) return;
      setMagnify(button.dataset.mag);
    });
    if (els.clear) els.clear.addEventListener('click', () => {
      playClick();
      clearAll().catch((error) => toast(error.message || String(error)));
    });
    if (els.close) els.close.addEventListener('click', () => {
      playClick();
      close();
    });
    if (els.layout) els.layout.addEventListener('click', () => {
      audioContext();
      playTick();
      toggleLayoutMenu();
    });
    if (els.layoutMenu) els.layoutMenu.addEventListener('click', (event) => {
      const button = event.target.closest('[data-layout]');
      if (!button) return;
      audioContext();
      arrange(button.dataset.layout);
    });
    if (els.reset) els.reset.addEventListener('click', () => {
      audioContext();
      playClick();
      resetLayout();
    });
    document.addEventListener('pointerdown', (event) => {
      if (!els.layoutMenu || els.layoutMenu.hidden) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target && target.closest('#lt-layout-menu, #lt-layout')) return;
      closeLayoutMenu();
    }, true);
    if (els.sound) els.sound.addEventListener('click', () => {
      state.sound = !state.sound;
      saveSettings({ lighttable_sound: state.sound });
      syncSound();
      if (state.sound) playClick();
    });

    if (els.bar) els.bar.addEventListener('click', () => {
      const active = document.activeElement;
      if (active && active !== document.body && els.bar.contains(active)) active.blur();
    });
    if (els.brightness) els.brightness.value = String(Math.round(state.brightness * 100));
    if (pendingSettings) {
      const saved = pendingSettings;
      pendingSettings = null;
      applySettings(saved);
    }
    syncCount();
    syncLamp();
    syncLoupe();
    syncSound();
    applyTemperature();
    positionHint();
  }

  window.HavenLT = {
    add, open, close, clear: clearAll, count: () => state.items.length, settings: applySettings,
    debug: () => ({
      lensD: state.lensD, field: state.field, blend: state.closeBlend,
      closeUp: state.closeUp, magnify: state.magnify, backing: state.backingD,
      layoutStyle: state.layoutStyle, arranging: Boolean(state.arrangeEntries),
      temperature: state.temperature, brightness: state.brightness, lampOn: state.lampOn,
      lampAnimating: Boolean(state.lampRaf)
    })
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
