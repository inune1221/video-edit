// 画面の動作
import {
  createProject, timelineDuration, ASPECTS, cropForAspect, outputSize,
  newClip, clipTimes, clipAt, srcTimeAt, groupsOf, fitRect, subProject, clipLen,
  assignLanes, TEXT_PRESETS, newTextClip, applyPreset, EFFECT_TYPES, newEffect, newAudioClip,
  snapshot, restore, newId, newOverlay,
} from './project.js';
import { renderFrame, drawText, textBounds, overlayRect } from './render.js';
import { FONTS, fontByKey, addFontCss, ensureFont } from './fonts.js';
import { decodeAudioFile, computePeaks, resample, SR } from './audio.js';
import { openVideo, decodeSourceAudio, exportVideo, detectEncoders, bitrateFor } from './media.js';
import { CanvasSink } from './vendor/mediabunny.min.mjs';
import { drawMain, TRANSITIONS, MOTIONS } from './compose.js';
import { COLOR_PRESETS, defaultColor, defaultChroma, applyColorPreset, colorActive, edgeColor } from './gl.js';
import { resolveKf } from './render.js';
import { putProject, getProject, listProjects, putFile, getFile, deleteProject, storageInfo, requestPersist } from './store.js';

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
  fileReg: new Map(), // 保存用: 'kind:id' -> File（素材のファイル）
  projId: null, stored: new Set(),
  srcs: new Map(), // 素材 srcId -> { file, url, el(<video>), media, info, thumbs, peaks }
  cur: null, // プレビュー中の素材
  curClip: null, // プレビュー中のクリップ（clipTimes の要素）
  t: 0, playing: false, pps: 40, sel: null, panel: null,
  history: [], hIndex: -1,
  audio: { ctx: null, gain: null, nodes: [], elemOk: false, src: null, fx: null, fxLoading: null },
  expectScroll: -1,
  // 音声補正
  ovMedia: new Map(), // 重ねる素材 mediaId -> { type, file, url, bitmap, width, height, duration, fps, thumb }
  ovEls: new Map(), // 試聴用の <video>（重ねる動画クリップごと）
  analysis: null, afxWorker: null, afxReady: false, afxGain: 0, afxAB: 'proc', afxView: 'basic', afxSel: 1,
};
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
  scheduleSave();
}
function undoRedo(d) {
  const i = S.hIndex + d;
  if (i < 0 || i >= S.history.length) return;
  S.hIndex = i;
  restore(S.proj, S.history[i]);
  scheduleSave();
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
// 読み込み（複数の動画をつなげられる）

// 素材（動画ファイル）を1つ読み込む。S.srcs に登録して返す
async function openSource(file, fixedId) {
  const media = await openVideo(file);
  if (!media.canDecodeVideo) toast('この動画の形式は書き出しに対応していない可能性があります', 4000);
  const id = fixedId || newId('s');
  S.fileReg.set('s:' + id, file);
  const url = URL.createObjectURL(file);
  const el = document.createElement('video');
  el.className = 'src-el';
  el.playsInline = true;
  el.setAttribute('playsinline', '');
  el.preload = 'auto';
  el.muted = true;
  el.src = url;
  $('stage').prepend(el);
  await new Promise((res, rej) => {
    el.onloadedmetadata = res;
    el.onerror = () => rej(new Error(`${file.name} は再生できません`));
    el.load();
  });
  // iPhone はフレームを読み込ませるために一度だけ無音で再生しておく
  try { await el.play(); el.pause(); } catch {}
  const s = { id, file, url, el, media, info: media.info, duration: media.info.duration, thumbs: [], peaks: null, seekBusy: false, seekPending: null };
  el.addEventListener('seeked', () => {
    s.seekBusy = false;
    if (s.seekPending != null) { const v = s.seekPending; s.seekPending = null; seekEl(s, v); }
    requestDraw();
  });
  S.srcs.set(id, s);
  if (S.audio.ctx) attachSourceAudio(s);
  return s;
}

function resetProject() {
  pause();
  for (const s of S.srcs.values()) { s.el.pause(); s.el.remove(); URL.revokeObjectURL(s.url); }
  S.srcs.clear();
  S.cur = null;
  S.buffers.clear();
  S.peaks.clear();
  for (const el of S.ovEls.values()) { el.pause(); el.remove(); }
  S.ovEls.clear();
  for (const m of S.ovMedia.values()) if (m.url) URL.revokeObjectURL(m.url);
  S.ovMedia.clear();
  S.history = [];
  S.hIndex = -1;
  S.sel = null;
  S.t = 0;
  S.fileReg.clear();
  S.projId = null;
  S.analysis = null;
  S.afxReady = false;
  S.afxGain = 0;
  if (S.afxWorker) { S.afxWorker.terminate(); S.afxWorker = null; }
}

// 新しく編集を始める（複数選択したときは選んだ順に並べる）
async function loadFiles(files) {
  files = [...(files || [])];
  if (!files.length) return;
  show('loading');
  const hadProj = !!S.proj;
  try {
    if (S.proj) await saveNow();
    resetProject();
    S.proj = null;
    const list = [];
    for (let i = 0; i < files.length; i++) {
      $('loadMsg').textContent = files.length > 1 ? `読み込み中…（${i + 1}/${files.length}）` : '読み込み中…';
      list.push(await openSource(files[i]));
    }
    const f = list[0].info;
    S.proj = createProject({ width: f.width, height: f.height, fps: f.fps });
    S.projId = newId('p');
    S.stored = new Set();
    S.saveSkip = new Set();
    requestPersist();
    for (const s of list) S.proj.clips.push(newClip(s));
    commit();
    show('editor');
    closePanel(true);
    fitZoom();
    layoutPreview();
    afterTimingChange();
    seek(0);
    startAfxWorker();
    for (const s of list) { loadThumbs(s); loadSourceWave(s); }
  } catch (e) {
    console.error(e);
    alert('読み込みに失敗しました: ' + (e.message || e));
    show(hadProj && S.proj ? 'editor' : 'start');
  }
}

// 編集中の動画の後ろに追加する
async function addVideos(files) {
  files = [...(files || [])];
  if (!files.length || !S.proj) return;
  pause();
  try {
    const added = [];
    for (let i = 0; i < files.length; i++) {
      toast(`動画を追加中…（${i + 1}/${files.length}）`, 60000);
      added.push(await openSource(files[i]));
    }
    for (const s of added) S.proj.clips.push(newClip(s));
    $('toast').hidden = true;
    commit();
    afterTimingChange();
    for (const s of added) { loadThumbs(s); loadSourceWave(s); }
    toast(`${added.length}本の動画を後ろに追加しました`);
  } catch (e) {
    console.error(e);
    toast('追加できませんでした: ' + (e.message || e), 4000);
  }
}

function show(id) {
  for (const s of ['start', 'loading', 'editor']) $(s).hidden = s !== id;
}

async function loadThumbs(s) {
  try {
    const m = s.media;
    const sink = new CanvasSink(m.videoTrack, { height: 64, poolSize: 0 });
    const n = clamp(Math.round(m.info.duration / 2), 6, 40);
    const times = Array.from({ length: n }, (_, i) => m.firstTimestamp + ((i + 0.5) * m.info.duration) / n);
    const out = [];
    for await (const wc of sink.canvasesAtTimestamps(times)) {
      if (!S.srcs.has(s.id)) return;
      if (!wc) continue;
      out.push({ t: wc.timestamp - m.firstTimestamp, url: wc.canvas.toDataURL('image/jpeg', 0.6) });
    }
    s.thumbs = out;
    renderTimeline();
  } catch (e) {
    console.warn('thumbs', e);
  }
}

// 波形の表示と、音声補正の解析用に素材の音声をデコードする（読み込みは1本ずつ順番に）
let waveQueue = Promise.resolve();
function loadSourceWave(s) {
  waveQueue = waveQueue.then(async () => {
    const m = s.media;
    if (!m.audioTrack || m.info.duration > 900 || !S.srcs.has(s.id)) { afxSourcesChanged(); return; }
    try {
      const a = await decodeSourceAudio(m, 0, m.info.duration);
      if (!a || !S.srcs.has(s.id)) return;
      s.peaks = computePeaks(a.channels, Math.ceil(m.info.duration * 100));
      renderTimeline();
      if (S.afxWorker) {
        const L = resample(a.channels[0], a.sampleRate, SR), R = resample(a.channels[1] || a.channels[0], a.sampleRate, SR);
        await afxCall('addSource', { sid: s.id, L: L === a.channels[0] ? L.slice() : L, R: R === a.channels[0] || R === a.channels[1] ? R.slice() : R });
      }
      afxSourcesChanged();
    } catch (e) {
      console.warn('wave', e);
      afxSourcesChanged();
    }
  });
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
  if (cropMode()) { aw = S.proj.frame.width; ah = S.proj.frame.height; }
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
  $('resInfo').textContent = `${o.w}×${o.h}・${+S.proj.frame.fps.toFixed(2)}fps` + (S.proj.clips.length > 1 ? `・${S.proj.clips.length}クリップ` : '');
  requestDraw();
}

// トランジション用のもう1本の <video>（つなぎ目で前後のクリップを同時に見せる）
const auxEl = document.createElement('video');
auxEl.className = 'src-el';
auxEl.muted = true;
auxEl.playsInline = true;
auxEl.setAttribute('playsinline', '');
auxEl.preload = 'auto';
auxEl.addEventListener('seeked', () => requestDraw());
$('stage').prepend(auxEl);
let auxSrc = null, auxUsed = false;

function auxFrame(x, st) {
  const s = S.srcs.get(x.clip.srcId);
  if (!s) return null;
  auxUsed = true;
  if (auxSrc !== s) { auxSrc = s; auxEl.src = s.url; auxEl.currentTime = Math.max(0, st); }
  const want = clamp(st, 0, s.duration - 0.03);
  auxEl.playbackRate = x.clip.speed;
  if (S.playing) {
    if (auxEl.paused) { auxEl.currentTime = want; auxEl.play().catch(() => {}); }
    else if (Math.abs(auxEl.currentTime - want) > 0.25) auxEl.currentTime = want;
  } else {
    if (!auxEl.paused) auxEl.pause();
    if (!auxEl.seeking && Math.abs(auxEl.currentTime - want) > 0.03) auxEl.currentTime = want;
  }
  if (auxEl.readyState < 2) return null;
  return { w: s.info.width, h: s.info.height, draw: (c, X, Y, W, H) => c.drawImage(auxEl, X, Y, W, H) };
}

// プレビュー: 再生中の素材の <video>、トランジション中のもう片方は auxEl から取る
function previewFrame(x, st) {
  const s = S.srcs.get(x.clip.srcId);
  if (s && S.cur === s && S.curClip && S.curClip.clip === x.clip) {
    if (s.el.readyState < 2) return null;
    return { w: s.info.width, h: s.info.height, draw: (c, X, Y, W, H) => c.drawImage(s.el, X, Y, W, H) };
  }
  return auxFrame(x, st);
}

// プレビュー中のクリップの映像を、画面（frame）の座標で描く
function drawSourceFromVideo(c) {
  auxUsed = false;
  drawMain(c, S.proj, S.t, previewFrame);
  if (!auxUsed && !auxEl.paused) auxEl.pause();
}

function draw() {
  if (!S.proj) return;
  const W = preview.width, H = preview.height;
  if (cropMode()) {
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    pctx.fillStyle = '#000';
    pctx.fillRect(0, 0, W, H);
    pctx.setTransform(W / S.proj.frame.width, 0, 0, H / S.proj.frame.height, 0, 0);
    drawSourceFromVideo(pctx);
    pctx.setTransform(1, 0, 0, 1, 0, 0);
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
      const b = overlayRect(resolveKf(ov, S.t), W, H, m.width, m.height);
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
      const b = textBounds(pctx, resolveKf(c, S.t), W, H);
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

function seekEl(src, t) {
  if (src.seekBusy) { src.seekPending = t; return; }
  src.seekBusy = true;
  src.el.currentTime = clamp(t, 0, Math.max(0, (src.el.duration || src.duration) - 0.001));
}

// 時刻 t のクリップをプレビューに出す（素材が変わるときは <video> を切り替える）
function showClipAt(t) {
  const x = clipAt(S.proj, t);
  if (!x) return null;
  const s = S.srcs.get(x.clip.srcId);
  if (S.cur && S.cur !== s) S.cur.el.pause();
  S.cur = s;
  S.curClip = x;
  s.el.playbackRate = x.clip.speed;
  s.el.preservesPitch = x.clip.keepPitch;
  s.el.webkitPreservesPitch = x.clip.keepPitch;
  if (s.gain) s.gain.gain.value = x.clip.volume;
  return { x, s };
}

function seek(t, fromScroll = false) {
  S.t = clamp(t, 0, dur());
  if (S.panel === 'item' && S.sel && (S.sel.kind === 'text' || S.sel.kind === 'overlay')) {
    const it = findItem(S.sel.kind, S.sel.id);
    if (it && it.kf && it.kf.length) { applyResolved(it); refreshPanelValues(); }
  }
  const r = showClipAt(S.t);
  if (r) seekEl(r.s, srcTimeAt(r.x, S.t));
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
    // 素材ごとの音声 → mix →（音声補正）→ gain（全体の音量）→ スピーカー
    A.mix = A.ctx.createGain();
    A.gain = A.ctx.createGain();
    A.mix.connect(A.gain).connect(A.ctx.destination);
    A.elemOk = true;
    for (const s of S.srcs.values()) attachSourceAudio(s);
    loadFxWorklet();
  }
  if (A.ctx.state !== 'running') A.ctx.resume();
  return A.ctx;
}

function attachSourceAudio(s) {
  const A = S.audio;
  if (s.node) return;
  try {
    s.node = A.ctx.createMediaElementSource(s.el);
    s.gain = A.ctx.createGain();
    s.node.connect(s.gain).connect(A.mix);
    s.el.muted = false;
  } catch (e) {
    console.warn('media element source', e);
    A.elemOk = false;
  }
}

function applyOrigVolume() {
  const A = S.audio;
  if (A.gain) A.gain.gain.value = S.proj.origVolume;
  for (const s of S.srcs.values()) s.el.muted = s.node ? false : S.proj.origVolume <= 0;
}

// iPhone では音の出る再生はタップの中でしか始められないので、最初の再生のときに全部の素材を一度動かしておく
function unlockSources(active) {
  for (const s of S.srcs.values()) {
    if (s.unlocked || s === active) { s.unlocked = true; continue; }
    s.unlocked = true;
    const t = s.el.currentTime;
    s.el.play().then(() => { if (S.cur !== s || !S.playing) { s.el.pause(); s.el.currentTime = t; } }).catch(() => { s.unlocked = false; });
  }
}

async function play() {
  if (!S.proj || S.playing) return;
  const ctx = ensureAudioCtx();
  applyOrigVolume();
  if (S.t >= dur() - 0.05) S.t = 0;
  const r = showClipAt(S.t);
  unlockSources(r.s);
  r.s.el.currentTime = srcTimeAt(r.x, S.t);
  try { await r.s.el.play(); } catch (e) { console.warn(e); return; }
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

// 素材の再生位置からタイムラインの時刻を出す
function curTime() {
  const s = S.cur, x = S.curClip;
  if (!s || !x) return S.t;
  return x.start + (s.el.currentTime - x.clip.in) / x.clip.speed;
}

function tick() {
  if (!S.playing) return;
  const s = S.cur, x = S.curClip;
  if (s.el.seeking) { draw(); requestAnimationFrame(tick); return; }
  let t = curTime();
  if (t >= x.end - 0.02 || s.el.currentTime >= x.clip.out - 0.02 || s.el.ended) {
    // 次のクリップへ
    const all = clipTimes(S.proj);
    const nx = all[x.index + 1];
    if (!nx) { pause(); seek(dur()); return; }
    const contiguous = nx.clip.srcId === x.clip.srcId && Math.abs(nx.clip.in - s.el.currentTime) < 0.08 && nx.clip.speed === x.clip.speed;
    const r = showClipAt(nx.start + 1e-4);
    if (!contiguous) {
      r.s.el.currentTime = nx.clip.in;
      if (r.s.el.paused) r.s.el.play().catch((e) => { console.warn(e); pause(); });
    }
    t = nx.start;
  }
  S.t = clamp(t, 0, dur());
  updateTime();
  scrollToTime();
  draw();
  requestAnimationFrame(tick);
}

function pause() {
  if (!S.playing) return;
  S.playing = false;
  if (S.cur) S.cur.el.pause();
  for (const el of S.ovEls.values()) el.pause();
  auxEl.pause();
  for (const n of S.audio.nodes) { try { n.stop(); } catch {} }
  S.audio.nodes = [];
  $('playIcon').innerHTML = '<path d="M8 5v14l11-7z"/>';
  if (S.curClip && S.cur && !S.cur.el.seeking) S.t = clamp(curTime(), S.curClip.start, Math.max(S.curClip.start, S.curClip.end - 0.001));
  S.t = clamp(S.t, 0, dur());
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
  return listOf(kind).find((x) => x.id === id) || null;
}
function listOf(kind) {
  return { video: S.proj.clips, text: S.proj.texts, effect: S.proj.effects, overlay: S.proj.overlays, audio: S.proj.audios }[kind];
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

const kfDots = (it) => (it.kf || []).map((k) => h('i', { class: 'kf-dot', style: { left: k.t * S.pps - 4 + 'px' } }));
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
  const isSel = (kind, id) => S.sel && S.sel.kind === kind && S.sel.id === id;
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

  // 動画（クリップの並び）
  {
    const groups = groupsOf(p);
    for (const g of groups) {
      if (g.items.length > 1) {
        // 合体したかたまり
        tlInner.append(h('div', { class: 'group-bar', style: { left: pad + g.start * S.pps + 'px', width: (g.end - g.start) * S.pps + 'px', top: y + ROW.video + 1 + 'px' } }));
      }
      g.items.forEach((x, gi) => {
        const c = x.clip, src = S.srcs.get(c.srcId);
        const w = (x.end - x.start) * S.pps;
        const extra = [];
        if (src && src.thumbs.length) {
          const box = h('div', { class: 'thumbs' });
          const th = ROW.video * 0.62;
          const tw = th * (src.info.width / src.info.height);
          const n = Math.min(200, Math.ceil(w / tw));
          for (let k = 0; k < n; k++) {
            const st = c.in + (((k + 0.5) * tw) / S.pps) * c.speed;
            let best = src.thumbs[0];
            for (const t of src.thumbs) if (Math.abs(t.t - st) < Math.abs(best.t - st)) best = t;
            box.append(h('img', { src: best.url, style: { width: tw + 'px' } }));
          }
          extra.push(box);
        }
        if (src && src.peaks && p.origVolume > 0 && c.volume > 0) extra.push(waveCanvas(src.peaks, c.in, c.out, w));
        const label = [c.speed !== 1 ? `${+c.speed.toFixed(2)}x` : '', x.index === 0 && p.afx && p.afx.on ? '🎚 補正' : ''].filter(Boolean).join('  ');
        const el = clipEl('video', c.id, x.start * S.pps, w, y, ROW.video, 'video', label, extra);
        if (g.items.length > 1) el.classList.add(gi === 0 ? 'g-first' : gi === g.items.length - 1 ? 'g-last' : 'g-mid');
      });
    }
    // つなぎ目のトランジションボタン
    const tsAll = clipTimes(p);
    for (let i = 0; i < tsAll.length - 1; i++) {
      const c = tsAll[i].clip, on = c.trans && c.trans.type !== 'none';
      tlInner.append(h('button', { class: 'trans-btn' + (on ? ' on' : ''), title: 'トランジション', style: { left: pad + tsAll[i].end * S.pps - 12 + 'px', top: y + ROW.video / 2 - 12 + 'px' }, onclick: () => openTrans(c.id) }, on ? '◆' : '⇄'));
    }
    // 動画を後ろに追加するボタン
    tlInner.append(h('button', { class: 'add-clip', style: { left: pad + total * S.pps + 8 + 'px', top: y + 8 + 'px' }, onclick: () => { $('addVideo').value = ''; $('addVideo').click(); } }, '＋'));
    y += ROW.video + ROW.gap + 4;
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
    (o) => { const m = S.ovMedia.get(o.mediaId); return [m && m.thumb ? h('img', { class: 'ov-thumb', src: m.thumb }) : null, ...kfDots(o)]; });
  lanesFor(p.texts, 'text', 'text', ROW.text, (c) => 'T ' + c.text.replace(/\n/g, ' '), (c) => kfDots(c));
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
  afxSourcesChanged();
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
    o: kind === 'video' ? { in: item.in, out: item.out } : { start: item.start, end: item.end, offset: item.offset },
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
    const c = findItem('video', d.id), src = S.srcs.get(c.srcId);
    if (d.handle === 'l') {
      c.in = clamp(d.o.in + dt * c.speed, 0, c.out - 0.1);
      d.el.style.left = d.left + ((c.in - d.o.in) / c.speed) * S.pps + 'px';
      d.el.style.width = clipLen(c) * S.pps + 'px';
      const x = clipTimes(p).find((y) => y.clip === c);
      seek(x.start, true);
    } else if (d.handle === 'r') {
      c.out = clamp(d.o.out + dt * c.speed, c.in + 0.1, src.duration);
      d.el.style.width = clipLen(c) * S.pps + 'px';
      const x = clipTimes(p).find((y) => y.clip === c);
      seek(x.end - 0.04, true);
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
      h('button', { onclick: () => openPanel('speed') }, '速度・クリップ'),
      h('button', { onclick: () => openPanel('color') }, 'フィルター・動き'),
      h('button', { onclick: () => splitClip(id) }, '分割'),
      ...clipMergeButtons(id),
      h('button', { onclick: () => moveClip(id, -1) }, '← 前へ'),
      h('button', { onclick: () => moveClip(id, 1) }, '後ろへ →'),
      h('button', { onclick: () => duplicateClip(id) }, '複製'),
      h('button', { class: 'danger', onclick: () => deleteClip(id) }, '削除'),
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

// --- メインの動画クリップの操作 ---
const clipIndex = (id) => S.proj.clips.findIndex((c) => c.id === id);

function splitClip(id) {
  const x = clipTimes(S.proj).find((y) => y.clip.id === id);
  if (!x || S.t <= x.start + 0.05 || S.t >= x.end - 0.05) { toast('再生位置（白い線）をクリップの途中に合わせてください'); return; }
  const st = srcTimeAt(x, S.t);
  const b = { ...x.clip, id: newId('c'), in: st, group: newId('g') };
  x.clip.out = st;
  S.proj.clips.splice(x.index + 1, 0, b);
  commit();
  afterTimingChange();
  select('video', b.id);
}

// 隣のクリップと合体（同じ動画の続きなら1本のクリップに戻す。違う動画なら1つのかたまりにまとめる）
function mergeWithNext(id) {
  const i = clipIndex(id), a = S.proj.clips[i];
  const g = groupsOf(S.proj);
  const gi = g.findIndex((x) => x.items.some((y) => y.clip.id === id));
  const next = g[gi + 1];
  if (!next) { toast('後ろにクリップがありません'); return; }
  const last = g[gi].items[g[gi].items.length - 1].clip, b = next.items[0].clip;
  const same = last.srcId === b.srcId && Math.abs(last.out - b.in) < 1e-3 && last.speed === b.speed && last.keepPitch === b.keepPitch && last.volume === b.volume && last.fit === b.fit;
  for (const y of next.items) y.clip.group = a.group;
  if (same) {
    last.out = b.out;
    S.proj.clips.splice(S.proj.clips.indexOf(b), 1);
  }
  commit();
  afterTimingChange();
  select('video', a.id);
  toast(same ? '1本のクリップに戻しました' : '1つのかたまりに合体しました');
}
function unmerge(id) {
  const a = S.proj.clips[clipIndex(id)];
  const g = groupsOf(S.proj).find((x) => x.items.some((y) => y.clip.id === id));
  for (const y of g.items) y.clip.group = newId('g');
  commit();
  renderTimeline();
  select('video', a.id);
}
function clipMergeButtons(id) {
  const g = groupsOf(S.proj);
  const gi = g.findIndex((x) => x.items.some((y) => y.clip.id === id));
  const out = [];
  if (gi < g.length - 1) out.push(h('button', { onclick: () => mergeWithNext(id) }, '後ろと合体'));
  if (g[gi] && g[gi].items.length > 1) out.push(h('button', { onclick: () => unmerge(id) }, '合体を解除'));
  return out;
}
function moveClip(id, d) {
  const i = clipIndex(id), j = i + d, cs = S.proj.clips;
  if (j < 0 || j >= cs.length) return;
  [cs[i], cs[j]] = [cs[j], cs[i]];
  commit();
  afterTimingChange();
  const x = clipTimes(S.proj).find((y) => y.clip.id === id);
  seek(x.start);
  select('video', id);
}
function duplicateClip(id) {
  const i = clipIndex(id);
  const b = { ...S.proj.clips[i], id: newId('c'), group: newId('g') };
  S.proj.clips.splice(i + 1, 0, b);
  commit();
  afterTimingChange();
  select('video', b.id);
}
function deleteClip(id) {
  if (S.proj.clips.length <= 1) { toast('最後の1本は削除できません'); return; }
  S.proj.clips.splice(clipIndex(id), 1);
  S.sel = null;
  commit();
  afterTimingChange();
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
    const b = textBounds(pctx, resolveKf(c, S.t), preview.width, preview.height);
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
      const b = overlayRect(resolveKf(o, S.t), preview.width, preview.height, m.width, m.height);
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
    applyResolved(hit);
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
    if (d.type === 'text' || d.type === 'overlay') syncKf(d.target);
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
    syncKf(d.target);
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
  const builders = { speed: buildSpeed, volume: buildVolume, crop: buildCrop, tts: buildTts, effectPick: buildEffectPick, audio: buildAudioFx, color: buildColorPanel, trans: buildTransPanel };
  const titles = { speed: '速度', volume: '音量バランス', crop: '切り抜き', tts: '読み上げ', effectPick: 'エフェクトを追加', audio: '音声補正', color: 'フィルター・動き', trans: 'トランジション' };
  $('panelTitle').textContent = title || titles[name] || '';
  if (builders[name]) builders[name](body);
  if (wasCrop !== cropMode()) layoutPreview();
  else if (name === 'audio') requestAnimationFrame(layoutPreview);
  requestDraw();
}

function openItemPanel(kind, id) {
  S.onItemEdit = null;
  if (kind === 'video') { S.sel = { kind, id }; openPanel('speed'); return; }
  S.sel = { kind, id };
  openPanel('item', { text: 'テキスト', effect: 'エフェクト', overlay: '重ねる素材', audio: '音声' }[kind]);
  const body = $('panelBody');
  const it = findItem(kind, id);
  if (kind === 'text' || kind === 'overlay') { applyResolved(it); S.onItemEdit = () => syncKf(it); }
  if (kind === 'text') buildText(body, it);
  else if (kind === 'effect') buildEffect(body, it);
  else if (kind === 'overlay') buildOverlay(body, it);
  if (kind === 'text' || kind === 'overlay') {
    // キーフレームは削除ボタンの前に入れる
    const last = body.lastElementChild;
    body.insertBefore(kfSection(it), last);
  }
  else buildAudio(body, it);
}

function closePanel(silent) {
  S.onItemEdit = null;
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
  input.addEventListener('input', () => { set(+input.value); out.textContent = show ? show(+input.value) : input.value; S.onItemEdit && S.onItemEdit(); requestDraw(); });
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
    a.fileKey = newId('f');
    S.fileReg.set('a:' + a.fileKey, file);
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
  body.append(sec('動画の音声（全体）',
    slider({ label: '元の音量', min: 0, max: 2, step: 0.01, get: () => p.origVolume, set: (v) => { p.origVolume = v; applyOrigVolume(); }, show: (v) => Math.round(v * 100) + '%' }),
    [...S.srcs.values()].some((x) => x.info.hasAudio) ? null : h('p', { class: 'lbl' }, 'この動画には音声がありません')));
  if (!p.audios.length) body.append(h('p', { class: 'lbl' }, '「音楽」や「読み上げ」で音声を追加すると、ここで動画の音とのバランスを調整できます。'));
  for (const a of p.audios) {
    body.append(sec((a.kind === 'tts' ? '🗣 ' : '♪ ') + a.name + `（${fmt(a.start)}〜）`,
      slider({ label: '音量', min: 0, max: 2, step: 0.01, get: () => a.volume, set: (v) => (a.volume = v), show: (v) => Math.round(v * 100) + '%' })));
  }
  body.append(h('p', { class: 'lbl' }, '100% が元の大きさです。再生しながら調整できます。'));
}

// --- 速度 ---
// 操作するクリップ: 選択中のクリップ、なければ再生位置のクリップ
function targetClip() {
  if (S.sel && S.sel.kind === 'video') { const c = findItem('video', S.sel.id); if (c) return c; }
  return clipAt(S.proj, S.t).clip;
}

function buildSpeed(body) {
  const p = S.proj;
  const c = targetClip();
  const src = S.srcs.get(c.srcId);
  const n = clipIndex(c.id) + 1;
  $('panelTitle').textContent = p.clips.length > 1 ? `クリップ ${n}/${p.clips.length}` : 'クリップ';
  const toPos = (v) => Math.log2(v), fromPos = (v) => Math.round(Math.pow(2, v) * 100) / 100;
  const after = () => { afterTimingChange(); };
  body.append(sec('再生速度',
    slider({ label: '速度', min: -2, max: 2, step: 0.01, get: () => toPos(c.speed), set: (v) => (c.speed = fromPos(v)), show: (v) => fromPos(v) + 'x', onChange: after }),
    chips({ options: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((v) => ({ v, label: v + 'x' })), get: () => c.speed, set: (v) => { c.speed = v; refreshPanelValues(); }, onChange: after }),
    toggle({ label: '声の高さを保つ', get: () => c.keepPitch, set: (v) => (c.keepPitch = v) }),
    p.clips.length > 1 ? h('button', { class: 'wide', onclick: () => { for (const x of p.clips) { x.speed = c.speed; x.keepPitch = c.keepPitch; } commit(); afterTimingChange(); toast('すべてのクリップを同じ速度にしました'); } }, 'この速度をすべてのクリップに使う') : null,
    h('p', { class: 'lbl' }, '速度を変えると動画の長さが変わります。文字や音楽の位置はそのままなので、必要に応じて調整してください。')));
  body.append(sec('このクリップの音量', slider({ label: '音量', min: 0, max: 2, step: 0.01, get: () => c.volume, set: (v) => { c.volume = v; if (S.cur && S.curClip && S.curClip.clip === c && S.cur.gain) S.cur.gain.gain.value = v; }, show: (v) => Math.round(v * 100) + '%', onChange: renderTimeline })));
  if (src.info.width / src.info.height !== p.frame.width / p.frame.height) {
    body.append(sec('画面への合わせ方（縦横比が違う動画）', chips({ options: [{ v: 'contain', label: '全体を表示（黒い帯）' }, { v: 'cover', label: '画面いっぱい（はみ出しを切る）' }], get: () => c.fit, set: (v) => (c.fit = v) })));
  }
  const info = h('p', { class: 'lbl' });
  const refresh = () => (info.textContent = `${src.info.name} の ${fmt(c.in)} 〜 ${fmt(c.out)} を使用（出力 ${fmt(clipLen(c))}）`);
  refresh();
  refreshers.push(refresh);
  const cut = (side) => {
    const x = clipTimes(p).find((y) => y.clip === c);
    if (S.t <= x.start + 0.05 || S.t >= x.end - 0.05) { toast('再生位置をこのクリップの途中に合わせてください'); return; }
    const st = srcTimeAt(x, S.t);
    if (side === 'before') c.in = st; else c.out = st;
    commit(); afterTimingChange(); if (side === 'before') seek(x.start); refresh();
  };
  body.append(sec('使う範囲（トリミング）', info,
    h('div', { class: 'btn-row' },
      h('button', { onclick: () => cut('before') }, 'ここより前を削除'),
      h('button', { onclick: () => cut('after') }, 'ここより後を削除')),
    h('button', { class: 'wide', onclick: () => { c.in = 0; c.out = src.duration; commit(); afterTimingChange(); refresh(); } }, '範囲をリセット'),
    h('p', { class: 'lbl' }, 'タイムラインでクリップを選ぶと、両端の白いつまみでも範囲を変えられます。')));
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
function afxCall(type, data = {}, transfer = [], onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++afxReq;
    afxPending.set(id, { resolve, reject, onProgress });
    S.afxWorker.postMessage({ id, type, ...data }, transfer);
  });
}
function startAfxWorker() {
  if (S.afxWorker) S.afxWorker.terminate();
  afxPending.clear();
  S.afxWorker = new Worker('js/fx-worker.js');
  S.afxWorker.onmessage = (e) => {
    const r = e.data, p = afxPending.get(r.id);
    if (!p) return;
    if (r.progress != null && r.gain == null && r.analysis === undefined && !r.error) { p.onProgress && p.onProgress(r.progress); return; }
    afxPending.delete(r.id);
    r.error ? p.reject(new Error(r.error)) : p.resolve(r);
  };
}

// クリップの並びが変わったら、つなげた音声で解析し直す（少し待ってからまとめて）
let afxTimer = 0, afxSeq = 0;
function afxSourcesChanged() {
  clearTimeout(afxTimer);
  if (!S.afxWorker || !S.proj) return;
  afxTimer = setTimeout(async () => {
    const clips = S.proj.clips.map((c) => ({ srcId: c.srcId, in: c.in, out: c.out, volume: c.volume }));
    const key = JSON.stringify(clips) + [...S.srcs.values()].filter((x) => x.peaks).length;
    if (key === S.afxKey) return;
    S.afxKey = key;
    const seq = ++afxSeq;
    try {
      await afxCall('setClips', { clips });
      const { analysis } = await afxCall('analyze');
      if (seq !== afxSeq) return;
      const first = !S.analysis;
      S.analysis = analysis;
      S.afxReady = analysis ? true : 'none';
      if (analysis && S.proj.afx && S.proj.afx.untouched) { S.proj.afx.bands = DSP.autoBands(analysis.auto); delete S.proj.afx.untouched; }
      afxChanged(false);
      if (S.panel === 'audio' && (first || !S.proj.afx)) openPanel('audio');
    } catch (e) {
      console.warn('afx analysis', e);
      if (!S.analysis) S.afxReady = 'none';
      if (S.panel === 'audio') openPanel('audio');
    }
  }, 700);
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

// 書き出し前に音量合わせを正確に計算し直す（onProgress(0〜1)）
const afxNeedsGain = () => { const a = S.proj && S.proj.afx; return !!(a && a.on && a.loud !== 'off' && S.afxReady === true); };
async function afxExportParams(onProgress) {
  const p = afxParams();
  if (!p) return null;
  const a = S.proj.afx;
  if (afxNeedsGain()) {
    try {
      const r = await afxCall('gain', { params: { ...p, outGain: 0 }, target: LOUD[a.loud], quick: false }, [], onProgress);
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
      A.mix.disconnect();
      A.mix.connect(node).connect(A.gain);
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
  if (![...S.srcs.values()].some((x) => x.info.hasAudio)) {
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

// 重ねる素材を読み込んで S.ovMedia に登録する
async function loadOverlayMedia(file, fixedId, type) {
    const isVideo = type ? type === 'video' : file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm)$/i.test(file.name);
    const id = fixedId || newId('m');
    S.fileReg.set('o:' + id, file);
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
    return m;
}

async function addOverlayFile(file) {
  if (!file) return;
  const isVideo = file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm)$/i.test(file.name);
  toast(isVideo ? '動画を読み込み中…' : '画像を読み込み中…', 20000);
  try {
    const m = await loadOverlayMedia(file);
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
  body.append(chromaSection(ov));
  body.append(colorSection(ov, '色調補正・フィルター'));
  body.append(timingButtons(ov));
  body.append(h('div', { class: 'btn-row' },
    h('button', { onclick: () => duplicateItem('overlay', ov.id) }, '複製'),
    h('button', { class: 'danger', style: { color: 'var(--danger)' }, onclick: () => deleteItem('overlay', ov.id) }, '削除')));
}

// ---------------------------------------------------------------------------
// トランジション・色調補正・ズームパン・グリーンバック・キーフレーム

// --- キーフレーム ---
const KF_OF = { text: ['x', 'y', 'size', 'rot'], overlay: ['x', 'y', 'scale', 'rot', 'opacity'] };
const kindOf = (it) => (S.proj.texts.includes(it) ? 'text' : 'overlay');
// キーフレームがあるときは、再生位置の値を編集用の値に写す
function applyResolved(it) {
  if (!it || !it.kf || !it.kf.length) return;
  const r = resolveKf(it, S.t);
  for (const k of KF_OF[kindOf(it)]) it[k] = r[k];
}
// 値を変えたら、再生位置のキーフレームを追加・更新する
function syncKf(it) {
  if (!it || !it.kf || !it.kf.length) return;
  const lt = clamp(S.t - it.start, 0, it.end - it.start);
  let k = it.kf.find((x) => Math.abs(x.t - lt) < 0.04);
  if (!k) { k = { t: lt }; it.kf.push(k); it.kf.sort((a, b) => a.t - b.t); }
  for (const p of KF_OF[kindOf(it)]) k[p] = it[p];
}
function kfSection(it) {
  const kind = kindOf(it);
  const list = h('div', { class: 'chips scroll' });
  const refresh = () => {
    list.innerHTML = '';
    for (const k of it.kf || []) list.append(h('button', { class: 'chip' + (Math.abs(S.t - it.start - k.t) < 0.04 ? ' on' : ''), onclick: () => seek(it.start + k.t) }, '◆ ' + k.t.toFixed(1) + 's'));
    if (!it.kf || !it.kf.length) list.append(h('span', { class: 'lbl' }, 'キーフレームなし'));
  };
  refreshers.push(refresh);
  refresh();
  const add = () => {
    if (S.t < it.start || S.t > it.end) { toast('再生位置をこの素材の表示時間の中に合わせてください'); return; }
    if (!it.kf) it.kf = [];
    const lt = clamp(S.t - it.start, 0, it.end - it.start);
    let k = it.kf.find((x) => Math.abs(x.t - lt) < 0.04);
    if (!k) { k = { t: lt }; it.kf.push(k); it.kf.sort((a, b) => a.t - b.t); }
    for (const p of KF_OF[kind]) k[p] = it[p];
    commit(); refreshPanelValues(); renderTimeline(); requestDraw();
    if (it.kf.length === 1) toast('もう1つ別の時間にキーフレームを置くと、その間を動きます', 3500);
  };
  const del = () => {
    if (!it.kf) return;
    const lt = S.t - it.start;
    const i = it.kf.findIndex((x) => Math.abs(x.t - lt) < 0.04);
    if (i < 0) { toast('再生位置にキーフレームがありません'); return; }
    it.kf.splice(i, 1);
    commit(); refreshPanelValues(); renderTimeline(); requestDraw();
  };
  const preset = (fn) => () => {
    const len = it.end - it.start;
    const base = {};
    for (const p of KF_OF[kind]) base[p] = it[p];
    const a = { t: 0, ...base }, b = { t: len, ...base };
    fn(a, b);
    it.kf = [a, b];
    commit(); refreshPanelValues(); renderTimeline(); seek(it.start); requestDraw();
  };
  const sz = kind === 'text' ? 'size' : 'scale';
  return sec('キーフレーム（動き）', list,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn-accent', onclick: add }, '◆ 再生位置に追加'),
      h('button', { onclick: del }, '再生位置のを削除'),
      h('button', { onclick: () => { it.kf = []; commit(); refreshPanelValues(); renderTimeline(); requestDraw(); } }, '全部削除')),
    h('div', { class: 'sec-title' }, 'かんたん動き（ケン・バーンズ）'),
    h('div', { class: 'btn-row' },
      h('button', { onclick: preset((a, b) => { b[sz] = a[sz] * 1.25; }) }, 'ズームイン'),
      h('button', { onclick: preset((a, b) => { a[sz] = b[sz] * 1.25; }) }, 'ズームアウト'),
      h('button', { onclick: preset((a, b) => { a.x -= 0.15; b.x += 0.15; }) }, '左→右'),
      h('button', { onclick: preset((a, b) => { a.y += 0.12; b.y -= 0.12; }) }, '下→上')),
    h('p', { class: 'lbl' }, '別々の時間にキーフレームを置くと、その間をなめらかに動きます。キーフレームがあるときに位置や大きさを変えると、再生位置のキーフレームが自動で追加・更新されます。'));
}

// --- 色調補正 ---
function colorSection(obj, title, onAll) {
  if (!obj.color) obj.color = defaultColor();
  const c = obj.color;
  const pre = (fn) => (v) => { fn(v); c.preset = ''; };
  return sec(title,
    chips({ scroll: true, options: COLOR_PRESETS.map((p) => ({ v: p.key, label: p.label })), get: () => c.preset, set: (k) => { applyColorPreset(c, k); refreshPanelValues(); } }),
    slider({ label: '明るさ', min: -1, max: 1, step: 0.01, get: () => c.bright, set: pre((v) => (c.bright = v)), show: (v) => Math.round(v * 100) + '' }),
    slider({ label: 'コントラスト', min: 0.5, max: 1.6, step: 0.01, get: () => c.contrast, set: pre((v) => (c.contrast = v)), show: (v) => Math.round(v * 100) + '' }),
    slider({ label: '彩度', min: 0, max: 2, step: 0.01, get: () => c.sat, set: pre((v) => (c.sat = v)), show: (v) => Math.round(v * 100) + '' }),
    slider({ label: '色温度', min: -1, max: 1, step: 0.01, get: () => c.temp, set: pre((v) => (c.temp = v)), show: (v) => (v > 0 ? '暖' : v < 0 ? '寒' : '') + Math.round(Math.abs(v) * 100) }),
    slider({ label: '色かぶり', min: -1, max: 1, step: 0.01, get: () => c.tint, set: pre((v) => (c.tint = v)), show: (v) => Math.round(v * 100) + '' }),
    slider({ label: '周辺減光', min: 0, max: 1, step: 0.01, get: () => c.vig, set: pre((v) => (c.vig = v)), show: (v) => Math.round(v * 100) + '' }),
    slider({ label: 'フェード', min: 0, max: 0.6, step: 0.01, get: () => c.fade, set: pre((v) => (c.fade = v)), show: (v) => Math.round(v * 100) + '' }),
    h('div', { class: 'btn-row' },
      h('button', { onclick: () => { Object.assign(c, defaultColor()); commit(); refreshPanelValues(); requestDraw(); } }, 'リセット'),
      onAll ? h('button', { onclick: onAll }, 'すべてのクリップに使う') : null));
}

function buildColorPanel(body) {
  const c = targetClip();
  const n = clipIndex(c.id) + 1;
  $('panelTitle').textContent = S.proj.clips.length > 1 ? `フィルター・動き（クリップ ${n}）` : 'フィルター・動き';
  body.append(colorSection(c, '色調補正・フィルター', () => {
    for (const x of S.proj.clips) x.color = { ...c.color };
    commit(); requestDraw(); toast('すべてのクリップに同じ色を使いました');
  }));
  if (!c.motion) c.motion = { type: 'none', amount: 0.15 };
  body.append(sec('ズームパン（ケン・バーンズ）',
    chips({ options: MOTIONS.map((m) => ({ v: m.key, label: m.label })), get: () => c.motion.type, set: (v) => (c.motion.type = v) }),
    slider({ label: '動きの大きさ', min: 0.05, max: 0.6, step: 0.01, get: () => c.motion.amount, set: (v) => (c.motion.amount = v), show: (v) => Math.round(v * 100) + '%' }),
    h('p', { class: 'lbl' }, 'クリップの最初から最後にかけて、ゆっくり拡大・移動します。')));
  body.append(h('p', { class: 'lbl' }, 'タイムラインで別のクリップを選ぶと、そのクリップを調整できます。'));
}

// --- トランジション ---
function buildTransPanel(body) {
  const c = findItem('video', S.transClip);
  if (!c) { body.append(h('p', { class: 'lbl' }, 'つなぎ目が見つかりません')); return; }
  if (!c.trans) c.trans = { type: 'none', dur: 0.8 };
  const tr = c.trans;
  const i = clipIndex(c.id);
  $('panelTitle').textContent = `つなぎ目 ${i + 1} → ${i + 2}`;
  const playIt = () => { const x = clipTimes(S.proj)[i]; pause(); seek(Math.max(0, x.end - tr.dur / 2 - 0.6)); play(); };
  body.append(sec('トランジション',
    chips({ options: TRANSITIONS.map((t) => ({ v: t.key, label: t.label })), get: () => tr.type, set: (v) => { tr.type = v; renderTimeline(); } }),
    slider({ label: '長さ', min: 0.2, max: 2.5, step: 0.05, get: () => tr.dur, set: (v) => (tr.dur = v), show: (v) => v.toFixed(2) + '秒' }),
    h('div', { class: 'btn-row' },
      h('button', { onclick: playIt }, '▶ ここを再生'),
      h('button', { onclick: () => { for (const x of S.proj.clips.slice(0, -1)) x.trans = { ...tr }; commit(); renderTimeline(); toast('すべてのつなぎ目に使いました'); } }, 'すべてのつなぎ目に使う')),
    h('p', { class: 'lbl' }, 'つなぎ目をはさんで前後のクリップが少しずつ重なって切り替わります（全体の長さは変わりません）。')));
}
function openTrans(clipId) { S.transClip = clipId; openPanel('trans'); }

// --- グリーンバック合成（重ねる素材） ---
function chromaSection(ov) {
  if (!ov.chroma) ov.chroma = defaultChroma();
  const k = ov.chroma;
  const detail = h('div', {},
    h('div', { class: 'sec-title' }, '抜く色'),
    h('div', { class: 'btn-row' },
      h('button', { onclick: () => { k.color = '#00ff00'; commit(); refreshPanelValues(); requestDraw(); } }, '緑'),
      h('button', { onclick: () => { k.color = '#0047ff'; commit(); refreshPanelValues(); requestDraw(); } }, '青'),
      h('button', { onclick: () => autoKey(ov) }, '自動（ふちの色）')),
    colors({ get: () => k.color, set: (v) => (k.color = v) }),
    slider({ label: '抜く範囲', min: 0.01, max: 0.4, step: 0.005, get: () => k.sim, set: (v) => (k.sim = v), show: (v) => Math.round(v * 100) + '' }),
    slider({ label: 'なめらかさ', min: 0.005, max: 0.3, step: 0.005, get: () => k.smooth, set: (v) => (k.smooth = v), show: (v) => Math.round(v * 100) + '' }),
    slider({ label: '色かぶり除去', min: 0, max: 0.4, step: 0.01, get: () => k.spill, set: (v) => (k.spill = v), show: (v) => Math.round(v * 100) + '' }));
  refreshers.push(() => (detail.hidden = !k.on));
  detail.hidden = !k.on;
  return sec('グリーンバック合成',
    toggle({ label: '背景の色を透明にする', get: () => k.on, set: (v) => { k.on = v; if (v && k.auto !== false) autoKey(ov, true); refreshPanelValues(); } }),
    detail,
    h('p', { class: 'lbl' }, '緑や青の背景で撮った動画・画像の背景を消して、人物などだけを重ねます。'));
}
function autoKey(ov, quiet) {
  const src = previewOverlaySource(ov);
  if (!src) { if (!quiet) toast('素材の映像がまだ読み込まれていません'); return; }
  ov.chroma.color = edgeColor((g, w, h2) => src.draw(g, 0, 0, w, h2), src.w, src.h);
  ov.chroma.auto = false;
  commit(); refreshPanelValues(); requestDraw();
}

// ---------------------------------------------------------------------------
// 編集内容の保存と再開（端末内に自動保存）

let saveTimer = 0, saving = false, saveAgain = false, quotaWarned = false;
function scheduleSave(delay = 1500) {
  if (!S.proj || !S.projId) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, delay);
}
function usedKeys() {
  const p = S.proj, keys = new Set();
  for (const c of p.clips) keys.add('s:' + c.srcId);
  for (const o of p.overlays) keys.add('o:' + o.mediaId);
  for (const a of p.audios) if (a.fileKey) keys.add('a:' + a.fileKey);
  return [...keys];
}
function smallThumb() {
  try {
    const c = document.createElement('canvas');
    const k = 200 / Math.max(preview.width, preview.height);
    c.width = Math.max(1, Math.round(preview.width * k)); c.height = Math.max(1, Math.round(preview.height * k));
    c.getContext('2d').drawImage(preview, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.6);
  } catch { return null; }
}
async function saveNow() {
  if (!S.proj || !S.projId) return;
  if (saving) { saveAgain = true; return; }
  saving = true;
  try {
    const id = S.projId;
    const keys = usedKeys();
    const meta = keys.map((k) => { const f = S.fileReg.get(k); return { key: k, name: f ? f.name : '', size: f ? f.size : 0, type: f ? f.type : '' }; });
    const ovTypes = Object.fromEntries([...S.ovMedia.values()].map((m) => [m.id, m.type]));
    const first = S.srcs.get(S.proj.clips[0].srcId);
    const old = await getProject(id);
    await putProject({
      id, name: (first ? first.info.name : '動画').replace(/\.[^.]+$/, ''), created: old ? old.created : Date.now(), updated: Date.now(),
      thumb: smallThumb() || (old && old.thumb), duration: dur(), json: snapshot(S.proj), files: meta, ovTypes,
    });
    // 素材ファイル（まだ保存していないものだけ）
    for (const k of keys) {
      if (S.stored.has(k) || S.saveSkip?.has(k)) continue;
      const f = S.fileReg.get(k);
      if (!f) continue;
      try {
        await putFile(id + '/' + k, f);
        S.stored.add(k);
      } catch (e) {
        console.warn('save file', e);
        (S.saveSkip ||= new Set()).add(k);
        if (!quotaWarned) { quotaWarned = true; toast('空き容量が足りず、一部の素材ファイルは保存できませんでした。続きを開くときに選び直してください', 5000); }
      }
    }
  } catch (e) {
    console.warn('save', e);
  } finally {
    saving = false;
    if (saveAgain) { saveAgain = false; scheduleSave(500); }
  }
}

async function renderSavedList() {
  const box = $('savedList');
  if (!box) return;
  $('backToEdit').hidden = !S.proj;
  let list = [];
  try { list = await listProjects(); } catch { }
  box.innerHTML = '';
  box.hidden = !list.length;
  if (!list.length) return;
  box.append(h('div', { class: 'sec-title' }, '続きから編集'));
  for (const r of list) {
    const d = new Date(r.updated);
    box.append(h('div', { class: 'saved-item' },
      r.thumb ? h('img', { src: r.thumb }) : h('div', { class: 'ph' }),
      h('div', { class: 'saved-info', onclick: () => openSaved(r.id) },
        h('div', {}, r.name),
        h('div', { class: 'lbl' }, `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}・${fmt(r.duration || 0)}`)),
      h('button', { class: 'chip', onclick: () => openSaved(r.id) }, '開く'),
      h('button', { class: 'chip danger', onclick: async () => { if (!confirm(`「${r.name}」の保存データを削除しますか？`)) return; await deleteProject(r.id); renderSavedList(); } }, '削除')));
  }
  const info = await storageInfo();
  if (info && info.usage) box.append(h('p', { class: 'lbl' }, `保存データの使用量: 約${(info.usage / 1e9).toFixed(2)}GB` + (info.quota ? `（上限の目安 ${(info.quota / 1e9).toFixed(0)}GB）` : '')));
}

// 足りない素材を選び直してもらう（タップの中でファイル選択を開く必要がある）
function askFiles(names) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', multiple: true, hidden: true });
    const sheet = h('div', { class: 'sheet' }, h('div', { class: 'sheet-card' },
      h('div', { class: 'sheet-title' }, '素材ファイルを選び直してください'),
      h('p', { class: 'lbl' }, '保存されていない素材があります。次のファイルをまとめて選んでください:'),
      h('ul', { class: 'lbl' }, ...names.map((n) => h('li', {}, n))),
      h('button', { class: 'primary', onclick: () => input.click() }, 'ファイルを選ぶ'),
      h('button', { class: 'wide', onclick: () => { sheet.remove(); resolve([]); } }, 'キャンセル'),
      input));
    input.addEventListener('change', () => { sheet.remove(); resolve([...input.files]); });
    document.body.append(sheet);
  });
}

async function openSaved(id) {
  show('loading');
  $('loadMsg').textContent = '保存した編集を開いています…';
  try {
    if (S.proj) await saveNow();
    const rec = await getProject(id);
    resetProject();
    S.proj = null;
    const proj = JSON.parse(rec.json);
    const files = new Map();
    const missing = [];
    for (const m of rec.files) {
      const f = await getFile(id + '/' + m.key);
      if (f) files.set(m.key, f instanceof File ? f : new File([f], m.name, { type: m.type }));
      else missing.push(m);
    }
    if (missing.length) {
      show('start');
      const picked = await askFiles(missing.map((m) => m.name));
      show('loading');
      for (const m of missing) {
        const f = picked.find((x) => x.name === m.name && x.size === m.size) || picked.find((x) => x.name === m.name);
        if (f) files.set(m.key, f);
      }
      const still = missing.filter((m) => !files.has(m.key));
      if (still.some((m) => m.key.startsWith('s:'))) throw new Error('動画ファイルが見つかりません: ' + still.map((m) => m.name).join(', '));
    }
    // メインの動画
    const srcIds = [...new Set(proj.clips.map((c) => c.srcId))];
    for (let i = 0; i < srcIds.length; i++) {
      $('loadMsg').textContent = `動画を読み込み中…（${i + 1}/${srcIds.length}）`;
      await openSource(files.get('s:' + srcIds[i]), srcIds[i]);
    }
    // 重ねる素材
    for (const mid of new Set(proj.overlays.map((o) => o.mediaId))) {
      const f = files.get('o:' + mid);
      if (f) await loadOverlayMedia(f, mid, rec.ovTypes ? rec.ovTypes[mid] : undefined);
    }
    proj.overlays = proj.overlays.filter((o) => S.ovMedia.has(o.mediaId));
    // 音声
    const bufs = new Map();
    for (const a of proj.audios) {
      const f = a.fileKey && files.get('a:' + a.fileKey);
      if (!f) continue;
      if (!bufs.has(a.fileKey)) { bufs.set(a.fileKey, await decodeAudioFile(f)); S.fileReg.set('a:' + a.fileKey, f); }
      const buf = bufs.get(a.fileKey);
      S.buffers.set(a.id, buf);
      const chs = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
      S.peaks.set(a.id, computePeaks(chs, Math.ceil(buf.duration * 100)));
    }
    proj.audios = proj.audios.filter((a) => S.buffers.has(a.id));
    S.proj = proj;
    S.projId = id;
    S.stored = new Set([...files.keys()].filter((k) => !missing.some((m) => m.key === k)));
    commit();
    show('editor');
    closePanel(true);
    fitZoom();
    layoutPreview();
    afterTimingChange();
    seek(0);
    startAfxWorker();
    for (const s of S.srcs.values()) { loadThumbs(s); loadSourceWave(s); }
    afxChanged(false);
    toast('保存した編集を開きました');
  } catch (e) {
    console.error(e);
    alert('開けませんでした: ' + (e.message || e));
    resetProject();
    S.proj = null;
    show('start');
    renderSavedList();
  }
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
  else if (tool === 'color') openPanel('color');
  else if (tool === 'addvideo') { $('addVideo').value = ''; $('addVideo').click(); }
  else if (tool === 'effect') openPanel('effectPick');
  else openPanel(tool);
});
$('audioFile').addEventListener('change', async (e) => {
  const a = await addAudioFile(e.target.files[0], 'music');
  if (a) { select('audio', a.id); toast('音楽を追加しました。音量はタップして調整できます'); }
});

// ---------------------------------------------------------------------------
// 書き出し

const EXP = { limit: 'auto', fps: 30, codec: 'avc', quality: 'max', split: false };
let exportResults = [];
let exportAbort = null, exportResult = null, encCaps = null;

async function openExport() {
  if (!S.proj) return;
  pause();
  if (S.panel) closePanel(false);
  const p = S.proj;
  const srcFps = p.frame.fps;
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
    const hi = bitrateFor(s.w, s.h, EXP.fps, EXP.codec, 'high'), mx = bitrateFor(s.w, s.h, EXP.fps, EXP.codec, 'max');
    const mb = ((br + 256000) * dur()) / 8 / 1e6;
    $('expEstimate').textContent = `${s.w}×${s.h}・${+EXP.fps.toFixed(2)}fps・約${Math.round(br / 1e6)}Mbps・予想サイズ 約${mb < 10 ? mb.toFixed(1) : Math.round(mb)}MB（${fmt(dur())}）`
      + `\nビットレート＝1秒あたりのデータ量。高＝iPhoneのカメラと同じくらい（約${Math.round(hi / 1e6)}Mbps）、最高＝その約1.6倍（約${Math.round(mx / 1e6)}Mbps）。細かい模様や動きの激しい場面で差が出ます。`;
  };
  box.append(
    h('div', { class: 'sec-title' }, '解像度'), chips({ options: resOpts, get: () => EXP.limit, set: (v) => (EXP.limit = v), onChange: est }),
    h('div', { class: 'sec-title' }, 'フレームレート'), chips({ options: fpsOpts, get: () => EXP.fps, set: (v) => (EXP.fps = v), onChange: est }),
    h('div', { class: 'sec-title' }, '形式'), chips({ options: [{ v: 'avc', label: 'H.264（互換性重視）' }, { v: 'hevc', label: 'HEVC（同じ画質で小さめ）' }], get: () => EXP.codec, set: (v) => (EXP.codec = v), onChange: est }),
    h('div', { class: 'sec-title' }, 'ビットレート'), chips({ options: [{ v: 'max', label: '最高（容量大）' }, { v: 'high', label: '高' }], get: () => EXP.quality, set: (v) => (EXP.quality = v), onChange: est }),
  );
  const ng = groupsOf(p).length;
  if (ng > 1) {
    box.append(h('div', { class: 'sec-title' }, '書き出し方'),
      chips({ options: [{ v: false, label: '1本につなげる' }, { v: true, label: `クリップで分けて書き出し（${ng}本）` }], get: () => EXP.split, set: (v) => (EXP.split = v), onChange: est }),
      h('p', { class: 'lbl' }, '分けて書き出すときは、合体させたクリップのかたまりごとに1本になります。文字・音楽・重ねた素材も、それぞれの時間の分だけ入ります。'));
  } else EXP.split = false;
  est();
  try {
    encCaps = await detectEncoders(o.w, o.h, EXP.fps);
    if (!encCaps.avc && !encCaps.hevc) $('expEstimate').textContent += '\n⚠ この端末では、この解像度の書き出しに対応していない可能性があります';
    else if (!encCaps.hevc) { EXP.codec = 'avc'; refreshPanelValues(); est(); }
  } catch {}
}

// ---------------------------------------------------------------------------
// 書き出しの進み具合（工程ごとの表示・全体の％・残り時間）
// 残り時間は「前回までの書き出しで測った速さ」から予測し、実際の進み具合で補正する

const RATE_KEY = 'videdit.rates.v1';
const RATE_DEFAULT = { gain: 0.02, decode: 0.02, stretch: 0.015, mix: 0.004, mixFx: 0.03, video: 0.015 };
function loadRates() { try { return { ...RATE_DEFAULT, ...JSON.parse(localStorage.getItem(RATE_KEY) || '{}') }; } catch { return { ...RATE_DEFAULT }; } }
function saveRates(r) { try { localStorage.setItem(RATE_KEY, JSON.stringify(r)); } catch {} }

const fmtSec = (s) => {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m}分${r}秒` : `${m}分`;
};

class ExportProgress {
  constructor(jobs, opt) {
    this.rates = loadRates();
    this.t0 = performance.now();
    this.steps = [];
    const R = this.rates;
    if (opt.gain) this.steps.push({ key: 'gain', job: -1, label: '音量合わせの計算', units: opt.gainSeconds, rate: 'gain' });
    jobs.forEach((j, k) => {
      const pre = jobs.length > 1 ? `${k + 1}本目: ` : '';
      const d = timelineDuration(j.proj);
      const slow = j.proj.clips.some((c) => c.speed !== 1);
      this.steps.push({ key: 'decode', job: k, label: pre + '動画の音声を読み込み' + (slow ? '・速度変更' : ''), units: d, rate: slow ? 'stretch' : 'decode', extra: slow ? d * R.decode : 0 });
      this.steps.push({ key: 'mix', job: k, label: pre + '音声の処理（' + (opt.afx ? '補正・' : '') + 'ミックス）', units: d, rate: opt.afx ? 'mixFx' : 'mix' });
      const o = outputSize(j.proj, EXP.limit);
      const frames = Math.max(1, Math.round(d * EXP.fps));
      this.steps.push({ key: 'video', job: k, label: pre + `映像の書き出し（${frames}フレーム）`, units: frames * (o.w * o.h) / 1e6, rate: 'video', frames });
      this.steps.push({ key: 'finalize', job: k, label: pre + 'ファイルの仕上げ', units: 0, fixed: 0.5 + d * 0.01 });
    });
    for (const s of this.steps) { s.est = s.fixed != null ? s.fixed : s.units * R[s.rate] + (s.extra || 0); s.f = 0; s.state = 'wait'; }
    this.cur = -1;
    this.detail = '';
    this.render(true);
    this.timer = setInterval(() => this.render(), 500);
  }
  // 工程 key（job 番号つき）に進む。k: その工程の進み具合 0〜1
  set(key, job, k, detail) {
    const i = this.steps.findIndex((s) => s.key === key && s.job === job);
    if (i < 0) return;
    if (i !== this.cur) {
      const now = performance.now();
      for (let j = 0; j < i; j++) {
        const s = this.steps[j];
        if (s.state !== 'done') { s.state = 'done'; s.f = 1; s.t1 = now; if (s.t0 == null) s.t0 = now; this.learn(s); }
      }
      this.cur = i;
      const s = this.steps[i];
      s.state = 'run';
      s.t0 = now;
    }
    this.steps[i].f = Math.min(1, Math.max(this.steps[i].f, k));
    if (detail != null) this.detail = detail;
    this.render();
  }
  // 実際にかかった時間から速さを覚える
  learn(s) {
    if (!s.rate || !s.units || s.t0 == null) return;
    const actual = (s.t1 - s.t0) / 1000 - (s.extra || 0);
    if (actual <= 0.05) return;
    const r = actual / s.units;
    this.rates[s.rate] = this.rates[s.rate] * 0.4 + r * 0.6;
  }
  finish() {
    const now = performance.now();
    for (const s of this.steps) if (s.state !== 'done') { s.state = 'done'; s.f = 1; s.t1 = now; if (s.t0 == null) s.t0 = now; this.learn(s); }
    saveRates(this.rates);
    this.stop();
  }
  stop() { clearInterval(this.timer); }
  remaining() {
    const now = performance.now();
    // 終わった工程で「予測より何倍かかったか」を出し、これからの工程の予測にかける
    let est = 0, act = 0;
    for (const s of this.steps) if (s.state === 'done' && s.t1 != null) { est += s.est; act += (s.t1 - s.t0) / 1000; }
    const ratio = est > 1 ? clamp(act / est, 0.3, 4) : 1;
    let rem = 0;
    this.steps.forEach((s, i) => {
      if (s.state === 'done') return;
      if (i === this.cur && s.t0 != null) {
        const el = (now - s.t0) / 1000;
        if (s.f > 0.03 && el > 1.5) rem += (el / s.f) * (1 - s.f);
        else rem += Math.max(0, s.est * ratio - el);
      } else rem += s.est * ratio;
    });
    return rem;
  }
  render(first) {
    const total = this.steps.reduce((a, s) => a + s.est, 0) || 1;
    const done = this.steps.reduce((a, s) => a + s.est * (s.state === 'done' ? 1 : s.f), 0);
    const pct = Math.min(99.5, (done / total) * 100);
    const el = (performance.now() - this.t0) / 1000;
    $('prog').style.width = pct.toFixed(1) + '%';
    $('runPct').textContent = `全体 ${Math.floor(pct)}%`;
    $('runEta').textContent = first || el < 2 ? '残り時間を計算中…' : `残り 約${fmtSec(this.remaining())}（経過 ${fmtSec(el)}）`;
    const list = $('runSteps');
    list.innerHTML = '';
    for (const s of this.steps) {
      const right = s.state === 'done' ? (s.t1 && s.t0 ? fmtSec((s.t1 - s.t0) / 1000) : '') : s.state === 'run' ? `${Math.floor(s.f * 100)}%` : '';
      list.append(h('div', { class: 'step st-' + s.state },
        h('span', { class: 'step-ico' }, s.state === 'done' ? '✓' : s.state === 'run' ? '▶' : '・'),
        h('span', { class: 'step-lbl' }, s.label),
        h('span', { class: 'step-r' }, right)));
    }
    $('runMsg').textContent = this.detail;
  }
}

async function startExport() {
  $('expSettings').hidden = true;
  $('expRun').hidden = false;
  $('prog').style.width = '0%';
  $('runTitle').textContent = '書き出し中…';
  $('runMsg').textContent = '準備中…';
  exportAbort = new AbortController();
  let wake = null, prog = null;
  try { wake = await navigator.wakeLock?.request('screen'); } catch {}
  try {
    await Promise.all(S.proj.texts.map((c) => ensureFont(c.font, c.text)));
    const base = (S.srcs.get(S.proj.clips[0].srcId).info.name || 'video').replace(/\.[^.]+$/, '');
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    const jobs = EXP.split
      ? groupsOf(S.proj).map((g, k) => ({ proj: subProject(S.proj, g), name: `${base}_${stamp}_${String(k + 1).padStart(2, '0')}` }))
      : [{ proj: S.proj, name: null }];
    const useAfx = !!afxParams();
    prog = new ExportProgress(jobs, { gain: afxNeedsGain(), gainSeconds: dur(), afx: useAfx });
    if (afxNeedsGain()) prog.set('gain', -1, 0, '補正後の音の大きさを、目標の音量に合わせる計算をしています');
    const afx = await afxExportParams((k) => prog.set('gain', -1, k));
    const results = [];
    for (let k = 0; k < jobs.length; k++) {
      const job = jobs[k];
      $('runTitle').textContent = '書き出し中…' + (jobs.length > 1 ? `（${k + 1}/${jobs.length}本目）` : '');
      const res = await exportVideo({
        srcs: S.srcs, proj: job.proj, buffers: S.buffers, overlayMedia: S.ovMedia,
        settings: { ...EXP, afx, name: job.name },
        signal: exportAbort.signal,
        onProgress: (phase, kk, extra) => {
          if (phase === 'decode') prog.set('decode', k, kk, '動画の音声を取り出しています');
          else if (phase === 'mix') prog.set('mix', k, kk * 0.85, useAfx ? 'EQ・エフェクトをかけて、音楽と混ぜています' : '音楽や読み上げと混ぜています');
          else if (phase === 'encodeAudio') prog.set('mix', k, 0.85 + kk * 0.15, '音声を書き込んでいます');
          else if (phase === 'video') prog.set('video', k, kk, extra ? `フレーム ${extra.frame} / ${extra.frames}` : '');
          else if (phase === 'finalize') prog.set('finalize', k, 0.5, 'ファイルをまとめています');
        },
      });
      results.push(res);
    }
    prog.finish();
    for (const r of exportResults) URL.revokeObjectURL(r.url);
    exportResults = results.map((r) => ({ ...r, url: URL.createObjectURL(r.file) }));
    exportResult = exportResults[0].file;
    const res = exportResults[0];
    $('resultVideo').src = res.url;
    const dl = $('download');
    dl.href = res.url;
    dl.download = res.file.name;
    dl.hidden = exportResults.length > 1;
    const files = exportResults.map((r) => r.file);
    $('share').hidden = !(navigator.canShare && navigator.canShare({ files }));
    $('share').textContent = files.length > 1 ? `写真に保存 / 共有（${files.length}本まとめて）` : '写真に保存 / 共有';
    const codecName = { avc: 'H.264', hevc: 'HEVC' }[res.codec] || res.codec.toUpperCase();
    const total = files.reduce((a, f) => a + f.size, 0);
    $('doneMsg').textContent = `${res.width}×${res.height}・${+res.fps.toFixed(2)}fps・${codecName}・${files.length > 1 ? files.length + '本・合計' : ''}${(total / 1e6).toFixed(1)}MB` +
      (res.audioCodec === 'pcm' ? '（音声は無圧縮）' : '');
    const list = $('doneList');
    list.innerHTML = '';
    if (exportResults.length > 1) {
      exportResults.forEach((r, k) => list.append(h('div', { class: 'done-item' },
        h('button', { class: 'chip', onclick: () => { $('resultVideo').src = r.url; $('resultVideo').play().catch(() => {}); } }, `▶ ${k + 1}本目`),
        h('span', { class: 'lbl' }, `${(r.file.size / 1e6).toFixed(1)}MB`),
        h('a', { class: 'btn', href: r.url, download: r.file.name }, '保存'))));
    }
    $('expRun').hidden = true;
    $('expDone').hidden = false;
  } catch (e) {
    prog && prog.stop();
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
  try { await navigator.share({ files: exportResults.map((r) => r.file) }); } catch (e) { if (e.name !== 'AbortError') toast('共有できませんでした。「ファイルとして保存」を使ってください'); }
});

// ---------------------------------------------------------------------------
// 起動

$('file').addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });
$('homeBtn').addEventListener('click', async () => { pause(); await saveNow(); show('start'); $('backToEdit').hidden = false; renderSavedList(); });
$('backToEdit').addEventListener('click', () => { show('editor'); layoutPreview(); renderTimeline(); scrollToTime(); });
$('addVideo').addEventListener('change', (e) => { addVideos(e.target.files); e.target.value = ''; });
$('undo').addEventListener('click', () => undoRedo(-1));
$('redo').addEventListener('click', () => undoRedo(1));
window.addEventListener('resize', () => { if (S.proj) { layoutPreview(); renderTimeline(); scrollToTime(); } });
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
addFontCss();
renderSavedList();
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

// テスト用
window.__app = { S, EXP, loadFiles, addVideos, mergeWithNext, splitClip, exportVideo, openExport, startExport, addAudioFile, commit, renderTimeline, requestDraw, seek };
