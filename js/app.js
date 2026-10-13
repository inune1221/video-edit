// 画面の動作
import {
  createProject, timelineDuration, toSource, toTimeline, ASPECTS, cropForAspect, outputSize,
  assignLanes, TEXT_PRESETS, newTextClip, applyPreset, EFFECT_TYPES, newEffect, newAudioClip,
  snapshot, restore, newId, newOverlay,
} from './project.js';
import { renderFrame, drawText, textBounds, overlayRect } from './render.js';
import { FONTS, fontByKey, addFontCss, ensureFont } from './fonts.js';
import { decodeAudioFile, computePeaks, resample, SR } from './audio.js';
import { openVideo, decodeSourceAudio, exportVideo, detectEncoders, bitrateFor } from './media.js';
import { CanvasSink } from './vendor/mediabunny.min.mjs';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

const fmt = (t) => {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};

let toastTimer = 0;
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------------------
// 状態

const S = {
  media: null, file: null, proj: null, url: null,
  buffers: new Map(), // 音声クリップID -> AudioBuffer
  peaks: new Map(), // 音声クリップID -> Float32Array（10ms ごと）
  origPeaks: null,
  thumbs: [], // { t, url }
  t: 0, playing: false, pps: 40, sel: null, panel: null,
  history: [], hIndex: -1,
  audio: { ctx: null, gain: null, nodes: [], elemOk: false, src: null, fx: null, fxLoading: null },
  expectScroll: -1,
  // 音声補正
  ovMedia: new Map(), // 重ねる素材 mediaId -> { type, file, url, bitmap, width, height, duration, fps, thumb }
  ovEls: new Map(), // 試聴用の <video>（重ねる動画クリップごと）
  analysis: null, afxWorker: null, afxReady: false, afxGain: 0, afxAB: 'proc', afxView: 'basic', afxSel: 1,
};
const video = $('video');
const preview = $('preview');
const pctx = preview.getContext('2d');
const tl = $('tl'), tlInner = $('tlInner');

const dur = () => timelineDuration(S.proj);

// ---------------------------------------------------------------------------
// 元に戻す

function commit() {
  const snap = snapshot(S.proj);
  if (S.history[S.hIndex] === snap) return;
  S.history = S.history.slice(0, S.hIndex + 1);
  S.history.push(snap);
  if (S.history.length > 80) S.history.shift();
  S.hIndex = S.history.length - 1;
  updateUndo();
}
function undoRedo(d) {
  const i = S.hIndex + d;
  if (i < 0 || i >= S.history.length) return;
  S.hIndex = i;
  restore(S.proj, S.history[i]);
  if (S.sel && !findItem(S.sel.kind, S.sel.id)) S.sel = null;
  if (S.panel) closePanel(true);
  afterTimingChange();
  afxChanged(false);
  updateUndo();
}
function updateUndo() {
  $('undo').disabled = S.hIndex <= 0;
  $('redo').disabled = S.hIndex >= S.history.length - 1;
}

// ---------------------------------------------------------------------------
// 読み込み

async function loadFile(file) {
  if (!file) return;
  if (S.proj && !confirm('今の編集内容を破棄して、新しい動画を開きますか？')) return;
  pause();
  show('loading');
  $('loadMsg').textContent = '読み込み中…';
  try {
    const media = await openVideo(file);
    if (!media.canDecodeVideo) toast('この動画の形式は書き出しに対応していない可能性があります', 4000);
    if (S.url) URL.revokeObjectURL(S.url);
    S.url = URL.createObjectURL(file);
    video.src = S.url;
    video.muted = true;
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () => rej(new Error('この動画は再生できません'));
      video.load();
    });
    // iPhone はフレームを読み込ませるために一度だけ無音で再生しておく
    try { await video.play(); video.pause(); } catch {}
    S.media = media;
    S.file = file;
    S.proj = createProject(media.info);
    S.buffers.clear();
    S.peaks.clear();
    for (const el of S.ovEls.values()) { el.pause(); el.remove(); }
    S.ovEls.clear();
    for (const m of S.ovMedia.values()) if (m.url) URL.revokeObjectURL(m.url);
    S.ovMedia.clear();
    S.origPeaks = null;
    S.thumbs = [];
    S.history = [];
    S.hIndex = -1;
    S.sel = null;
    S.t = 0;
    commit();
    show('editor');
    closePanel(true);
    fitZoom();
    layoutPreview();
    afterTimingChange();
    seek(0);
    loadThumbs();
    loadOrigWave();
  } catch (e) {
    console.error(e);
    alert('読み込みに失敗しました: ' + (e.message || e));
    show(S.proj ? 'editor' : 'start');
  }
}

function show(id) {
  for (const s of ['start', 'loading', 'editor']) $(s).hidden = s !== id;
}

async function loadThumbs() {
  try {
    const { CanvasSink } = await import('./vendor/mediabunny.min.mjs');
    const m = S.media;
    const sink = new CanvasSink(m.videoTrack, { height: 64, poolSize: 0 });
    const n = clamp(Math.round(m.info.duration / 2), 6, 40);
    const times = Array.from({ length: n }, (_, i) => m.firstTimestamp + ((i + 0.5) * m.info.duration) / n);
    const out = [];
    for await (const wc of sink.canvasesAtTimestamps(times)) {
      if (S.media !== m) return;
      if (!wc) continue;
      out.push({ t: wc.timestamp - m.firstTimestamp, url: wc.canvas.toDataURL('image/jpeg', 0.6) });
    }
    S.thumbs = out;
    renderTimeline();
  } catch (e) {
    console.warn('thumbs', e);
  }
}

async function loadOrigWave() {
  const m = S.media;
  if (!m.audioTrack || m.info.duration > 900) { S.afxReady = 'none'; return; }
  try {
    const a = await decodeSourceAudio(m, 0, m.info.duration);
    if (!a || S.media !== m) return;
    S.origPeaks = computePeaks(a.channels, Math.ceil(m.info.duration * 100));
    renderTimeline();
    startAfxAnalysis(m, a);
  } catch (e) {
    console.warn('wave', e);
    if (S.panel === 'audio') openPanel('audio');
  }
}

// ---------------------------------------------------------------------------
// プレビュー

let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

function cropMode() { return S.panel === 'crop'; }

function layoutPreview() {
  if (!S.proj) return;
  const st = $('stage');
  const bw = st.clientWidth - 16, bh = st.clientHeight - 16;
  let aw, ah;
  if (cropMode()) { aw = S.proj.src.width; ah = S.proj.src.height; }
  else { const o = outputSize(S.proj); aw = o.w; ah = o.h; }
  const k = Math.min(bw / aw, bh / ah);
  const cw = Math.max(10, Math.floor(aw * k)), ch = Math.max(10, Math.floor(ah * k));
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const scale = Math.min(dpr, 1600 / Math.max(cw, ch));
  preview.style.width = cw + 'px';
  preview.style.height = ch + 'px';
  preview.width = Math.round(cw * scale);
  preview.height = Math.round(ch * scale);
  const o = outputSize(S.proj);
  $('resInfo').textContent = `${o.w}×${o.h}・${+S.proj.src.fps.toFixed(2)}fps`;
  requestDraw();
}

function drawSourceFromVideo(c) {
  c.drawImage(video, 0, 0, S.proj.src.width, S.proj.src.height);
}

function draw() {
  if (!S.proj) return;
  const W = preview.width, H = preview.height;
  if (cropMode()) {
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    pctx.drawImage(video, 0, 0, W, H);
    const c = S.proj.crop;
    const x = c.x * W, y = c.y * H, w = c.w * W, hh = c.h * H;
    pctx.fillStyle = 'rgba(0,0,0,.6)';
    pctx.beginPath();
    pctx.rect(0, 0, W, H);
    pctx.rect(x, y, w, hh);
    pctx.fill('evenodd');
    pctx.strokeStyle = '#fff';
    pctx.lineWidth = Math.max(2, W / 300);
    pctx.strokeRect(x, y, w, hh);
    pctx.lineWidth = 1;
    pctx.strokeStyle = 'rgba(255,255,255,.5)';
    pctx.beginPath();
    for (let i = 1; i < 3; i++) {
      pctx.moveTo(x + (w * i) / 3, y); pctx.lineTo(x + (w * i) / 3, y + hh);
      pctx.moveTo(x, y + (hh * i) / 3); pctx.lineTo(x + w, y + (hh * i) / 3);
    }
    pctx.stroke();
    return;
  }
  // 停止中は、選択中の文字をアニメーションなしの完成形で表示する（編集しやすいように）
  const staticText = !S.playing && (S.sel?.kind === 'text' || S.sel?.kind === 'overlay') ? S.sel.id : null;
  syncOverlayVideos();
  renderFrame(pctx, W, H, S.proj, S.t, drawSourceFromVideo, { staticText, overlaySource: previewOverlaySource });
  if (S.sel && S.sel.kind === 'overlay') {
    const ov = findItem('overlay', S.sel.id), m = ov && S.ovMedia.get(ov.mediaId);
    if (ov && m && S.t >= ov.start && S.t < ov.end) {
      const b = overlayRect(ov, W, H, m.width, m.height);
      pctx.save();
      pctx.translate(b.cx, b.cy);
      pctx.rotate(b.rot);
      pctx.setLineDash([6, 4]);
      pctx.lineWidth = 2;
      pctx.strokeStyle = '#fff';
      pctx.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
      pctx.restore();
    }
  }
  // 選択中の文字の枠
  if (S.sel && (S.sel.kind === 'text' || S.sel.kind === 'overlay')) {
    const c = S.sel.kind === 'text' && findItem('text', S.sel.id);
    if (c && S.t >= c.start && S.t < c.end) {
      const b = textBounds(pctx, c, W, H);
      pctx.save();
      pctx.translate(b.cx, b.cy);
      pctx.rotate(b.rot);
      pctx.setLineDash([6, 4]);
      pctx.lineWidth = 2;
      pctx.strokeStyle = '#fff';
      pctx.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
      pctx.restore();
    }
    if (S.guideX) {
      pctx.strokeStyle = 'rgba(255,214,10,.9)';
      pctx.lineWidth = 1.5;
      pctx.beginPath(); pctx.moveTo(W / 2, 0); pctx.lineTo(W / 2, H); pctx.stroke();
    }
  }
}

// ---------------------------------------------------------------------------
// 再生と移動

let seekBusy = false, seekPending = null;
function seekVideo(srcTime) {
  if (seekBusy) { seekPending = srcTime; return; }
  seekBusy = true;
  video.currentTime = clamp(srcTime, 0, Math.max(0, (video.duration || S.proj.src.duration) - 0.001));
}
video.addEventListener('seeked', () => {
  seekBusy = false;
  if (seekPending != null) { const s = seekPending; seekPending = null; seekVideo(s); }
  requestDraw();
});

function seek(t, fromScroll = false) {
  S.t = clamp(t, 0, dur());
  seekVideo(toSource(S.proj, S.t));
  updateTime();
  if (!fromScroll) scrollToTime();
  requestDraw();
}

function updateTime() {
  $('tCur').textContent = fmt(S.t);
  $('tDur').textContent = fmt(dur());
}

function scrollToTime() {
  const x = Math.round(S.t * S.pps);
  S.expectScroll = x;
  tl.scrollLeft = x;
}

tl.addEventListener('scroll', () => {
  if (!S.proj || S.playing) return;
  if (Math.abs(tl.scrollLeft - S.expectScroll) <= 1) return;
  S.expectScroll = -1;
  seek(tl.scrollLeft / S.pps, true);
}, { passive: true });

function ensureAudioCtx() {
  const A = S.audio;
  if (!A.ctx) {
    A.ctx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      A.src = A.ctx.createMediaElementSource(video);
      A.gain = A.ctx.createGain();
      A.src.connect(A.gain).connect(A.ctx.destination);
      A.elemOk = true;
      loadFxWorklet();
    } catch (e) {
      console.warn('media element source', e);
    }
  }
  if (A.ctx.state !== 'running') A.ctx.resume();
  return A.ctx;
}

function applyOrigVolume() {
  const A = S.audio;
  if (A.elemOk && A.gain) { A.gain.gain.value = S.proj.origVolume; video.muted = false; }
  else video.muted = S.proj.origVolume <= 0;
}

async function play() {
  if (!S.proj || S.playing) return;
  const ctx = ensureAudioCtx();
  applyOrigVolume();
  if (S.t >= dur() - 0.05) S.t = 0;
  video.playbackRate = S.proj.speed;
  video.preservesPitch = S.proj.keepPitch;
  video.webkitPreservesPitch = S.proj.keepPitch;
  video.currentTime = toSource(S.proj, S.t);
  try { await video.play(); } catch (e) { console.warn(e); return; }
  S.playing = true;
  $('playIcon').innerHTML = '<path d="M7 5h3v14H7zM14 5h3v14h-3z"/>';
  // 追加した音声を鳴らす
  const now = ctx.currentTime + 0.03;
  const clips = [...S.proj.audios.map((a) => [a, S.buffers.get(a.id)]), ...S.proj.overlays.filter((o) => o.type === 'video').map((o) => [o, S.buffers.get(o.mediaId)])];
  for (const [a, buf] of clips) {
    if (!buf || a.end <= S.t || a.volume <= 0) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    src.connect(g).connect(ctx.destination);
    const when = a.start - S.t;
    const startAt = now + Math.max(0, when);
    const into = Math.max(0, -when);
    const len = a.end - a.start - into;
    const gp = g.gain;
    const clipPos0 = into;
    const envAt = (pos) => {
      let v = a.volume;
      if (a.fadeIn > 0 && pos < a.fadeIn) v *= pos / a.fadeIn;
      const rem = a.end - a.start - pos;
      if (a.fadeOut > 0 && rem < a.fadeOut) v *= Math.max(0, rem / a.fadeOut);
      return v;
    };
    gp.setValueAtTime(envAt(clipPos0), startAt);
    if (a.fadeIn > 0 && clipPos0 < a.fadeIn) gp.linearRampToValueAtTime(a.volume, startAt + (a.fadeIn - clipPos0));
    if (a.fadeOut > 0) {
      const foStart = Math.max(clipPos0, a.end - a.start - a.fadeOut);
      gp.setValueAtTime(envAt(foStart), startAt + (foStart - clipPos0));
      gp.linearRampToValueAtTime(0, startAt + len);
    }
    src.start(startAt, a.offset + into, Math.max(0, len));
    S.audio.nodes.push(src);
  }
  requestAnimationFrame(tick);
}

