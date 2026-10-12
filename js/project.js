// 編集内容（プロジェクト）のデータ構造と計算。画面・プレビュー・書き出しで共用する。
//
// 時間は2種類ある:
//   ソース時間  … 元動画の中の時刻（秒）
//   タイムライン時間 … 出力動画の中の時刻（秒）。ソース時間 = trimIn + タイムライン時間 × speed

export const MAX_LONG_SIDE = 3840;
export const MAX_SHORT_SIDE = 2160;

let idSeq = 1;
export const newId = (p) => `${p}${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export function createProject(src) {
  return {
    src, // { name, width, height, duration, fps, hasAudio }
    trimIn: 0,
    trimOut: src.duration,
    speed: 1,
    keepPitch: true,
    origVolume: 1,
    crop: { aspect: 'orig', x: 0, y: 0, w: 1, h: 1 },
    texts: [],
    audios: [],
    effects: [],
  };
}

export const timelineDuration = (p) => Math.max(0.05, (p.trimOut - p.trimIn) / p.speed);
export const toSource = (p, t) => p.trimIn + t * p.speed;
export const toTimeline = (p, s) => (s - p.trimIn) / p.speed;

export const ASPECTS = [
  { key: 'orig', label: '元のまま' },
  { key: '16:9', label: '16:9', r: 16 / 9 },
  { key: '9:16', label: '9:16', r: 9 / 16 },
  { key: '1:1', label: '1:1', r: 1 },
  { key: '4:5', label: '4:5', r: 4 / 5 },
  { key: '4:3', label: '4:3', r: 4 / 3 },
  { key: '3:4', label: '3:4', r: 3 / 4 },
  { key: 'free', label: '自由' },
];

// 縦横比を変えたとき、できるだけ大きく中央に切り抜く
export function cropForAspect(p, key) {
  const { width: sw, height: sh } = p.src;
  const a = ASPECTS.find((x) => x.key === key);
  if (!a || key === 'orig') return { aspect: 'orig', x: 0, y: 0, w: 1, h: 1 };
  if (key === 'free') return { ...p.crop, aspect: 'free' };
  const srcR = sw / sh;
  let w = 1, h = 1;
  if (a.r > srcR) h = (sw / a.r) / sh; else w = (sh * a.r) / sw;
  return { aspect: key, x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

// 切り抜き範囲（ソース動画のピクセル）
export function cropRect(p) {
  const { width: sw, height: sh } = p.src;
  const c = p.crop;
  return { x: c.x * sw, y: c.y * sh, w: c.w * sw, h: c.h * sh };
}

const even = (v) => Math.max(2, Math.round(v / 2) * 2);

// 出力解像度。切り抜いたピクセル数をそのまま使い（拡大はしない）、4K を超える場合だけ縮める。
// limit: 'auto' | 1080 | 720（短辺の上限）
export function outputSize(p, limit = 'auto') {
  const r = cropRect(p);
  let w = r.w, h = r.h;
  const long = Math.max(w, h), short = Math.min(w, h);
  let k = Math.min(1, MAX_LONG_SIDE / long, MAX_SHORT_SIDE / short);
  if (limit !== 'auto') k = Math.min(k, limit / short);
  return { w: even(w * k), h: even(h * k) };
}

// 重ならないように段（レーン）を割り当てる
export function assignLanes(items) {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  const ends = [];
  const lanes = new Map();
  for (const it of sorted) {
    let lane = ends.findIndex((e) => e <= it.start + 1e-6);
    if (lane < 0) { lane = ends.length; ends.push(0); }
    ends[lane] = it.end;
    lanes.set(it.id, lane);
  }
  return { lanes, count: Math.max(1, ends.length) };
}

// --- 文字のスタイル -------------------------------------------------------

// o1 = 内側の縁、o2 = 外側の縁。幅は文字サイズに対する割合
export const TEXT_PRESETS = [
  { key: 'wb', label: '白×黒縁', fill: '#ffffff', fill2: null, o1: { color: '#000000', width: 0.14 }, o2: null, shadow: false },
  { key: 'yb', label: '黄×黒縁', fill: '#ffe600', fill2: null, o1: { color: '#000000', width: 0.14 }, o2: null, shadow: false },
  { key: 'wrw', label: '白×赤縁×白', fill: '#ffffff', fill2: null, o1: { color: '#e60012', width: 0.12 }, o2: { color: '#ffffff', width: 0.09 }, shadow: false },
  { key: 'bw', label: '黒×白縁', fill: '#000000', fill2: null, o1: { color: '#ffffff', width: 0.14 }, o2: null, shadow: false },
  { key: 'rwb', label: '赤×白縁×黒', fill: '#ff1a1a', fill2: null, o1: { color: '#ffffff', width: 0.11 }, o2: { color: '#000000', width: 0.08 }, shadow: false },
  { key: 'pw', label: 'ピンク×白縁', fill: '#ff4fa0', fill2: null, o1: { color: '#ffffff', width: 0.13 }, o2: { color: '#ff4fa0', width: 0.05 }, shadow: false },
  { key: 'gold', label: '金グラデ', fill: '#fff3a0', fill2: '#ff9a00', o1: { color: '#5a2a00', width: 0.12 }, o2: { color: '#ffffff', width: 0.08 }, shadow: true },
  { key: 'blue', label: '水色×紺縁', fill: '#ffffff', fill2: '#7fe3ff', o1: { color: '#0b2a6b', width: 0.13 }, o2: null, shadow: true },
  { key: 'shadow', label: '白＋影', fill: '#ffffff', fill2: null, o1: null, o2: null, shadow: true },
  { key: 'band', label: '帯つき', fill: '#ffffff', fill2: null, o1: null, o2: null, shadow: false, box: true },
];

export function newTextClip(start, dur, base = {}) {
  const preset = TEXT_PRESETS[0];
  return {
    id: newId('t'),
    start,
    end: start + dur,
    text: 'テキスト',
    font: 'noto',
    size: 0.09, // 画面の短辺に対する文字の高さ
    x: 0.5,
    y: 0.78,
    align: 'center',
    rot: 0,
    anim: 'pop',
    fill: preset.fill,
    fill2: preset.fill2,
    o1: preset.o1 && { ...preset.o1 },
    o2: preset.o2 && { ...preset.o2 },
    shadow: { on: preset.shadow, color: '#000000', blur: 0.15, dist: 0.06 },
    box: { on: false, color: '#000000', opacity: 0.6 },
    ...base,
  };
}

export function applyPreset(clip, key) {
  const p = TEXT_PRESETS.find((x) => x.key === key);
  if (!p) return;
  clip.fill = p.fill;
  clip.fill2 = p.fill2;
  clip.o1 = p.o1 && { ...p.o1 };
  clip.o2 = p.o2 && { ...p.o2 };
  clip.shadow = { ...clip.shadow, on: !!p.shadow };
  clip.box = { ...clip.box, on: !!p.box };
}

// --- エフェクト -----------------------------------------------------------

export const EFFECT_TYPES = [
  { key: 'shake', label: '揺れ' },
  { key: 'zoom', label: 'ズーム' },
  { key: 'flash', label: 'フラッシュ' },
  { key: 'fade', label: 'フェード' },
];

export function newEffect(type, start, dur) {
  const base = { id: newId('e'), type, start, end: start + dur };
  switch (type) {
    case 'shake':
      return { ...base, amp: 30, speed: 8, dir: 'both', rot: 0, style: 'smooth', cover: true, withText: false, seed: Math.floor(Math.random() * 1e6) };
    case 'zoom':
      return { ...base, from: 1, to: 1.3 };
    case 'flash':
      return { ...base, color: '#ffffff', strength: 1 };
    case 'fade':
      return { ...base, mode: 'in', color: '#000000' };
  }
  return base;
}

export function newAudioClip(start, buffer, name, kind = 'music') {
  return {
    id: newId('a'),
    kind, // 'music' | 'tts'
    name,
    start,
    end: start + buffer.duration,
    offset: 0, // 音声ファイルの何秒目から使うか
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
  };
}

// 保存・元に戻す用に、AudioBuffer などを含まない形で複製する
export const snapshot = (p) => JSON.stringify({ ...p, src: undefined });
export const restore = (p, json) => Object.assign(p, JSON.parse(json), { src: p.src });