function tick() {
  if (!S.playing) return;
  const t = toTimeline(S.proj, video.currentTime);
  if (t >= dur() - 0.01 || video.ended) {
    pause();
    seek(dur());
    return;
  }
  S.t = Math.max(0, t);
  updateTime();
  scrollToTime();
  draw();
  requestAnimationFrame(tick);
}

function pause() {
  if (!S.playing) return;
  S.playing = false;
  video.pause();
  for (const el of S.ovEls.values()) el.pause();
  for (const n of S.audio.nodes) { try { n.stop(); } catch {} }
  S.audio.nodes = [];
  $('playIcon').innerHTML = '<path d="M8 5v14l11-7z"/>';
  S.t = clamp(toTimeline(S.proj, video.currentTime), 0, dur());
  updateTime();
  scrollToTime();
  requestDraw();
}

$('play').addEventListener('click', () => (S.playing ? pause() : play()));
tl.addEventListener('touchstart', () => { if (S.playing) pause(); }, { passive: true });
tl.addEventListener('mousedown', () => { if (S.playing) pause(); });

// ---------------------------------------------------------------------------
// タイムライン

function fitZoom() {
  const w = tl.clientWidth || 360;
  S.pps = clamp((w * 0.85) / dur(), 2, 300);
}
function setZoom(pps) {
  S.pps = clamp(pps, 2, 400);
  renderTimeline();
  scrollToTime();
}
$('zoomIn').addEventListener('click', () => setZoom(S.pps * 1.6));
$('zoomOut').addEventListener('click', () => setZoom(S.pps / 1.6));
let gestureStart = 0;
tl.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureStart = S.pps; });
tl.addEventListener('gesturechange', (e) => { e.preventDefault(); setZoom(gestureStart * e.scale); });

function findItem(kind, id) {
  if (!S.proj) return null;
  if (kind === 'video') return S.proj;
  return listOf(kind).find((x) => x.id === id) || null;
}
function listOf(kind) {
  return { text: S.proj.texts, effect: S.proj.effects, overlay: S.proj.overlays, audio: S.proj.audios }[kind];
}

function waveCanvas(peaks, from, to, widthPx) {
  const w = Math.max(1, Math.min(2048, Math.round(widthPx)));
  const c = h('canvas', { class: 'wave' });
  c.width = w;
  c.height = 40;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,.9)';
  const a = from * 100, b = to * 100;
  for (let x = 0; x < w; x++) {
    const i0 = Math.floor(a + ((b - a) * x) / w), i1 = Math.max(i0 + 1, Math.floor(a + ((b - a) * (x + 1)) / w));
    let m = 0;
    for (let i = i0; i < i1 && i < peaks.length; i++) if (i >= 0 && peaks[i] > m) m = peaks[i];
    const hh = Math.max(1, m * 40);
    g.fillRect(x, 40 - hh, 1, hh);
  }
  return c;
}

const ROW = { ruler: 22, video: 50, effect: 26, overlay: 32, text: 28, audio: 34, gap: 4 };

function renderTimeline() {
  if (!S.proj) return;
  const p = S.proj;
  const W = tl.clientWidth || 360;
  const pad = W / 2;
  const total = dur();
  tlInner.innerHTML = '';
  tlInner.style.width = Math.ceil(total * S.pps + W) + 'px';

  // 目盛り
  const ruler = h('div', { class: 'ruler', style: { left: pad + 'px', width: total * S.pps + 'px' } });
  const steps = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((s) => s * S.pps >= 56) || 600;
  for (let t = 0; t <= total + 1e-6; t += step) {
    const x = t * S.pps;
    ruler.append(h('span', { style: { left: x + 'px' } }, step < 1 ? t.toFixed(2).replace(/0$/, '') + 's' : fmt(t).replace(/\.0$/, '')));
    ruler.append(h('i', { style: { left: x + 'px' } }));
  }
  tlInner.append(ruler);

  let y = ROW.ruler;
  const isSel = (kind, id) => S.sel && S.sel.kind === kind && (kind === 'video' || S.sel.id === id);
  const clipEl = (kind, id, x0, w, top, height, cls, label, extra) => {
    const el = h('div', {
      class: `clip ${cls}${isSel(kind, id) ? ' sel' : ''}`,
      'data-kind': kind, 'data-id': id || '',
      style: { left: pad + x0 + 'px', width: Math.max(4, w) + 'px', top: top + 'px', height: height + 'px' },
    },
    h('div', { class: 'body' }, extra || null, label ? h('span', { class: 'label' }, label) : null),
    h('div', { class: 'h l', 'data-h': 'l' }),
    h('div', { class: 'h r', 'data-h': 'r' }));
    tlInner.append(el);
    return el;
  };

  // 動画
  {
    const w = total * S.pps;
    const extra = [];
    if (S.thumbs.length) {
      const box = h('div', { class: 'thumbs' });
      const th = ROW.video * 0.62;
      const tw = th * (p.src.width / p.src.height);
      const n = Math.min(300, Math.ceil(w / tw));
      for (let k = 0; k < n; k++) {
        const st = toSource(p, ((k + 0.5) * tw) / S.pps);
        let best = S.thumbs[0];
        for (const t of S.thumbs) if (Math.abs(t.t - st) < Math.abs(best.t - st)) best = t;
        box.append(h('img', { src: best.url, style: { width: tw + 'px' } }));
      }
      extra.push(box);
    }
    if (S.origPeaks && p.origVolume > 0) extra.push(waveCanvas(S.origPeaks, p.trimIn, p.trimOut, w));
    const label = [p.speed !== 1 ? `${+p.speed.toFixed(2)}x` : '', p.afx && p.afx.on ? '🎚 補正' : ''].filter(Boolean).join('  ');
    clipEl('video', '', 0, w, y, ROW.video, 'video', label, extra);
    y += ROW.video + ROW.gap;
  }

  const lanesFor = (items, kind, cls, rowH, labelOf, extraOf) => {
    if (!items.length) return;
    const { lanes, count } = assignLanes(items);
    for (const it of items) {
      const lane = lanes.get(it.id);
      const w = (it.end - it.start) * S.pps;
      clipEl(kind, it.id, it.start * S.pps, w, y + lane * (rowH + 3), rowH, typeof cls === 'function' ? cls(it) : cls, labelOf(it), extraOf && extraOf(it, w));
    }
    y += count * (rowH + 3) + ROW.gap;
  };
  lanesFor(p.effects, 'effect', 'effect', ROW.effect, (e) => '✦ ' + EFFECT_TYPES.find((x) => x.key === e.type).label);
  lanesFor(p.overlays, 'overlay', 'overlay', ROW.overlay, (o) => (o.type === 'video' ? '🎞 ' : '🖼 ') + o.name,
    (o) => { const m = S.ovMedia.get(o.mediaId); return m && m.thumb ? h('img', { class: 'ov-thumb', src: m.thumb }) : null; });
  lanesFor(p.texts, 'text', 'text', ROW.text, (c) => 'T ' + c.text.replace(/\n/g, ' '));
  lanesFor(p.audios, 'audio', (a) => (a.kind === 'tts' ? 'tts' : 'audio'), ROW.audio, (a) => (a.kind === 'tts' ? '🗣 ' : '♪ ') + a.name,
    (a, w) => { const pk = S.peaks.get(a.id); return pk ? waveCanvas(pk, a.offset, a.offset + (a.end - a.start), w) : null; });

  if (!p.texts.length && !p.audios.length && !p.effects.length && !p.overlays.length) {
    tlInner.append(h('div', { class: 'tl-hint', style: { left: pad + 'px', top: y + 4 + 'px' } }, '下のボタンから文字・音楽・エフェクトを追加'));
    y += 24;
  }
  tlInner.style.height = y + 10 + 'px';
  renderCtxbar();
}

function afterTimingChange() {
  S.t = clamp(S.t, 0, dur());
  renderTimeline();
  scrollToTime();
  updateTime();
  layoutPreview();
  seek(S.t);
}

// --- クリップの選択とドラッグ ---
let down = null;
tlInner.addEventListener('pointerdown', (e) => {
  if (!S.proj) return;
  const el = e.target.closest('.clip');
  if (!el) { down = { bg: true, x: e.clientX, y: e.clientY }; return; }
  const kind = el.dataset.kind, id = el.dataset.id;
  const item = findItem(kind, id);
  const selected = el.classList.contains('sel');
  const handle = e.target.closest('.h')?.dataset.h || null;
  down = {
    kind, id, el, handle, selected, moved: false, x: e.clientX, y: e.clientY,
    o: kind === 'video' ? { trimIn: item.trimIn, trimOut: item.trimOut } : { start: item.start, end: item.end, offset: item.offset },
    left: parseFloat(el.style.left), width: parseFloat(el.style.width),
  };
  if (selected) {
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
});
tlInner.addEventListener('pointermove', (e) => {
  if (!down || down.bg || !down.selected) return;
  const dx = e.clientX - down.x;
  if (!down.moved && Math.abs(dx) < 4) return;
  down.moved = true;
  dragClip(dx);
});
tlInner.addEventListener('pointerup', (e) => {
  if (!down) return;
  const d = down;
  down = null;
  if (d.bg) {
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6 && S.sel) { S.sel = null; renderTimeline(); requestDraw(); }
    return;
  }
  if (d.moved) {
    commit();
    afterTimingChange();
    return;
  }
  if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) return;
  if (d.selected) openItemPanel(d.kind, d.id);
  else select(d.kind, d.id);
});
tlInner.addEventListener('pointercancel', () => { if (down && down.moved) { commit(); afterTimingChange(); } down = null; });

function snapT(t, exclude) {
  const th = 10 / S.pps;
  const cands = [S.t, 0, dur()];
  for (const k of ['text', 'audio', 'effect']) for (const it of listOf(k)) if (it.id !== exclude) cands.push(it.start, it.end);
  let best = t, bd = th;
  for (const c of cands) { const d = Math.abs(c - t); if (d < bd) { bd = d; best = c; } }
  return best;
}

function dragClip(dx) {
  const d = down, p = S.proj;
  const dt = dx / S.pps;
  if (d.kind === 'video') {
    if (d.handle === 'l') {
      p.trimIn = clamp(d.o.trimIn + dt * p.speed, 0, p.trimOut - 0.2);
      d.el.style.left = d.left + (p.trimIn - d.o.trimIn) / p.speed * S.pps + 'px';
      d.el.style.width = (p.trimOut - p.trimIn) / p.speed * S.pps + 'px';
      seekVideo(p.trimIn);
    } else if (d.handle === 'r') {
      p.trimOut = clamp(d.o.trimOut + dt * p.speed, p.trimIn + 0.2, p.src.duration);
      d.el.style.width = (p.trimOut - p.trimIn) / p.speed * S.pps + 'px';
      seekVideo(p.trimOut - 0.05);
    }
    $('tDur').textContent = fmt(dur());
    return;
  }
  const it = findItem(d.kind, d.id);
  const total = dur();
  const ovm = d.kind === 'overlay' && it.type === 'video' ? S.ovMedia.get(it.mediaId) : null;
  const hasOffset = d.kind === 'audio' || !!ovm;
  const srcLen = d.kind === 'audio' ? S.buffers.get(it.id)?.duration : ovm ? ovm.duration : null;
  if (!d.handle) {
    const len = d.o.end - d.o.start;
    let s = Math.max(0, d.o.start + dt);
    const s2 = snapT(s, it.id), e2 = snapT(s + len, it.id);
    if (s2 !== s) s = s2; else if (e2 !== s + len) s = e2 - len;
    s = Math.max(0, s);
    it.start = s;
    it.end = s + len;
  } else if (d.handle === 'l') {
    const minStart = hasOffset ? Math.max(0, d.o.start - d.o.offset) : 0;
    let s = clamp(snapT(d.o.start + dt, it.id), minStart, d.o.end - 0.1);
    it.start = s;
    if (hasOffset) it.offset = d.o.offset + (s - d.o.start);
  } else {
    const maxEnd = srcLen ? d.o.start + (srcLen - d.o.offset) : total + 600;
    it.end = clamp(snapT(d.o.end + dt, it.id), d.o.start + 0.1, maxEnd);
  }
  d.el.style.left = tl.clientWidth / 2 + it.start * S.pps + 'px';
  d.el.style.width = (it.end - it.start) * S.pps + 'px';
  requestDraw();
}

function select(kind, id) {
  S.sel = kind ? { kind, id } : null;
  renderTimeline();
  requestDraw();
}

function renderCtxbar() {
  const bar = $('ctxbar');
  bar.innerHTML = '';
  if (!S.sel || S.panel) { bar.hidden = true; return; }
  const { kind, id } = S.sel;
  const item = findItem(kind, id);
  if (!item) { bar.hidden = true; return; }
  bar.hidden = false;
  if (kind === 'video') {
    bar.append(
      h('button', { class: 'btn-accent', onclick: () => openPanel('audio') }, '🎚 音声補正'),
      h('button', { onclick: () => openPanel('speed') }, '速度'),
      h('button', { onclick: () => openPanel('volume') }, '音量'),
      h('button', { onclick: () => openPanel('crop') }, '切り抜き'),
      h('button', { onclick: () => { S.proj.trimIn = toSource(S.proj, S.t); commit(); afterTimingChange(); seek(0); } }, 'ここより前を削除'),
      h('button', { onclick: () => { S.proj.trimOut = toSource(S.proj, S.t); commit(); afterTimingChange(); } }, 'ここより後を削除'),
    );
    return;
  }
  bar.append(
    h('button', { onclick: () => openItemPanel(kind, id) }, '編集'),
    h('button', { onclick: () => splitItem(kind, id) }, '分割'),
    h('button', { onclick: () => duplicateItem(kind, id) }, '複製'),
    h('button', { class: 'danger', onclick: () => deleteItem(kind, id) }, '削除'),
  );
}

function splitItem(kind, id) {
  const it = findItem(kind, id);
  const t = S.t;
  if (t <= it.start + 0.05 || t >= it.end - 0.05) { toast('再生位置（白い線）をクリップの途中に合わせてください'); return; }
  const b = { ...JSON.parse(JSON.stringify(it)), id: newId(kind[0]), start: t };
  if (kind === 'audio') { b.offset = it.offset + (t - it.start); S.buffers.set(b.id, S.buffers.get(it.id)); S.peaks.set(b.id, S.peaks.get(it.id)); }
  if (kind === 'overlay') b.offset = it.offset + (t - it.start);
  it.end = t;
  listOf(kind).push(b);
  commit();
  select(kind, b.id);
}
function duplicateItem(kind, id) {
  const it = findItem(kind, id);
  const len = it.end - it.start;
  const b = { ...JSON.parse(JSON.stringify(it)), id: newId(kind[0]), start: it.end, end: it.end + len };
  if (kind === 'audio') { S.buffers.set(b.id, S.buffers.get(it.id)); S.peaks.set(b.id, S.peaks.get(it.id)); }
  if (b.seed != null) b.seed = Math.floor(Math.random() * 1e6);
  listOf(kind).push(b);
  commit();
  select(kind, b.id);
}
function deleteItem(kind, id) {
  const list = listOf(kind);
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list.splice(i, 1);
  S.sel = null;
  commit();
  if (S.panel) closePanel(true);
  renderTimeline();
  requestDraw();
}

// ---------------------------------------------------------------------------
// プレビュー上での操作（文字の移動・拡大、切り抜き範囲の移動・拡大）

const pointers = new Map();
let stageDrag = null;
const stage = $('stage');
stage.addEventListener('pointerdown', (e) => {
  if (!S.proj) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  stage.setPointerCapture(e.pointerId);
  const r = preview.getBoundingClientRect();
  if (pointers.size === 2 && stageDrag) {
    const [a, b] = [...pointers.values()];
    stageDrag.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), size: stageDrag.target?.size, scale: stageDrag.target?.scale, crop: { ...S.proj.crop } };
    return;
  }
  if (pointers.size > 1) return;
  if (cropMode()) {
    stageDrag = { type: 'crop', x: e.clientX, y: e.clientY, o: { ...S.proj.crop }, r, moved: false };
    return;
  }
  // 文字のタップ判定
  const px = ((e.clientX - r.left) / r.width) * preview.width, py = ((e.clientY - r.top) / r.height) * preview.height;
  let hit = null;
  const active = S.proj.texts.filter((c) => S.t >= c.start && S.t < c.end);
  for (let i = active.length - 1; i >= 0; i--) {
    const c = active[i];
    const b = textBounds(pctx, c, preview.width, preview.height);
    const dx = px - b.cx, dy = py - b.cy;
    const lx = dx * Math.cos(-b.rot) - dy * Math.sin(-b.rot), ly = dx * Math.sin(-b.rot) + dy * Math.cos(-b.rot);
    const m = 12 * (preview.width / r.width);
    if (Math.abs(lx) <= b.w / 2 + m && Math.abs(ly) <= b.h / 2 + m) { hit = c; break; }
  }
  let hitKind = 'text';
  if (!hit) {
    // 重ねた画像・動画（上にあるものから）
    const ovs = S.proj.overlays.filter((o) => S.t >= o.start && S.t < o.end);
    for (let i = ovs.length - 1; i >= 0; i--) {
      const o = ovs[i], m = S.ovMedia.get(o.mediaId);
      if (!m) continue;
      const b = overlayRect(o, preview.width, preview.height, m.width, m.height);
      const dx = px - b.cx, dy = py - b.cy;
      const lx = dx * Math.cos(-b.rot) - dy * Math.sin(-b.rot), ly = dx * Math.sin(-b.rot) + dy * Math.cos(-b.rot);
      if (Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2) { hit = o; hitKind = 'overlay'; break; }
    }
  }
  if (hit) {
    const wasSel = S.sel?.kind === hitKind && S.sel.id === hit.id;
    if (!wasSel) {
      S.sel = { kind: hitKind, id: hit.id };
      if (S.panel && S.panel !== 'item') closePanel(true);
      if (S.panel === 'item') openItemPanel(hitKind, hit.id); else renderTimeline();
    }
    stageDrag = { type: hitKind, target: hit, x: e.clientX, y: e.clientY, o: { x: hit.x, y: hit.y }, r, moved: false, wasSel };
    requestDraw();
  } else {
    stageDrag = { type: 'none', x: e.clientX, y: e.clientY, moved: false };
  }
});
stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const d = stageDrag;
  if (!d) return;
  if (d.pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const k = Math.hypot(a.x - b.x, a.y - b.y) / Math.max(10, d.pinch.d0);
    d.moved = true;
    if (d.type === 'text') d.target.size = clamp(d.pinch.size * k, 0.015, 0.6);
    else if (d.type === 'overlay') d.target.scale = clamp(d.pinch.scale * k, 0.03, 3);
    else if (d.type === 'crop') scaleCrop(d.pinch.crop, 1 / k);
    requestDraw();
    return;
  }
  const dx = e.clientX - d.x, dy = e.clientY - d.y;
  if (!d.moved && Math.hypot(dx, dy) < 4) return;
  d.moved = true;
  if (d.type === 'text' || d.type === 'overlay') {
    let x = d.o.x + dx / d.r.width;
    S.guideX = Math.abs(x - 0.5) < 0.015;
    if (S.guideX) x = 0.5;
    d.target.x = clamp(x, -0.2, 1.2);
    d.target.y = clamp(d.o.y + dy / d.r.height, -0.2, 1.2);
    requestDraw();
  } else if (d.type === 'crop') {
    const c = S.proj.crop;
    c.x = clamp(d.o.x + dx / d.r.width, 0, 1 - c.w);
    c.y = clamp(d.o.y + dy / d.r.height, 0, 1 - c.h);
    requestDraw();
    refreshPanelValues();
  }
});
const stageUp = (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  const d = stageDrag;
  if (pointers.size > 0) return;
  stageDrag = null;
  S.guideX = false;
  if (!d) return;
  if (d.moved) { commit(); if (d.type === 'crop') layoutPreview(); refreshPanelValues(); requestDraw(); return; }
  if (e.type === 'pointercancel') return;
  if ((d.type === 'text' || d.type === 'overlay') && d.wasSel && S.panel !== 'item') openItemPanel(d.type, d.target.id);
  else if (d.type === 'none' && (!S.panel || S.panel === 'audio')) { S.playing ? pause() : play(); }
};
stage.addEventListener('pointerup', stageUp);
stage.addEventListener('pointercancel', stageUp);

function scaleCrop(o, k) {
  const c = S.proj.crop;
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  let w = o.w * k, hh = o.h * k;
  const maxK = Math.min(1 / w, 1 / hh);
  if (maxK < 1) { w *= maxK; hh *= maxK; }
  const minK = Math.max(0.08 / w, 0.08 / hh);
  if (minK > 1) { w *= minK; hh *= minK; }
  c.w = w; c.h = hh;
  c.x = clamp(cx - w / 2, 0, 1 - w);
  c.y = clamp(cy - hh / 2, 0, 1 - hh);
}

// ---------------------------------------------------------------------------
// パネル

let refreshers = [];
function refreshPanelValues() { for (const f of refreshers) f(); }

function openPanel(name, title) {
  if (name !== 'audio') pause();
  const wasCrop = cropMode();
  S.panel = name;
  $('lower').classList.toggle('tall', name === 'audio');
  refreshers = [];
  $('tools').hidden = true;
  $('tlArea').hidden = true;
  $('ctxbar').hidden = true;
  $('panel').hidden = false;
  const body = $('panelBody');
  body.innerHTML = '';
  body.scrollTop = 0;
  const builders = { speed: buildSpeed, volume: buildVolume, crop: buildCrop, tts: buildTts, effectPick: buildEffectPick, audio: buildAudioFx };
  const titles = { speed: '速度', volume: '音量バランス', crop: '切り抜き', tts: '読み上げ', effectPick: 'エフェクトを追加', audio: '音声補正' };
  $('panelTitle').textContent = title || titles[name] || '';
  if (builders[name]) builders[name](body);
  if (wasCrop !== cropMode()) layoutPreview();
  else if (name === 'audio') requestAnimationFrame(layoutPreview);
  requestDraw();
}

function openItemPanel(kind, id) {
  if (kind === 'video') { openPanel('audio'); return; }
  S.sel = { kind, id };
  openPanel('item', { text: 'テキスト', effect: 'エフェクト', overlay: '重ねる素材', audio: '音声' }[kind]);
  const body = $('panelBody');
  const it = findItem(kind, id);
  if (kind === 'text') buildText(body, it);
  else if (kind === 'effect') buildEffect(body, it);
  else if (kind === 'overlay') buildOverlay(body, it);
  else buildAudio(body, it);
}

function closePanel(silent) {
  const wasCrop = cropMode();
  const wasAudio = S.panel === 'audio';
  S.panel = null;
  $('lower').classList.remove('tall');
  if (wasAudio && S.afxAB === 'orig') { S.afxAB = 'proc'; pushAfx(); }
  refreshers = [];
  $('panel').hidden = true;
  $('tools').hidden = false;
  $('tlArea').hidden = false;
  if (!silent) commit();
  renderTimeline();
  scrollToTime();
  if (wasCrop || wasAudio) layoutPreview();
  requestDraw();
}
$('panelDone').addEventListener('click', () => closePanel(false));

// --- 部品 ---
function slider({ label, min, max, step, get, set, show, onChange }) {
  const input = h('input', { type: 'range', min, max, step });
  const out = h('output');
  const refresh = () => { input.value = get(); out.textContent = show ? show(+input.value) : input.value; };
  input.addEventListener('input', () => { set(+input.value); out.textContent = show ? show(+input.value) : input.value; requestDraw(); });
  input.addEventListener('change', () => { commit(); onChange && onChange(); });
  refresh();
  refreshers.push(refresh);
  return h('div', { class: 'row' }, h('label', {}, label), input, out);
}
function chips({ options, get, set, scroll, onChange }) {
  const box = h('div', { class: 'chips' + (scroll ? ' scroll' : '') });
  const refresh = () => { for (const b of box.children) b.classList.toggle('on', b.dataset.v === String(get())); };
  for (const o of options) {
    const b = h('button', { class: 'chip' + (o.cls ? ' ' + o.cls : ''), 'data-v': String(o.v), style: o.style }, o.node || o.label);
    b.addEventListener('click', () => { set(o.v); refresh(); commit(); requestDraw(); onChange && onChange(); });
    box.append(b);
  }
  refresh();
  refreshers.push(refresh);
  return box;
}
function toggle({ label, get, set, onChange }) {
  const input = h('input', { type: 'checkbox' });
  input.checked = !!get();
  input.addEventListener('change', () => { set(input.checked); commit(); requestDraw(); onChange && onChange(); });
  refreshers.push(() => (input.checked = !!get()));
  return h('div', { class: 'row2' }, h('span', {}, label), h('label', { class: 'switch' }, input, h('span')));
}
const SWATCHES = ['#ffffff', '#000000', '#ffe600', '#ff9a00', '#ff1a1a', '#ff4fa0', '#a259ff', '#00bfff', '#2ecc40', '#0b2a6b', '#5a2a00'];
function colors({ get, set }) {
  const box = h('div', { class: 'swatches' });
  const custom = h('input', { type: 'color' });
  const refresh = () => {
    const v = (get() || '').toLowerCase();
    for (const b of box.querySelectorAll('.sw')) b.classList.toggle('on', b.dataset.v === v);
    if (/^#[0-9a-f]{6}$/.test(v)) custom.value = v;
  };
  for (const c of SWATCHES) {
    const b = h('button', { class: 'sw', 'data-v': c, style: { background: c }, 'aria-label': c });
    b.addEventListener('click', () => { set(c); refresh(); commit(); requestDraw(); });
    box.append(b);
  }
  custom.addEventListener('input', () => { set(custom.value); refresh(); requestDraw(); });
  custom.addEventListener('change', () => commit());
  box.append(custom);
  refresh();
  refreshers.push(refresh);
  return box;
}
const sec = (title, ...kids) => h('div', { class: 'sec' }, title ? h('div', { class: 'sec-title' }, title) : null, ...kids);

function timingButtons(it) {
  const info = h('span', { class: 'lbl' });
  const refresh = () => (info.textContent = `${fmt(it.start)} 〜 ${fmt(it.end)}（${(it.end - it.start).toFixed(1)}秒）`);
  refresh();
  refreshers.push(refresh);
  const setStart = () => { const len = it.end - it.start; it.start = S.t; if (it.end <= it.start + 0.1) it.end = it.start + len; refresh(); commit(); requestDraw(); };
  const setEnd = () => { if (S.t <= it.start + 0.1) { toast('開始より後の位置にしてください'); return; } it.end = S.t; refresh(); commit(); requestDraw(); };
  return sec('表示する時間', info,
    h('div', { class: 'btn-row' },
      h('button', { onclick: setStart }, '開始を再生位置に'),
      h('button', { onclick: setEnd }, '終了を再生位置に')),
    h('p', { class: 'lbl' }, '完了を押すと、タイムライン上でドラッグして時間を調整できます。'));
}

// --- テキスト ---
function presetThumb(preset, clip) {
  const c = h('canvas');
  c.width = 168; c.height = 72;
  const g = c.getContext('2d');
  const t = { ...clip, ...preset, o1: preset.o1 && { ...preset.o1 }, o2: preset.o2 && { ...preset.o2 },
    shadow: { ...clip.shadow, on: !!preset.shadow }, box: { ...clip.box, on: !!preset.box },
    text: 'あA', x: 0.5, y: 0.5, size: 0.62, rot: 0, anim: 'none' };
  const paint = () => { g.clearRect(0, 0, 168, 72); drawText(g, t, 168, 72, null); };
  paint();
  ensureFont(clip.font, 'あA').then(paint);
  return c;
}

function buildText(body, c) {
  const ta = h('textarea', { rows: 2 });
  ta.value = c.text;
  ta.addEventListener('input', () => { c.text = ta.value; ensureFont(c.font, c.text).then(requestDraw); requestDraw(); });
  ta.addEventListener('change', () => { commit(); renderTimeline(); });
  body.append(sec('', ta));

  const presetBox = h('div');
  const drawPresets = () => {
    presetBox.innerHTML = '';
    presetBox.append(chips({
      scroll: true,
      options: TEXT_PRESETS.map((p) => ({ v: p.key, node: presetThumb(p, c), cls: 'preset' })),
      get: () => '',
      set: (k) => { applyPreset(c, k); refreshPanelValues(); },
    }));
  };
  drawPresets();
  body.append(sec('スタイル（縁取りのプリセット）', presetBox));

  body.append(sec('フォント', chips({
    scroll: true,
    options: FONTS.map((f) => ({ v: f.key, label: f.label, style: { fontFamily: f.family, fontWeight: f.weight } })),
    get: () => c.font,
    set: (k) => { c.font = k; ensureFont(k, c.text).then(() => { requestDraw(); drawPresets(); }); },
  }), slider({ label: 'サイズ', min: 0.02, max: 0.4, step: 0.005, get: () => c.size, set: (v) => (c.size = v), show: (v) => Math.round(v * 1000) / 10 + '' })));

  body.append(sec('文字の色', colors({ get: () => c.fill, set: (v) => (c.fill = v) }),
    toggle({ label: 'グラデーション（下の色）', get: () => !!c.fill2, set: (v) => { c.fill2 = v ? c.fill2 || '#ff9a00' : null; refreshPanelValues(); } }),
    (() => { const w = h('div'); const box = colors({ get: () => c.fill2, set: (v) => (c.fill2 = v) }); w.append(box); refreshers.push(() => (w.hidden = !c.fill2)); w.hidden = !c.fill2; return w; })()));

  const outline = (key, title, def) => {
    const box = h('div');
    const detail = h('div', {},
      colors({ get: () => c[key]?.color, set: (v) => (c[key].color = v) }),
      slider({ label: '太さ', min: 0.01, max: 0.35, step: 0.005, get: () => c[key]?.width || def.width, set: (v) => (c[key].width = v), show: (v) => Math.round(v * 100) + '' }));
    const refresh = () => (detail.hidden = !c[key]);
    refreshers.push(refresh);
    box.append(toggle({ label: title, get: () => !!c[key], set: (v) => { c[key] = v ? c[key] || { ...def } : null; refreshPanelValues(); } }), detail);
    refresh();
    return box;
  };
  body.append(sec('縁取り', outline('o1', '縁（内側）', { color: '#000000', width: 0.14 }), outline('o2', '縁（外側・二重縁）', { color: '#ffffff', width: 0.08 })));

  const shadowDetail = h('div', {},
    colors({ get: () => c.shadow.color, set: (v) => (c.shadow.color = v) }),
    slider({ label: 'ぼかし', min: 0, max: 0.6, step: 0.01, get: () => c.shadow.blur, set: (v) => (c.shadow.blur = v), show: (v) => Math.round(v * 100) + '' }),
    slider({ label: '距離', min: 0, max: 0.3, step: 0.005, get: () => c.shadow.dist, set: (v) => (c.shadow.dist = v), show: (v) => Math.round(v * 100) + '' }));
  refreshers.push(() => (shadowDetail.hidden = !c.shadow.on));
  shadowDetail.hidden = !c.shadow.on;
  const boxDetail = h('div', {},
    colors({ get: () => c.box.color, set: (v) => (c.box.color = v) }),
    slider({ label: '濃さ', min: 0.1, max: 1, step: 0.05, get: () => c.box.opacity, set: (v) => (c.box.opacity = v), show: (v) => Math.round(v * 100) + '%' }));
  refreshers.push(() => (boxDetail.hidden = !c.box.on));
  boxDetail.hidden = !c.box.on;
  body.append(sec('影・背景',
    toggle({ label: '影', get: () => c.shadow.on, set: (v) => { c.shadow.on = v; refreshPanelValues(); } }), shadowDetail,
    toggle({ label: '背景の帯', get: () => c.box.on, set: (v) => { c.box.on = v; refreshPanelValues(); } }), boxDetail));

  body.append(sec('配置',
    chips({ options: [{ v: 'left', label: '左揃え' }, { v: 'center', label: '中央揃え' }, { v: 'right', label: '右揃え' }], get: () => c.align, set: (v) => (c.align = v) }),
    h('div', { class: 'btn-row' },
      h('button', { onclick: () => { c.x = 0.5; c.y = 0.15; commit(); refreshPanelValues(); requestDraw(); } }, '上'),
      h('button', { onclick: () => { c.x = 0.5; c.y = 0.5; commit(); refreshPanelValues(); requestDraw(); } }, '中央'),
      h('button', { onclick: () => { c.x = 0.5; c.y = 0.82; commit(); refreshPanelValues(); requestDraw(); } }, '下')),
    slider({ label: '横位置', min: 0, max: 1, step: 0.005, get: () => c.x, set: (v) => (c.x = v), show: (v) => Math.round(v * 100) + '' }),
    slider({ label: '縦位置', min: 0, max: 1, step: 0.005, get: () => c.y, set: (v) => (c.y = v), show: (v) => Math.round(v * 100) + '' }),
    slider({ label: '回転', min: -45, max: 45, step: 1, get: () => c.rot, set: (v) => (c.rot = v), show: (v) => v + '°' }),
    h('p', { class: 'lbl' }, 'プレビュー上で文字をドラッグして移動、2本指で拡大縮小できます。')));

  body.append(sec('出かた（アニメーション）', chips({
    options: [{ v: 'none', label: 'なし' }, { v: 'pop', label: 'ポン' }, { v: 'fade', label: 'フェード' }, { v: 'slide', label: '下から' }, { v: 'type', label: 'タイプ' }],
    get: () => c.anim, set: (v) => (c.anim = v),
  })));
  body.append(timingButtons(c));
  body.append(h('div', { class: 'btn-row' },
    h('button', { onclick: () => duplicateItem('text', c.id) }, '複製'),
    h('button', { class: 'danger', style: { color: 'var(--danger)' }, onclick: () => deleteItem('text', c.id) }, '削除')));
  ensureFont(c.font, c.text).then(requestDraw);
}

function addText() {
  const start = clamp(S.t, 0, Math.max(0, dur() - 0.5));
  const len = Math.min(3, Math.max(0.5, dur() - start));
  // 直前に作った文字のスタイルを引き継ぐ
  const last = S.proj.texts[S.proj.texts.length - 1];
  const base = last ? { font: last.font, size: last.size, fill: last.fill, fill2: last.fill2, o1: last.o1 && { ...last.o1 }, o2: last.o2 && { ...last.o2 },
    shadow: { ...last.shadow }, box: { ...last.box }, anim: last.anim, x: last.x, y: last.y, align: last.align } : {};
  const c = newTextClip(start, len, base);
  S.proj.texts.push(c);
  commit();
  openItemPanel('text', c.id);
  const ta = $('panelBody').querySelector('textarea');
  if (ta) { ta.focus(); ta.select(); }
}

// --- エフェクト ---
function buildEffectPick(body) {
  const desc = { shake: '画面がランダムに上下左右へ揺れる', zoom: 'ゆっくり（または一気に）ズーム', flash: '画面が一瞬光る', fade: '黒（や白）からのフェードイン / フェードアウト' };
  for (const t of EFFECT_TYPES) {
    body.append(h('button', { class: 'wide', style: { textAlign: 'left' }, onclick: () => {
      const start = clamp(S.t, 0, Math.max(0, dur() - 0.2));
      const len = Math.min(t.key === 'flash' ? 0.5 : 2, Math.max(0.2, dur() - start));
      const e = newEffect(t.key, start, len);
      S.proj.effects.push(e);
      commit();
      openItemPanel('effect', e.id);
    } }, h('b', {}, t.label), h('div', { class: 'lbl' }, desc[t.key])));
  }
}

function buildEffect(body, e) {
  const name = EFFECT_TYPES.find((x) => x.key === e.type).label;
  $('panelTitle').textContent = name;
  if (e.type === 'shake') {
    body.append(sec('揺れ',
      slider({ label: '強さ', min: 1, max: 100, step: 1, get: () => e.amp, set: (v) => (e.amp = v) }),
      slider({ label: '速さ', min: 0.5, max: 30, step: 0.5, get: () => e.speed, set: (v) => (e.speed = v), show: (v) => v + '' }),
      slider({ label: '回転', min: 0, max: 15, step: 0.5, get: () => e.rot, set: (v) => (e.rot = v), show: (v) => v + '°' }),
      h('div', { class: 'sec-title' }, '方向'),
      chips({ options: [{ v: 'both', label: '上下左右' }, { v: 'h', label: '左右だけ' }, { v: 'v', label: '上下だけ' }], get: () => e.dir, set: (v) => (e.dir = v) }),
      h('div', { class: 'sec-title' }, '揺れかた'),
      chips({ options: [{ v: 'smooth', label: 'なめらか' }, { v: 'hard', label: 'ガクガク' }], get: () => e.style, set: (v) => (e.style = v) }),
      toggle({ label: '少し拡大して黒い縁を隠す', get: () => e.cover, set: (v) => (e.cover = v) }),
      toggle({ label: '文字も一緒に揺らす', get: () => e.withText, set: (v) => (e.withText = v) }),
      h('div', { class: 'btn-row' }, h('button', { onclick: () => { e.seed = Math.floor(Math.random() * 1e6); commit(); requestDraw(); toast('揺れのパターンを変えました'); } }, '揺れのパターンを変える'))));
  } else if (e.type === 'zoom') {
    body.append(sec('ズーム',
      slider({ label: '開始倍率', min: 1, max: 3, step: 0.01, get: () => e.from, set: (v) => (e.from = v), show: (v) => v.toFixed(2) + 'x' }),
      slider({ label: '終了倍率', min: 1, max: 3, step: 0.01, get: () => e.to, set: (v) => (e.to = v), show: (v) => v.toFixed(2) + 'x' })));
  } else if (e.type === 'flash') {
    body.append(sec('フラッシュ', colors({ get: () => e.color, set: (v) => (e.color = v) }),
      slider({ label: '強さ', min: 0.1, max: 1, step: 0.05, get: () => e.strength, set: (v) => (e.strength = v), show: (v) => Math.round(v * 100) + '%' })));
  } else if (e.type === 'fade') {
    body.append(sec('フェード',
      chips({ options: [{ v: 'in', label: 'フェードイン' }, { v: 'out', label: 'フェードアウト' }], get: () => e.mode, set: (v) => (e.mode = v) }),
      colors({ get: () => e.color, set: (v) => (e.color = v) })));
  }
  body.append(timingButtons(e));
  body.append(h('div', { class: 'btn-row' },
    h('button', { onclick: () => { pause(); seek(e.start); play(); } }, 'この部分を再生'),
    h('button', { class: 'danger', style: { color: 'var(--danger)' }, onclick: () => deleteItem('effect', e.id) }, '削除')));
}

// --- 音声 ---
async function addAudioFile(file, kind = 'music', label) {
  if (!file) return null;
  toast('音声を読み込み中…', 10000);
  try {
    const buf = await decodeAudioFile(file);
    const start = clamp(S.t, 0, Math.max(0, dur() - 0.1));
    const name = label || file.name.replace(/\.[^.]+$/, '');
    const a = newAudioClip(start, buf, name, kind);
    if (kind === 'music') a.end = Math.min(a.end, Math.max(start + 0.1, dur()));
    S.buffers.set(a.id, buf);
    const chs = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
    S.peaks.set(a.id, computePeaks(chs, Math.ceil(buf.duration * 100)));
    S.proj.audios.push(a);
    commit();
    $('toast').hidden = true;
    return a;
  } catch (e) {
    console.error(e);
    toast('この音声ファイルは読み込めませんでした');
    return null;
  }
}

function buildAudio(body, a) {
  const buf = S.buffers.get(a.id);
  body.append(sec(a.kind === 'tts' ? '読み上げ音声' : '音楽・効果音', h('div', {}, a.name),
    h('div', { class: 'lbl' }, buf ? `長さ ${buf.duration.toFixed(1)}秒` : ''),
    slider({ label: '音量', min: 0, max: 2, step: 0.01, get: () => a.volume, set: (v) => (a.volume = v), show: (v) => Math.round(v * 100) + '%', onChange: renderTimeline }),
    slider({ label: 'フェードイン', min: 0, max: 5, step: 0.1, get: () => a.fadeIn, set: (v) => (a.fadeIn = v), show: (v) => v.toFixed(1) + 's' }),
    slider({ label: 'フェードアウト', min: 0, max: 5, step: 0.1, get: () => a.fadeOut, set: (v) => (a.fadeOut = v), show: (v) => v.toFixed(1) + 's' })));
  body.append(sec('元の動画の音声', slider({ label: '元の音量', min: 0, max: 2, step: 0.01, get: () => S.proj.origVolume, set: (v) => { S.proj.origVolume = v; applyOrigVolume(); }, show: (v) => Math.round(v * 100) + '%' })));
  const info = h('span', { class: 'lbl' });
  const refresh = () => (info.textContent = `${fmt(a.start)} 〜 ${fmt(a.end)}`);
  refresh();
  refreshers.push(refresh);
  body.append(sec('位置', info, h('div', { class: 'btn-row' },
    h('button', { onclick: () => { const len = a.end - a.start; a.start = S.t; a.end = S.t + len; refresh(); commit(); } }, '再生位置から始める'),
    h('button', { onclick: () => { if (S.t > a.start + 0.1) { a.end = Math.min(S.t, a.start + (buf ? buf.duration - a.offset : 1e9)); refresh(); commit(); } } }, '再生位置で終わる'))));
  body.append(h('div', { class: 'btn-row' },
    h('button', { onclick: () => { pause(); seek(a.start); play(); } }, 'ここから再生'),
    h('button', { class: 'danger', style: { color: 'var(--danger)' }, onclick: () => deleteItem('audio', a.id) }, '削除')));
}

function buildVolume(body) {
  const p = S.proj;
  body.append(sec('元の動画の音声',
    slider({ label: '元の音量', min: 0, max: 2, step: 0.01, get: () => p.origVolume, set: (v) => { p.origVolume = v; applyOrigVolume(); }, show: (v) => Math.round(v * 100) + '%' }),
    p.src.hasAudio ? null : h('p', { class: 'lbl' }, 'この動画には音声がありません')));
  if (!p.audios.length) body.append(h('p', { class: 'lbl' }, '「音楽」や「読み上げ」で音声を追加すると、ここで動画の音とのバランスを調整できます。'));
  for (const a of p.audios) {
    body.append(sec((a.kind === 'tts' ? '🗣 ' : '♪ ') + a.name + `（${fmt(a.start)}〜）`,
      slider({ label: '音量', min: 0, max: 2, step: 0.01, get: () => a.volume, set: (v) => (a.volume = v), show: (v) => Math.round(v * 100) + '%' })));
  }
  body.append(h('p', { class: 'lbl' }, '100% が元の大きさです。再生しながら調整できます。'));
}

// --- 速度 ---
function buildSpeed(body) {
  const p = S.proj;
  const toPos = (s) => Math.log2(s), fromPos = (v) => Math.round(Math.pow(2, v) * 100) / 100;
  const after = () => { afterTimingChange(); };
  body.append(sec('再生速度',
    slider({ label: '速度', min: -2, max: 2, step: 0.01, get: () => toPos(p.speed), set: (v) => (p.speed = fromPos(v)), show: (v) => fromPos(v) + 'x', onChange: after }),
    chips({ options: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((v) => ({ v, label: v + 'x' })), get: () => p.speed, set: (v) => { p.speed = v; refreshPanelValues(); }, onChange: after }),
    toggle({ label: '声の高さを保つ', get: () => p.keepPitch, set: (v) => (p.keepPitch = v) }),
    h('p', { class: 'lbl' }, '速度を変えると動画全体の長さが変わります。文字や音楽の位置はそのままなので、必要に応じて調整してください。')));
  const info = h('p', { class: 'lbl' });
  const refresh = () => (info.textContent = `使う範囲: 元動画の ${fmt(p.trimIn)} 〜 ${fmt(p.trimOut)}（出力 ${fmt(dur())}）`);
  refresh();
  refreshers.push(refresh);
  body.append(sec('使う範囲（トリミング）', info,
    h('div', { class: 'btn-row' },
      h('button', { onclick: () => { p.trimIn = toSource(p, S.t); commit(); afterTimingChange(); seek(0); refresh(); } }, 'ここより前を削除'),
      h('button', { onclick: () => { p.trimOut = toSource(p, S.t); commit(); afterTimingChange(); refresh(); } }, 'ここより後を削除')),
    h('button', { class: 'wide', onclick: () => { p.trimIn = 0; p.trimOut = p.src.duration; commit(); afterTimingChange(); refresh(); } }, '範囲をリセット'),
    h('p', { class: 'lbl' }, 'タイムラインで動画を選ぶと、両端の白いつまみでも範囲を変えられます。')));
}

// --- 切り抜き ---
function buildCrop(body) {
  const p = S.proj;
  const res = h('p', { class: 'lbl' });
  const refreshRes = () => { const o = outputSize(p); res.textContent = `出力サイズ: ${o.w}×${o.h}${o.w * o.h > 3840 * 2160 ? '' : ''}`; };
  refreshers.push(refreshRes);
  refreshRes();
  const freeBox = h('div', {},
    slider({ label: '幅', min: 0.08, max: 1, step: 0.005, get: () => p.crop.w, set: (v) => { p.crop.w = v; p.crop.x = clamp(p.crop.x, 0, 1 - v); refreshRes(); }, show: (v) => Math.round(v * 100) + '%', onChange: layoutPreview }),
    slider({ label: '高さ', min: 0.08, max: 1, step: 0.005, get: () => p.crop.h, set: (v) => { p.crop.h = v; p.crop.y = clamp(p.crop.y, 0, 1 - v); refreshRes(); }, show: (v) => Math.round(v * 100) + '%', onChange: layoutPreview }));
  refreshers.push(() => (freeBox.hidden = p.crop.aspect !== 'free'));
  freeBox.hidden = p.crop.aspect !== 'free';
  const sizeRow = h('div', {}, slider({
    label: '大きさ', min: 0.1, max: 1, step: 0.005,
    get: () => { const full = cropForAspect(p, p.crop.aspect); return p.crop.w / full.w; },
    set: (v) => { const full = cropForAspect(p, p.crop.aspect); scaleCrop(p.crop, (full.w * v) / p.crop.w); refreshRes(); },
    show: (v) => Math.round(v * 100) + '%',
  }));
  refreshers.push(() => (sizeRow.hidden = p.crop.aspect === 'free' || p.crop.aspect === 'orig'));
  sizeRow.hidden = p.crop.aspect === 'free' || p.crop.aspect === 'orig';
  body.append(sec('縦横比', chips({
    options: ASPECTS.map((a) => ({ v: a.key, label: a.label })),
    get: () => p.crop.aspect,
    set: (k) => { if (k === 'free' && p.crop.aspect === 'orig') p.crop = { aspect: 'free', x: 0.1, y: 0.1, w: 0.8, h: 0.8 }; else p.crop = cropForAspect(p, k); refreshPanelValues(); },
  }), sizeRow, freeBox, res,
  h('p', { class: 'lbl' }, 'プレビュー上で枠をドラッグして位置、2本指で大きさを変えられます。切り抜いた部分は拡大せず元の画素のまま書き出すので、画質は落ちません（最大4K）。'),
  h('button', { class: 'wide', onclick: () => { p.crop = cropForAspect(p, 'orig'); commit(); refreshPanelValues(); requestDraw(); } }, 'リセット')));
}

// --- 読み上げ ---
const TTS_KEY = 'tts-shortcut-name';
function buildTts(body) {
  const ta = h('textarea', { rows: 3, placeholder: '読み上げる文章' });
  ta.value = localStorage.getItem('tts-last') || '';
  ta.addEventListener('input', () => { try { localStorage.setItem('tts-last', ta.value); } catch {} });
  const sel = h('select');
  const rate = h('input', { type: 'range', min: 0.5, max: 1.6, step: 0.05, value: 1 });
  const pitch = h('input', { type: 'range', min: 0.5, max: 1.8, step: 0.05, value: 1 });
  const fillVoices = () => {
    const vs = (speechSynthesis.getVoices() || []).filter((v) => /^(ja|en)/i.test(v.lang));
    vs.sort((a, b) => (a.lang.startsWith('ja') === b.lang.startsWith('ja') ? a.name.localeCompare(b.name) : a.lang.startsWith('ja') ? -1 : 1));
    sel.innerHTML = '';
    for (const v of vs) sel.append(h('option', { value: v.voiceURI }, `${v.name}（${v.lang}）`));
  };
  if ('speechSynthesis' in window) { fillVoices(); speechSynthesis.onvoiceschanged = fillVoices; }
  const speak = () => {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(ta.value || 'こんにちは');
    const v = speechSynthesis.getVoices().find((x) => x.voiceURI === sel.value);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = +rate.value;
    u.pitch = +pitch.value;
    speechSynthesis.speak(u);
  };
  body.append(sec('文章', ta));
  body.append(sec('声の試し聞き（iPhone内蔵の声）', sel,
    h('div', { class: 'row' }, h('label', {}, '速さ'), rate, h('output')),
    h('div', { class: 'row' }, h('label', {}, '高さ'), pitch, h('output')),
    h('button', { class: 'wide', onclick: speak }, '▶ 試し聞き')));

  const nameIn = h('input', { type: 'text' });
  nameIn.value = localStorage.getItem(TTS_KEY) || '読み上げ音声';
  nameIn.addEventListener('change', () => { try { localStorage.setItem(TTS_KEY, nameIn.value); } catch {} });
  const withSub = h('input', { type: 'checkbox', checked: true });
  const makeAudio = async () => {
    const text = ta.value.trim();
    if (!text) { toast('文章を入力してください'); return; }
    try { await navigator.clipboard.writeText(text); } catch {}
    location.href = `shortcuts://run-shortcut?name=${encodeURIComponent(nameIn.value)}&input=text&text=${encodeURIComponent(text)}`;
  };
  const pick = () => { $('ttsFile').value = ''; $('ttsFile').click(); };
  $('ttsFile').onchange = async (e) => {
    const f = e.target.files[0];
    const text = ta.value.trim();
    const a = await addAudioFile(f, 'tts', text ? text.slice(0, 20) : '読み上げ');
    if (!a) return;
    if (withSub.checked && text) {
      const last = S.proj.texts[S.proj.texts.length - 1];
      const base = last ? { font: last.font, size: last.size, fill: last.fill, fill2: last.fill2, o1: last.o1 && { ...last.o1 }, o2: last.o2 && { ...last.o2 }, shadow: { ...last.shadow }, box: { ...last.box }, anim: 'none' } : { anim: 'none' };
      const c = newTextClip(a.start, a.end - a.start, { ...base, text, y: 0.85, size: last ? Math.min(last.size, 0.07) : 0.06 });
      S.proj.texts.push(c);
      commit();
    }
    toast('読み上げ音声を追加しました');
    closePanel(false);
    select('audio', a.id);
  };
  body.append(sec('動画に入れる',
    h('div', { class: 'help' },
      'iPhoneの「ショートカット」Appで、文章を音声ファイルにしてから読み込みます（AI不使用・端末内で完結）。',
      h('ol', {},
        h('li', {}, '下の「① 音声ファイルを作る」→ ショートカットが音声を作り、ファイルに保存します'),
        h('li', {}, 'このアプリに戻り「② 作った音声を読み込む」で選びます'))),
    h('div', { class: 'row2' }, h('span', {}, '同じ文章を字幕にする'), h('label', { class: 'switch' }, withSub, h('span'))),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn-accent', onclick: makeAudio }, '① 音声ファイルを作る'),
      h('button', { class: 'btn-accent', onclick: pick }, '② 作った音声を読み込む')),
    h('details', {},
      h('summary', {}, 'はじめに：ショートカットの作り方（1回だけ）'),
      h('div', { class: 'help' },
        h('ol', {},
          h('li', {}, 'iPhoneの「ショートカット」Appを開き、右上の「＋」で新規作成'),
          h('li', {}, 'アクションの検索で「音声」と入力し、「テキストから音声を作成」（英語表示: Make Spoken Audio from Text）を追加'),
          h('li', {}, 'テキストの部分をタップして「ショートカットの入力」を選ぶ'),
          h('li', {}, '「＞」を開いて、声（Kyoko、Otoya など）と速さを選ぶ。「毎回尋ねる」にすると毎回声を選べます'),
          h('li', {}, '続けて「ファイルを保存」アクションを追加（保存先は「ファイル」Appのお好きなフォルダ）'),
          h('li', {}, '画面上部の名前を下と同じ名前にして保存')),
        h('div', { class: 'row2' }, h('span', {}, 'ショートカット名'), h('div', { style: { width: '55%' } }, nameIn)),
        h('p', {}, '声を増やしたいときは、iPhoneの「設定 → アクセシビリティ → 読み上げコンテンツ → 声」から日本語・英語の声を追加ダウンロードできます（無料）。'),
        h('p', {}, 'うまくいかない場合は、ショートカットを使わずに、録音した声や他のアプリで作った音声ファイルを「② 作った音声を読み込む」で入れることもできます。')))));
}

// ---------------------------------------------------------------------------
// 音声補正（ライブEQ の機能: 自動EQ・プリセット・詳細EQ・ドラムコンプ・音量合わせ ＋ エフェクト）

const DSP = globalThis.DSP;
const LOUD = { loud: -10.5, normal: -14 };
const EQ_PRESETS = {
  natural: { drum: { kick: 0, snare: 0, scoop: 0, mix: 0.4 }, delta: {} },
  rock: { drum: { kick: 4, snare: 3, scoop: 3, mix: 0.3 }, delta: { kick: 1, snare: 2 } },
  metal: { drum: { kick: 8, snare: 7, scoop: 7, mix: 0.2 }, delta: { kick: 2, snare: 3 } },
};
const FX_OFF = {
  reverb: { on: false, mix: 0.2, size: 0.65, tone: 0.6, predelay: 20 },
  echo: { on: false, mix: 0.25, time: 280, feedback: 0.35 },
  dist: { on: false, drive: 10, tone: 0.6, mix: 0.4 },
  width: { on: false, amount: 40 },
};
const FX_PRESETS = [
  { key: 'none', label: 'なし', fx: {} },
  { key: 'live', label: '豪華ライブ', fx: { reverb: { on: true, mix: 0.22, size: 0.75, tone: 0.55, predelay: 25 }, width: { on: true, amount: 45 } } },
  { key: 'acoustic', label: '弾き語り', fx: { reverb: { on: true, mix: 0.18, size: 0.55, tone: 0.7, predelay: 15 }, width: { on: true, amount: 25 } } },
  { key: 'hall', label: 'ホール', fx: { reverb: { on: true, mix: 0.32, size: 0.9, tone: 0.5, predelay: 40 }, width: { on: true, amount: 50 } } },
  { key: 'rock', label: 'ロック', fx: { dist: { on: true, drive: 8, tone: 0.55, mix: 0.3 }, reverb: { on: true, mix: 0.12, size: 0.5, tone: 0.6, predelay: 10 }, width: { on: true, amount: 30 } } },
  { key: 'echo', label: 'エコー', fx: { echo: { on: true, mix: 0.3, time: 320, feedback: 0.4 }, reverb: { on: true, mix: 0.1, size: 0.5, tone: 0.6, predelay: 10 } } },
];
const MINE_KEY = 'videdit.eqmine.v1';
const clone = (o) => JSON.parse(JSON.stringify(o));

function newAfx() {
  const a = S.analysis;
  return {
    on: true, preset: 'natural', fxPreset: 'none', depth: 1,
    bands: a ? DSP.autoBands(a.auto) : clone(DSP.BAND_DEFS),
    drum: { ...EQ_PRESETS.natural.drum },
    loud: 'loud',
    fx: clone(FX_OFF),
  };
}

// 解析用ワーカー
let afxReq = 0;
const afxPending = new Map();
function afxCall(type, data = {}, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++afxReq;
    afxPending.set(id, { resolve, reject });
    S.afxWorker.postMessage({ id, type, ...data }, transfer);
  });
}
async function startAfxAnalysis(m, a) {
  try {
    if (S.afxWorker) S.afxWorker.terminate();
    afxPending.clear();
    S.afxWorker = new Worker('js/fx-worker.js');
    S.afxWorker.onmessage = (e) => {
      const r = e.data, p = afxPending.get(r.id);
      if (!p) return;
      afxPending.delete(r.id);
      r.error ? p.reject(new Error(r.error)) : p.resolve(r);
    };
    const L = resample(a.channels[0], a.sampleRate, SR), R = resample(a.channels[1] || a.channels[0], a.sampleRate, SR);
    await afxCall('init', { fs: SR, L: L.slice(), R: R.slice() });
    const { analysis } = await afxCall('analyze');
    if (S.media !== m) return;
    S.analysis = analysis;
    S.afxReady = true;
    if (S.proj.afx && S.proj.afx.preset === 'natural' && S.proj.afx.untouched) {
      S.proj.afx.bands = DSP.autoBands(analysis.auto);
      delete S.proj.afx.untouched;
    }
    afxChanged(false);
    if (S.panel === 'audio') openPanel('audio');
  } catch (e) {
    console.warn('afx analysis', e);
    S.afxReady = 'none';
    if (S.panel === 'audio') openPanel('audio');
  }
}

function afxParams() {
  const a = S.proj && S.proj.afx;
  if (!a || !a.on) return null;
  const inGain = S.analysis ? S.analysis.inGain : 0;
  return { inGain, hpf: 32, bands: a.bands, depth: a.depth, drum: a.drum, fx: a.fx, outGain: a.loud === 'off' ? -inGain : S.afxGain, limit: true, bypass: false };
}
function pushAfx() {
  const n = S.audio.fx;
  if (!n) return;
  const p = afxParams();
  n.port.postMessage({ type: 'params', params: p && S.afxAB !== 'orig' ? p : { bypass: true, bands: [], drum: EQ_PRESETS.natural.drum } });
}

// 音量合わせ（設定が変わるたびに、少し待ってから計算し直す）
let gainTimer = 0, gainSeq = 0;
function scheduleAfxGain(delay = 350) {
  clearTimeout(gainTimer);
  const a = S.proj && S.proj.afx;
  if (!a || !a.on || a.loud === 'off' || S.afxReady !== true) return;
  gainTimer = setTimeout(async () => {
    const seq = ++gainSeq;
    try {
      const r = await afxCall('gain', { params: { ...afxParams(), outGain: 0 }, target: LOUD[a.loud], quick: true });
      if (seq !== gainSeq) return;
      S.afxGain = r.gain;
      pushAfx();
    } catch (e) { console.warn(e); }
  }, delay);
}
function afxChanged(gain = true) {
  pushAfx();
  if (gain) scheduleAfxGain();
  else scheduleAfxGain(0);
  drawEqGraph();
}

async function afxExportParams() {
  const p = afxParams();
  if (!p) return null;
  const a = S.proj.afx;
  if (a.loud !== 'off' && S.afxReady === true) {
    try {
      const r = await afxCall('gain', { params: { ...p, outGain: 0 }, target: LOUD[a.loud], quick: false });
      p.outGain = r.gain;
    } catch (e) { console.warn(e); }
  }
  return p;
}

// 試聴用 AudioWorklet（<video> の音声 → EQ・エフェクト → 音量 → スピーカー）
async function loadFxWorklet() {
  const A = S.audio;
  if (A.fx || A.fxLoading || !A.ctx || !A.ctx.audioWorklet) return A.fxLoading;
  A.fxLoading = (async () => {
    try {
      const src = await Promise.all(['js/dsp.js', 'js/fx-worklet.js'].map((u) => fetch(u).then((r) => r.text())));
      const url = URL.createObjectURL(new Blob([src.join('\n')], { type: 'application/javascript' }));
      await A.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(A.ctx, 'fx-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      node.port.onmessage = (e) => { if (e.data.type === 'peak') showMeter(e.data.peak); };
      A.src.disconnect();
      A.src.connect(node).connect(A.gain);
      A.fx = node;
      pushAfx();
    } catch (e) {
      console.warn('fx worklet', e);
    }
  })();
  return A.fxLoading;
}

function showMeter(peak) {
  const el = document.getElementById('afxMeter');
  if (!el) return;
  const db = 20 * Math.log10(peak + 1e-9);
  el.style.width = clamp((db + 36) / 36 * 100, 0, 100) + '%';
  el.classList.toggle('hot', db > -1.5);
}

// --- EQ グラフ（詳細画面） ---
const GW = 320, GH = 170, DBS = 6;
const gfx = (f) => (Math.log10(f / 20) / 3) * GW;
const gxf = (x) => 20 * Math.pow(10, (3 * x) / GW);
const ggy = (g) => GH / 2 - g * DBS;
const gyg = (y) => (GH / 2 - y) / DBS;
const GFREQS = Array.from({ length: 161 }, (_, i) => 20 * Math.pow(10, (3 * i) / 160));
const fmtG = (g) => (g > 0 ? '+' : '') + Math.round(g * 10) / 10;
const fmtF = (f) => (f >= 1000 ? Math.round(f / 100) / 10 + 'k' : Math.round(f)) + 'Hz';

function drawEqGraph() {
  const svg = document.getElementById('eqGraph');
  const a = S.proj && S.proj.afx;
  if (!svg || !a) return;
  const resp = DSP.eqResponse(a.bands, a.depth, SR, 32, GFREQS);
  let html = '<defs><linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5e9cff" stop-opacity=".45"/><stop offset="1" stop-color="#b45cff" stop-opacity="0"/></linearGradient>'
    + '<linearGradient id="eqLine" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#4fd1ff"/><stop offset=".5" stop-color="#7a8bff"/><stop offset="1" stop-color="#d36bff"/></linearGradient></defs>';
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) html += `<line class="grid" x1="${gfx(f)}" x2="${gfx(f)}" y1="0" y2="${GH}"/>`;
  for (const g of [-12, -6, 6, 12]) html += `<line class="grid" x1="0" x2="${GW}" y1="${ggy(g)}" y2="${ggy(g)}"/><text x="3" y="${ggy(g) - 2}">${fmtG(g)}</text>`;
  html += `<line class="zero" x1="0" x2="${GW}" y1="${ggy(0)}" y2="${ggy(0)}"/>`;
  if (S.analysis) {
    const pts = S.analysis.ltas.filter((b) => b.f >= 20 && b.f <= 20000);
    html += `<path class="spec" d="${pts.map((b, i) => (i ? 'L' : 'M') + gfx(b.f).toFixed(1) + ' ' + ggy(clamp(b.db * 0.45, -13, 13)).toFixed(1)).join('')}"/>`;
  }
  const line = resp.map((r, i) => (i ? 'L' : 'M') + gfx(GFREQS[i]).toFixed(1) + ' ' + ggy(clamp(r, -14, 14)).toFixed(1)).join('');
  html += `<path class="area" d="${line}L${GW} ${GH}L0 ${GH}Z"/><path class="curve" d="${line}"/>`;
  a.bands.forEach((b, i) => {
    html += `<circle class="dot${i === S.afxSel ? ' sel' : ''}" cx="${gfx(b.f).toFixed(1)}" cy="${ggy(clamp(b.g * a.depth, -13, 13)).toFixed(1)}" r="${i === S.afxSel ? 9 : 7}"/>`;
  });
  svg.innerHTML = html;
}

function bindEqDrag(svg) {
  let drag = null;
  const toLocal = (e) => {
    const r = svg.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * GW, y: ((e.clientY - r.top) / r.height) * GH };
  };
  svg.addEventListener('pointerdown', (e) => {
    const a = S.proj.afx, p = toLocal(e);
    let best = -1, bd = 1e9;
    a.bands.forEach((b, i) => {
      const d = Math.hypot(gfx(b.f) - p.x, ggy(b.g * a.depth) - p.y);
      if (d < bd) { bd = d; best = i; }
    });
    if (bd > 28) return;
    S.afxSel = best;
    drag = { id: e.pointerId };
    svg.setPointerCapture(e.pointerId);
    refreshPanelValues();
    drawEqGraph();
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const a = S.proj.afx, p = toLocal(e), b = a.bands[S.afxSel];
    b.f = Math.round(clamp(gxf(p.x), 25, 18000));
    b.g = Math.round(clamp(gyg(p.y) / (a.depth || 1), -12, 12) * 2) / 2;
    a.preset = '';
    pushAfx();
    drawEqGraph();
    refreshPanelValues();
  });
  const end = () => { if (drag) { drag = null; commit(); afxChanged(); } };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
}

function loadMine() { try { return JSON.parse(localStorage.getItem(MINE_KEY) || 'null'); } catch { return null; } }
function applyEqPreset(name) {
  const a = S.proj.afx;
  const auto = S.analysis ? DSP.autoBands(S.analysis.auto) : clone(DSP.BAND_DEFS);
  if (name === 'mine') {
    const m = loadMine();
    if (!m) return;
    a.bands = auto.map((b) => { const d = m.bands[b.id] || {}; return { ...b, g: b.g + (d.dg || 0), f: d.f || b.f, q: d.q || b.q }; });
    a.drum = { ...m.drum };
    a.depth = m.depth;
    if (m.fx) a.fx = clone(m.fx);
    if (m.loud) a.loud = m.loud;
  } else {
    const p = EQ_PRESETS[name];
    a.bands = auto.map((b) => ({ ...b, g: b.g + (p.delta[b.id] || 0) }));
    a.drum = { ...p.drum };
  }
  a.preset = name;
  delete a.untouched;
}
function saveMine() {
  const a = S.proj.afx;
  const auto = S.analysis ? DSP.autoBands(S.analysis.auto) : clone(DSP.BAND_DEFS);
  const bands = {};
  for (const b of a.bands) {
    const x = auto.find((y) => y.id === b.id);
    bands[b.id] = { dg: b.g - x.g, f: Math.abs(b.f - x.f) > 0.5 ? b.f : 0, q: Math.abs(b.q - x.q) > 0.01 ? b.q : 0 };
  }
  try {
    localStorage.setItem(MINE_KEY, JSON.stringify({ bands, drum: a.drum, depth: a.depth, fx: a.fx, loud: a.loud }));
    a.preset = 'mine';
    toast('マイ設定として保存しました。次の動画でも使えます');
    openPanel('audio');
  } catch { toast('保存できませんでした'); }
}

function buildAudioFx(body) {
  const p = S.proj;
  ensureAudioCtx();
  if (!p.src.hasAudio) {
    body.append(h('p', { class: 'lbl' }, 'この動画には音声がありません。'));
    return;
  }
  if (!p.afx) {
    if (S.afxReady !== true && S.afxReady !== 'none') {
      body.append(h('div', { class: 'center-row' }, h('div', { class: 'spinner sm' }), h('span', { class: 'lbl' }, '音を解析中…（自動EQの準備）')));
      return;
    }
    p.afx = newAfx();
    commit();
    afxChanged(false);
  }
  const a = p.afx;
  // 値が変わったときの共通処理
  const ch = (fn, keepPreset) => (v) => { fn(v); if (!keepPreset) a.preset = ''; delete a.untouched; afxChanged(); };

  // A/B 切り替えとメーター
  const ab = h('div', { class: 'seg' },
    h('button', { 'data-v': 'orig', onclick: () => { S.afxAB = 'orig'; pushAfx(); refreshPanelValues(); } }, '原音'),
    h('button', { 'data-v': 'proc', onclick: () => { S.afxAB = 'proc'; pushAfx(); refreshPanelValues(); } }, '補正後'));
  refreshers.push(() => { for (const b of ab.children) b.classList.toggle('on', b.dataset.v === S.afxAB); });
  const head = h('div', { class: 'afx-head' }, ab,
    h('button', { class: 'play-mini', onclick: () => (S.playing ? pause() : play()) }, '▶︎ / ❚❚'),
    h('div', { class: 'meter' }, h('div', { id: 'afxMeter' })));

  if (S.afxView === 'detail') {
    $('panelTitle').textContent = '詳細EQ';
    body.append(head);
    body.append(h('button', { class: 'link', onclick: () => { S.afxView = 'basic'; openPanel('audio'); } }, '‹ 基本に戻る'));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'eqGraph';
    svg.setAttribute('viewBox', `0 0 ${GW} ${GH}`);
    bindEqDrag(svg);
    body.append(h('div', { class: 'card eq-card' }, svg, h('div', { class: 'axis' }, ...['50', '200', '1k', '5k', '20kHz'].map((t) => h('span', {}, t)))));
    const cur = () => a.bands[S.afxSel];
    body.append(h('div', { class: 'card' },
      chips({ scroll: true, options: a.bands.map((b, i) => ({ v: i, label: b.name })), get: () => S.afxSel, set: (i) => { S.afxSel = i; refreshPanelValues(); drawEqGraph(); } }),
      slider({ label: '周波数', min: 0, max: 1000, step: 1, get: () => Math.round((gfx(cur().f) / GW) * 1000), set: ch((v) => (cur().f = Math.round(gxf((v / 1000) * GW)))), show: () => fmtF(cur().f) }),
      slider({ label: 'ゲイン', min: -12, max: 12, step: 0.5, get: () => cur().g, set: ch((v) => (cur().g = v)), show: fmtG }),
      slider({ label: 'Q（幅）', min: 0.3, max: 8, step: 0.1, get: () => cur().q, set: ch((v) => (cur().q = v)), show: (v) => v.toFixed(1) })));
    body.append(h('div', { class: 'card' }, h('div', { class: 'sec-title' }, 'ドラムコンプ'),
      slider({ label: 'キックの圧', min: 0, max: 10, step: 1, get: () => a.drum.kick, set: ch((v) => (a.drum.kick = v)) }),
      slider({ label: 'スネアの圧', min: 0, max: 10, step: 1, get: () => a.drum.snare, set: ch((v) => (a.drum.snare = v)) }),
      slider({ label: 'ドンシャリ', min: 0, max: 10, step: 1, get: () => a.drum.scoop, set: ch((v) => (a.drum.scoop = v)) }),
      slider({ label: '原音ミックス', min: 0, max: 100, step: 5, get: () => Math.round(a.drum.mix * 100), set: ch((v) => (a.drum.mix = v / 100)), show: (v) => v + '%' })));
    body.append(h('div', { class: 'btn-row' },
      h('button', { onclick: saveMine }, '設定を保存'),
      h('button', { onclick: () => { a.depth = 1; applyEqPreset('natural'); commit(); afxChanged(); openPanel('audio'); } }, '自動に戻す')));
    drawEqGraph();
    refreshPanelValues();
    return;
  }

  $('panelTitle').textContent = '音声補正';
  body.append(head);
  body.append(toggle({ label: '動画の音声を補正する', get: () => a.on, set: (v) => { a.on = v; afxChanged(); renderTimeline(); } }));

  const band = (id) => a.bands.find((b) => b.id === id);
  const macro = (label, id, min, max, invert) => slider({
    label, min, max, step: 0.5,
    get: () => (invert ? -band(id).g : band(id).g),
    set: ch((v) => (band(id).g = invert ? -v : v)),
    show: (v) => (invert ? Math.round(v * 10) / 10 + '' : fmtG(v)),
  });
  const mine = loadMine();
  body.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('span', { class: 'sec-title' }, '自動EQ'), h('span', { class: 'badge' }, S.analysis ? S.analysis.kind : '解析なし')),
    slider({ label: '効き具合', min: 0, max: 150, step: 5, get: () => Math.round(a.depth * 100), set: ch((v) => (a.depth = v / 100), true), show: (v) => v + '%' }),
    h('div', { class: 'sec-title' }, 'プリセット'),
    chips({
      options: [{ v: 'natural', label: 'ナチュラル' }, { v: 'rock', label: 'ロック' }, { v: 'metal', label: 'メタル' }, ...(mine ? [{ v: 'mine', label: 'マイ設定' }] : [])],
      get: () => a.preset, set: (v) => { applyEqPreset(v); afxChanged(); refreshPanelValues(); },
    }),
    macro('ボーカル', 'vocal', -6, 8),
    macro('キック', 'kick', -6, 10),
    macro('スネア', 'snare', -6, 8),
    macro('こもり除去', 'mud', 0, 10, true),
    macro('きらびやか', 'air', -6, 8),
    h('button', { class: 'link', onclick: () => { S.afxView = 'detail'; openPanel('audio'); } }, '詳細EQ・ドラムコンプ ›')));

  // エフェクト
  const fxRow = (key, title, desc, sliders) => {
    const box = h('div', { class: 'fx-row' });
    const detail = h('div', { class: 'fx-detail' }, ...sliders);
    const refresh = () => { box.classList.toggle('on', a.fx[key].on); detail.hidden = !a.fx[key].on; };
    refreshers.push(refresh);
    box.append(
      h('div', { class: 'row2' }, h('div', {}, h('div', {}, title), h('div', { class: 'lbl' }, desc)),
        (() => { const t = h('input', { type: 'checkbox' }); t.checked = a.fx[key].on; t.addEventListener('change', () => { a.fx[key].on = t.checked; a.fxPreset = ''; commit(); afxChanged(); refreshPanelValues(); }); refreshers.push(() => (t.checked = a.fx[key].on)); return h('label', { class: 'switch' }, t, h('span')); })()),
      detail);
    refresh();
    return box;
  };
  const fxs = (fn) => ch((v) => { fn(v); a.fxPreset = ''; }, true);
  const f = a.fx;
  body.append(h('div', { class: 'card' },
    h('div', { class: 'sec-title' }, '音のエフェクト'),
    chips({ scroll: true, options: FX_PRESETS.map((x) => ({ v: x.key, label: x.label })), get: () => a.fxPreset,
      set: (k) => { const pr = FX_PRESETS.find((x) => x.key === k); a.fx = { ...clone(FX_OFF), ...clone(pr.fx) }; a.fxPreset = k; afxChanged(); openPanel('audio'); } }),
    fxRow('reverb', 'リバーブ', 'ホールや部屋の響きを足す', [
      slider({ label: '量', min: 0, max: 0.6, step: 0.01, get: () => f.reverb.mix, set: fxs((v) => (f.reverb.mix = v)), show: (v) => Math.round(v * 100) + '' }),
      slider({ label: '広さ', min: 0, max: 1, step: 0.01, get: () => f.reverb.size, set: fxs((v) => (f.reverb.size = v)), show: (v) => Math.round(v * 100) + '' }),
      slider({ label: '明るさ', min: 0, max: 1, step: 0.01, get: () => f.reverb.tone, set: fxs((v) => (f.reverb.tone = v)), show: (v) => Math.round(v * 100) + '' }),
      slider({ label: '響くまで', min: 0, max: 80, step: 1, get: () => f.reverb.predelay, set: fxs((v) => (f.reverb.predelay = v)), show: (v) => v + 'ms' }),
    ]),
    fxRow('echo', 'エコー', 'やまびこのように音を繰り返す', [
      slider({ label: '量', min: 0, max: 0.7, step: 0.01, get: () => f.echo.mix, set: fxs((v) => (f.echo.mix = v)), show: (v) => Math.round(v * 100) + '' }),
      slider({ label: '間隔', min: 60, max: 900, step: 10, get: () => f.echo.time, set: fxs((v) => (f.echo.time = v)), show: (v) => v + 'ms' }),
      slider({ label: '繰り返し', min: 0, max: 0.8, step: 0.01, get: () => f.echo.feedback, set: fxs((v) => (f.echo.feedback = v)), show: (v) => Math.round(v * 100) + '' }),
    ]),
    fxRow('dist', 'ひずみ', 'ギターアンプのような歪み', [
      slider({ label: '歪ませ', min: 0, max: 30, step: 0.5, get: () => f.dist.drive, set: fxs((v) => (f.dist.drive = v)), show: (v) => v + 'dB' }),
      slider({ label: '音色', min: 0, max: 1, step: 0.01, get: () => f.dist.tone, set: fxs((v) => (f.dist.tone = v)), show: (v) => Math.round(v * 100) + '' }),
      slider({ label: '量', min: 0, max: 1, step: 0.01, get: () => f.dist.mix, set: fxs((v) => (f.dist.mix = v)), show: (v) => Math.round(v * 100) + '%' }),
    ]),
    fxRow('width', 'ステレオ拡張', '左右の広がりを強める', [
      slider({ label: '広がり', min: 0, max: 100, step: 1, get: () => f.width.amount, set: fxs((v) => (f.width.amount = v)) }),
    ])));

  body.append(h('div', { class: 'card' },
    h('div', { class: 'sec-title' }, '音量'),
    chips({ options: [{ v: 'loud', label: '大音量（-10.5 LUFS）' }, { v: 'normal', label: '標準（-14 LUFS）' }, { v: 'off', label: 'そのまま' }], get: () => a.loud, set: (v) => { a.loud = v; afxChanged(); } }),
    h('p', { class: 'lbl' }, '大音量・標準は、補正後の音を自動で決まった大きさに揃えます（音割れ防止つき）。')));
  body.append(h('p', { class: 'lbl' }, 'タイムラインで動画を選んでもこの画面を開けます。再生しながら調整できます。'));
  refreshPanelValues();
}

// ---------------------------------------------------------------------------
// 重ねる画像・動画（オーバーレイ）

function previewOverlaySource(ov) {
  const m = S.ovMedia.get(ov.mediaId);
  if (!m) return null;
  if (m.type === 'image') return { w: m.width, h: m.height, draw: (c, x, y, w, h) => c.drawImage(m.bitmap, x, y, w, h) };
  const el = S.ovEls.get(ov.id);
  if (!el || el.readyState < 2) return null;
  return { w: m.width, h: m.height, draw: (c, x, y, w, h) => c.drawImage(el, x, y, w, h) };
}

function ovEl(ov) {
  let el = S.ovEls.get(ov.id);
  if (!el) {
    const m = S.ovMedia.get(ov.mediaId);
    el = document.createElement('video');
    el.className = 'ov-el';
    el.muted = true;
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.preload = 'auto';
    el.src = m.url;
    el.addEventListener('seeked', requestDraw);
    el.addEventListener('loadeddata', requestDraw);
    $('stage').append(el);
    S.ovEls.set(ov.id, el);
  }
  return el;
}

// 試聴用の <video> を、メインの再生位置に合わせる
function syncOverlayVideos() {
  if (!S.proj) return;
  const ids = new Set();
  for (const ov of S.proj.overlays) {
    if (ov.type !== 'video' || !S.ovMedia.has(ov.mediaId)) continue;
    ids.add(ov.id);
    const active = S.t >= ov.start && S.t < ov.end;
    const el = S.ovEls.get(ov.id) || (active ? ovEl(ov) : null);
    if (!el) continue;
    if (!active) { if (!el.paused) el.pause(); continue; }
    const want = ov.offset + (S.t - ov.start);
    if (S.playing) {
      if (el.paused) { el.currentTime = want; el.play().catch(() => {}); }
      else if (Math.abs(el.currentTime - want) > 0.25) el.currentTime = want;
    } else {
      if (!el.paused) el.pause();
      if (!el.seeking && Math.abs(el.currentTime - want) > 0.02) el.currentTime = want;
    }
  }
  for (const [id, el] of S.ovEls) if (!ids.has(id)) { el.pause(); el.remove(); S.ovEls.delete(id); }
}

async function addOverlayFile(file) {
  if (!file) return;
  const isVideo = file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm)$/i.test(file.name);
  toast(isVideo ? '動画を読み込み中…' : '画像を読み込み中…', 20000);
  try {
    const id = newId('m');
    const m = { id, type: isVideo ? 'video' : 'image', name: file.name.replace(/\.[^.]+$/, ''), file };
    const th = h('canvas');
    if (isVideo) {
      const md = await openVideo(file);
      Object.assign(m, { width: md.info.width, height: md.info.height, duration: md.info.duration, fps: md.info.fps, url: URL.createObjectURL(file) });
      try {
        const sink = new CanvasSink(md.videoTrack, { height: 64 });
        const wc = await sink.getCanvas(md.firstTimestamp + Math.min(0.5, md.info.duration / 2));
        if (wc) m.thumb = wc.canvas.toDataURL('image/jpeg', 0.6);
      } catch {}
      if (md.audioTrack) {
        try {
          const a = await decodeSourceAudio(md, 0, md.info.duration);
          if (a) {
            const chs = a.channels.map((c) => resample(c, a.sampleRate, SR));
            const buf = new AudioBuffer({ length: chs[0].length, numberOfChannels: 2, sampleRate: SR });
            buf.copyToChannel(chs[0], 0);
            buf.copyToChannel(chs[1] || chs[0], 1);
            S.buffers.set(id, buf);
          }
        } catch (e) { console.warn('overlay audio', e); }
      }
    } else {
      m.bitmap = await createImageBitmap(file);
      m.width = m.bitmap.width;
      m.height = m.bitmap.height;
      const k = 64 / m.height;
      th.width = Math.max(1, Math.round(m.width * k)); th.height = 64;
      th.getContext('2d').drawImage(m.bitmap, 0, 0, th.width, th.height);
      m.thumb = th.toDataURL('image/jpeg', 0.7);
    }
    S.ovMedia.set(id, m);
    const o = outputSize(S.proj);
    const ov = newOverlay(clamp(S.t, 0, Math.max(0, dur() - 0.1)), m, o.w, o.h);
    if (!isVideo) ov.end = Math.min(ov.end, Math.max(ov.start + 0.5, dur()));
    S.proj.overlays.push(ov);
    commit();
    $('toast').hidden = true;
    openItemPanel('overlay', ov.id);
  } catch (e) {
    console.error(e);
    toast('このファイルは読み込めませんでした');
  }
}
$('ovFile').addEventListener('change', (e) => addOverlayFile(e.target.files[0]));

function buildOverlay(body, ov) {
  const m = S.ovMedia.get(ov.mediaId);
  const place = (k) => {
    const o = outputSize(S.proj);
    const wf = ov.scale, hf = m ? (ov.scale * o.w * (m.height / m.width)) / o.h : ov.scale;
    const mg = 0.04;
    if (k === 'full') { ov.rot = 0; const fit = m ? Math.min(1, (o.h / o.w) * (m.width / m.height)) : 1; ov.scale = fit; ov.x = 0.5; ov.y = 0.5; return; }
    ov.x = k.includes('l') ? mg + wf / 2 : k.includes('r') ? 1 - mg - wf / 2 : 0.5;
    ov.y = k.includes('t') ? mg + hf / 2 : k.includes('b') ? 1 - mg - hf / 2 : 0.5;
  };
  body.append(sec(m ? `${ov.type === 'video' ? '動画' : '画像'}：${ov.name}（${m.width}×${m.height}）` : ov.name,
    h('div', { class: 'btn-row' }, ...[['tl', '左上'], ['tr', '右上'], ['c', '中央'], ['bl', '左下'], ['br', '右下'], ['full', '全画面']].map(([k, l]) =>
      h('button', { onclick: () => { place(k); commit(); refreshPanelValues(); requestDraw(); } }, l))),
    slider({ label: '大きさ', min: 0.03, max: 1.5, step: 0.005, get: () => ov.scale, set: (v) => (ov.scale = v), show: (v) => Math.round(v * 100) + '%' }),
    slider({ label: '横位置', min: 0, max: 1, step: 0.005, get: () => ov.x, set: (v) => (ov.x = v), show: (v) => Math.round(v * 100) + '' }),
    slider({ label: '縦位置', min: 0, max: 1, step: 0.005, get: () => ov.y, set: (v) => (ov.y = v), show: (v) => Math.round(v * 100) + '' }),
    slider({ label: '回転', min: -180, max: 180, step: 1, get: () => ov.rot, set: (v) => (ov.rot = v), show: (v) => v + '°' }),
    slider({ label: '不透明度', min: 0.05, max: 1, step: 0.01, get: () => ov.opacity, set: (v) => (ov.opacity = v), show: (v) => Math.round(v * 100) + '%' }),
    h('p', { class: 'lbl' }, 'プレビュー上でドラッグして移動、2本指で拡大縮小できます。')));
  const borderDetail = h('div', {},
    colors({ get: () => ov.border.color, set: (v) => (ov.border.color = v) }),
    slider({ label: '太さ', min: 0.002, max: 0.04, step: 0.001, get: () => ov.border.width, set: (v) => (ov.border.width = v), show: (v) => Math.round(v * 1000) / 10 + '' }));
  refreshers.push(() => (borderDetail.hidden = !ov.border.on));
  borderDetail.hidden = !ov.border.on;
  body.append(sec('見た目',
    chips({ options: [{ v: 'rect', label: '四角' }, { v: 'round', label: '角丸' }, { v: 'circle', label: '円' }], get: () => ov.shape, set: (v) => (ov.shape = v) }),
    toggle({ label: '縁取り', get: () => ov.border.on, set: (v) => { ov.border.on = v; refreshPanelValues(); } }), borderDetail,
    toggle({ label: '影', get: () => ov.shadow, set: (v) => (ov.shadow = v) }),
    toggle({ label: '左右反転', get: () => ov.flip, set: (v) => (ov.flip = v) }),
    h('div', { class: 'sec-title' }, '出かた'),
    chips({ options: [{ v: 'none', label: 'なし' }, { v: 'fade', label: 'フェード' }, { v: 'pop', label: 'ポン' }, { v: 'slide', label: '下から' }], get: () => ov.anim, set: (v) => (ov.anim = v) })));
  if (ov.type === 'video') {
    body.append(sec('音声',
      S.buffers.get(ov.mediaId)
        ? slider({ label: '音量', min: 0, max: 2, step: 0.01, get: () => ov.volume, set: (v) => (ov.volume = v), show: (v) => Math.round(v * 100) + '%' })
        : h('p', { class: 'lbl' }, 'この動画には音声がありません')));
  }
  body.append(timingButtons(ov));
  body.append(h('div', { class: 'btn-row' },
    h('button', { onclick: () => duplicateItem('overlay', ov.id) }, '複製'),
    h('button', { class: 'danger', style: { color: 'var(--danger)' }, onclick: () => deleteItem('overlay', ov.id) }, '削除')));
}

// ---------------------------------------------------------------------------
// ツール

$('tools').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !S.proj) return;
  const tool = b.dataset.tool;
  if (tool === 'text') addText();
  else if (tool === 'music') { $('audioFile').value = ''; $('audioFile').click(); }
  else if (tool === 'overlay') { $('ovFile').value = ''; $('ovFile').click(); }
  else if (tool === 'effect') openPanel('effectPick');
  else openPanel(tool);
});
$('audioFile').addEventListener('change', async (e) => {
  const a = await addAudioFile(e.target.files[0], 'music');
  if (a) { select('audio', a.id); toast('音楽を追加しました。音量はタップして調整できます'); }
});

// ---------------------------------------------------------------------------
// 書き出し

const EXP = { limit: 'auto', fps: 30, codec: 'avc', quality: 'high' };
let exportAbort = null, exportResult = null, encCaps = null;

async function openExport() {
  if (!S.proj) return;
  pause();
  if (S.panel) closePanel(false);
  const p = S.proj;
  const srcFps = p.src.fps;
  EXP.fps = srcFps;
  $('expSettings').hidden = false;
  $('expRun').hidden = true;
  $('expDone').hidden = true;
  $('sheet').hidden = false;
  const box = $('expOptions');
  box.innerHTML = '';
  refreshers = [];
  const o = outputSize(p);
  const resOpts = [{ v: 'auto', label: `元の画質 ${o.w}×${o.h}` }];
  const short = Math.min(o.w, o.h);
  if (short > 1080) resOpts.push({ v: 1080, label: '1080p' });
  if (short > 720) resOpts.push({ v: 720, label: '720p' });
  const fpsOpts = [{ v: srcFps, label: `元と同じ ${+srcFps.toFixed(2)}` }];
  for (const f of [60, 30, 24]) if (f < srcFps - 1) fpsOpts.push({ v: f, label: f + 'fps' });
  const est = () => {
    const s = outputSize(p, EXP.limit);
    const br = bitrateFor(s.w, s.h, EXP.fps, EXP.codec, EXP.quality);
    const mb = ((br + 256000) * dur()) / 8 / 1e6;
    $('expEstimate').textContent = `${s.w}×${s.h}・${+EXP.fps.toFixed(2)}fps・約${Math.round(br / 1e6)}Mbps・予想サイズ 約${mb < 10 ? mb.toFixed(1) : Math.round(mb)}MB（${fmt(dur())}）`;
  };
  box.append(
    h('div', { class: 'sec-title' }, '解像度'), chips({ options: resOpts, get: () => EXP.limit, set: (v) => (EXP.limit = v), onChange: est }),
    h('div', { class: 'sec-title' }, 'フレームレート'), chips({ options: fpsOpts, get: () => EXP.fps, set: (v) => (EXP.fps = v), onChange: est }),
    h('div', { class: 'sec-title' }, '形式'), chips({ options: [{ v: 'avc', label: 'H.264（互換性重視）' }, { v: 'hevc', label: 'HEVC（同じ画質で小さめ）' }], get: () => EXP.codec, set: (v) => (EXP.codec = v), onChange: est }),
    h('div', { class: 'sec-title' }, '画質'), chips({ options: [{ v: 'high', label: '高画質' }, { v: 'max', label: '最高画質（容量大）' }], get: () => EXP.quality, set: (v) => (EXP.quality = v), onChange: est }),
  );
  est();
  try {
    encCaps = await detectEncoders(o.w, o.h, EXP.fps);
    if (!encCaps.avc && !encCaps.hevc) $('expEstimate').textContent += '\n⚠ この端末では、この解像度の書き出しに対応していない可能性があります';
    else if (!encCaps.hevc) { EXP.codec = 'avc'; refreshPanelValues(); est(); }
  } catch {}
}

async function startExport() {
  $('expSettings').hidden = true;
  $('expRun').hidden = false;
  $('prog').style.width = '0%';
  $('runTitle').textContent = '書き出し中…';
  $('runMsg').textContent = '準備中…';
  exportAbort = new AbortController();
  let wake = null;
  try { wake = await navigator.wakeLock?.request('screen'); } catch {}
  try {
    await Promise.all(S.proj.texts.map((c) => ensureFont(c.font, c.text)));
    $('runMsg').textContent = '音声補正の音量を計算中…';
    const afx = await afxExportParams();
    const res = await exportVideo({
      media: S.media, proj: S.proj, buffers: S.buffers, overlayMedia: S.ovMedia,
      settings: { ...EXP, afx },
      signal: exportAbort.signal,
      onProgress: (phase, k, extra) => {
        let pct, msg;
        if (phase === 'audio') { pct = k * 8; msg = '音声を処理中…'; }
        else if (phase === 'video') {
          pct = 8 + k * 90;
          const eta = extra?.eta;
          msg = `映像を書き出し中… ${extra?.frame}/${extra?.frames} フレーム` + (eta != null && extra.frame > 20 ? `・残り約${eta >= 60 ? Math.ceil(eta / 60) + '分' : Math.ceil(eta) + '秒'}` : '');
        } else { pct = 99; msg = 'ファイルを仕上げ中…'; }
        $('prog').style.width = pct.toFixed(1) + '%';
        $('runMsg').textContent = msg;
      },
    });
    exportResult = res.file;
    const url = URL.createObjectURL(res.file);
    $('resultVideo').src = url;
    const dl = $('download');
    dl.href = url;
    dl.download = res.file.name;
    $('share').hidden = !(navigator.canShare && navigator.canShare({ files: [res.file] }));
    const codecName = { avc: 'H.264', hevc: 'HEVC' }[res.codec] || res.codec.toUpperCase();
    $('doneMsg').textContent = `${res.width}×${res.height}・${+res.fps.toFixed(2)}fps・${codecName}・${(res.file.size / 1e6).toFixed(1)}MB` +
      (res.audioCodec === 'pcm' ? '（音声は無圧縮）' : '');
    $('expRun').hidden = true;
    $('expDone').hidden = false;
  } catch (e) {
    if (e.name === 'AbortError' || exportAbort.signal.aborted) { $('sheet').hidden = true; toast('書き出しを中止しました'); }
    else {
      console.error(e);
      $('runTitle').textContent = '書き出しに失敗しました';
      $('runMsg').textContent = String(e.message || e) + '（解像度やフレームレートを下げると成功することがあります）';
      $('expAbort').textContent = '閉じる';
    }
  } finally {
    try { await wake?.release(); } catch {}
  }
}

$('exportBtn').addEventListener('click', openExport);
$('expStart').addEventListener('click', startExport);
$('expCancel').addEventListener('click', () => ($('sheet').hidden = true));
$('expAbort').addEventListener('click', () => {
  if ($('expAbort').textContent === '閉じる') { $('sheet').hidden = true; $('expAbort').textContent = '中止'; return; }
  exportAbort?.abort();
});
$('closeSheet').addEventListener('click', () => {
  $('sheet').hidden = true;
  $('resultVideo').pause();
  $('resultVideo').removeAttribute('src');
});
$('share').addEventListener('click', async () => {
  try { await navigator.share({ files: [exportResult] }); } catch (e) { if (e.name !== 'AbortError') toast('共有できませんでした。「ファイルとして保存」を使ってください'); }
});

// ---------------------------------------------------------------------------
// 起動

$('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
$('file2').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
$('undo').addEventListener('click', () => undoRedo(-1));
$('redo').addEventListener('click', () => undoRedo(1));
window.addEventListener('resize', () => { if (S.proj) { layoutPreview(); renderTimeline(); scrollToTime(); } });
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
addFontCss();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

// テスト用
window.__app = { S, EXP, loadFile, exportVideo, openExport, startExport, addAudioFile, commit, renderTimeline, requestDraw, seek };
