// 1フレーム分の描画。プレビュー（<video> から）と書き出し（デコードしたフレームから）で同じ関数を使うので、
// 見た目が完全に一致する。
import { cropRect } from './project.js';
import { fontString } from './fonts.js';

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const easeOut = (x) => 1 - Math.pow(1 - x, 3);

// --- 揺れ用のノイズ（seed と時刻だけで決まるので、プレビューと書き出しで同じ揺れになる） ---
function hash(n) {
  n = (n ^ 61) ^ (n >>> 16);
  n = (n + (n << 3)) | 0;
  n ^= n >>> 4;
  n = Math.imul(n, 0x27d4eb2d);
  n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
}
function smoothNoise(x, seed) {
  const i = Math.floor(x), f = x - i;
  const a = hash((i * 1013 + seed) | 0), b = hash(((i + 1) * 1013 + seed) | 0);
  const u = f * f * (3 - 2 * f);
  return (a + (b - a) * u) * 2 - 1;
}
function shakeNoise(t, e, ch) {
  const seed = (e.seed + ch * 7919) | 0;
  const x = t * e.speed;
  if (e.style === 'hard') return hash((Math.floor(x) * 131 + seed) | 0) * 2 - 1;
  return 0.7 * smoothNoise(x, seed) + 0.3 * smoothNoise(x * 2.3 + 11.1, seed + 3);
}

// 時刻 t に効いているエフェクトをまとめる
export function effectState(p, t, W, H) {
  const vid = { dx: 0, dy: 0, rot: 0, scale: 1 };
  const txt = { dx: 0, dy: 0, rot: 0 };
  const overlays = [];
  const base = Math.min(W, H);
  for (const e of p.effects) {
    if (t < e.start || t >= e.end) continue;
    const local = t - e.start, dur = e.end - e.start;
    if (e.type === 'shake') {
      const env = clamp01(local / 0.12) * clamp01((dur - local) / 0.12);
      const amp = (e.amp / 100) * 0.08 * base * env; // 強さ100で短辺の8%
      const dx = e.dir === 'v' ? 0 : shakeNoise(local, e, 0) * amp;
      const dy = e.dir === 'h' ? 0 : shakeNoise(local, e, 1) * amp;
      const rot = ((e.rot * Math.PI) / 180) * shakeNoise(local, e, 2) * env;
      vid.dx += dx; vid.dy += dy; vid.rot += rot;
      if (e.cover) {
        const rotMax = (Math.abs(e.rot) * Math.PI) / 180;
        const cover = 1 + (2 * (e.amp / 100) * 0.08 * base) / base + Math.sin(rotMax) * (Math.max(W, H) / base);
        vid.scale *= 1 + (cover - 1) * env;
      }
      if (e.withText) { txt.dx += dx; txt.dy += dy; txt.rot += rot; }
    } else if (e.type === 'zoom') {
      const k = easeOut(clamp01(local / dur));
      vid.scale *= e.from + (e.to - e.from) * k;
    } else if (e.type === 'flash') {
      overlays.push({ color: e.color, alpha: e.strength * Math.pow(1 - clamp01(local / dur), 2) });
    } else if (e.type === 'fade') {
      const k = clamp01(local / dur);
      overlays.push({ color: e.color, alpha: e.mode === 'in' ? 1 - k : k });
    }
  }
  return { vid, txt, overlays };
}

// ctx: 描画先（サイズ W×H）。drawSource(ctx) は元動画のフレームを (0,0,元の幅,元の高さ) に描く関数
export function renderFrame(ctx, W, H, p, t, drawSource, opt = {}) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const fx = effectState(p, t, W, H);
  const r = cropRect(p);

  ctx.save();
  ctx.translate(W / 2 + fx.vid.dx, H / 2 + fx.vid.dy);
  ctx.rotate(fx.vid.rot);
  ctx.scale(fx.vid.scale, fx.vid.scale);
  ctx.translate(-W / 2, -H / 2);
  ctx.transform(W / r.w, 0, 0, H / r.h, (-r.x * W) / r.w, (-r.y * H) / r.h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  drawSource(ctx);
  ctx.restore();

  // 重ねた画像・動画（メイン動画の上、文字の下）
  if (opt.overlaySource) {
    for (const ov of p.overlays || []) {
      if (t < ov.start || t >= ov.end) continue;
      const src = opt.overlaySource(ov);
      if (src) drawOverlay(ctx, ov, W, H, opt.staticText === ov.id ? null : t, src);
    }
  }

  if (!opt.hideText) {
    for (const c of p.texts) {
      if (t < c.start || t >= c.end) continue;
      ctx.save();
      if (fx.txt.dx || fx.txt.dy || fx.txt.rot) {
        ctx.translate(W / 2 + fx.txt.dx, H / 2 + fx.txt.dy);
        ctx.rotate(fx.txt.rot);
        ctx.translate(-W / 2, -H / 2);
      }
      drawText(ctx, c, W, H, opt.staticText === c.id ? null : t);
      ctx.restore();
    }
  }
  for (const o of fx.overlays) {
    if (o.alpha <= 0) continue;
    ctx.globalAlpha = Math.min(1, o.alpha);
    ctx.fillStyle = o.color;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.globalAlpha = 1;
}

// --- 文字 ---------------------------------------------------------------

function animState(c, t) {
  const local = t - c.start, dur = c.end - c.start;
  const inK = clamp01(local / 0.3), outK = clamp01((dur - local) / 0.3);
  const s = { alpha: 1, scale: 1, dy: 0, chars: Infinity };
  switch (c.anim) {
    case 'fade':
      s.alpha = Math.min(inK, outK);
      break;
    case 'pop': {
      const k = clamp01(local / 0.25);
      // 少し大きくなってから戻る
      s.scale = k < 1 ? 0.3 + 0.7 * (1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2)) : 1;
      s.alpha = Math.min(clamp01(local / 0.08), clamp01((dur - local) / 0.12));
      break;
    }
    case 'slide':
      s.dy = (1 - easeOut(inK)) * 0.6;
      s.alpha = Math.min(inK, outK);
      break;
    case 'type':
      s.chars = Math.floor(local / 0.07) + 1;
      break;
  }
  return s;
}

// 文字の外枠（縁を含む）を返す。プレビューでの選択枠とタップ判定に使う
export function textBounds(ctx, c, W, H) {
  const base = Math.min(W, H);
  const px = c.size * base;
  ctx.save();
  ctx.font = fontString(c.font, px);
  const lines = c.text.split('\n');
  const maxW = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
  ctx.restore();
  const pad = px * ((c.o1 ? c.o1.width : 0) + (c.o2 ? c.o2.width : 0) + (c.box && c.box.on ? 0.3 : 0.05));
  const lineH = px * 1.25;
  const w = maxW + pad * 2, h = lines.length * lineH + pad * 2;
  return { cx: c.x * W, cy: c.y * H, w, h, rot: (c.rot * Math.PI) / 180 };
}

export function drawText(ctx, c, W, H, t) {
  if (!c.text) return;
  const a = t == null ? { alpha: 1, scale: 1, dy: 0, chars: Infinity } : animState(c, t);
  if (a.alpha <= 0) return;
  const base = Math.min(W, H);
  const px = c.size * base;
  const lineH = px * 1.25;
  let lines = c.text.split('\n');
  if (a.chars !== Infinity) {
    let left = a.chars;
    lines = lines.map((l) => {
      const chars = Array.from(l);
      const s = chars.slice(0, Math.max(0, left)).join('');
      left -= chars.length;
      return s;
    });
  }
  ctx.save();
  ctx.translate(c.x * W, c.y * H + a.dy * px);
  ctx.rotate((c.rot * Math.PI) / 180);
  ctx.scale(a.scale, a.scale);
  ctx.globalAlpha *= a.alpha;
  ctx.font = fontString(c.font, px);
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  const full = c.text.split('\n');
  const widths = full.map((l) => ctx.measureText(l).width);
  const maxW = Math.max(1, ...widths);
  const total = lines.length * lineH;
  const top = -total / 2;
  let ax = 0;
  if (c.align === 'left') { ctx.textAlign = 'left'; ax = -maxW / 2; }
  else if (c.align === 'right') { ctx.textAlign = 'right'; ax = maxW / 2; }
  else ctx.textAlign = 'center';

  if (c.box && c.box.on) {
    const pad = px * 0.3;
    ctx.save();
    ctx.globalAlpha *= c.box.opacity;
    ctx.fillStyle = c.box.color;
    roundRect(ctx, -maxW / 2 - pad, top - pad * 0.6, maxW + pad * 2, total + pad * 1.2, px * 0.18);
    ctx.fill();
    ctx.restore();
  }

  const w1 = c.o1 ? c.o1.width * px : 0;
  const w2 = c.o2 ? c.o2.width * px : 0;
  const layers = [];
  if (c.o2 && w2 > 0) layers.push({ stroke: c.o2.color, width: (w1 + w2) * 2 });
  if (c.o1 && w1 > 0) layers.push({ stroke: c.o1.color, width: w1 * 2 });
  layers.push({ fill: true });

  let fillStyle = c.fill;
  if (c.fill2) {
    const g = ctx.createLinearGradient(0, top + lineH * 0.15, 0, top + total - lineH * 0.15);
    g.addColorStop(0, c.fill);
    g.addColorStop(1, c.fill2);
    fillStyle = g;
  }

  layers.forEach((layer, li) => {
    ctx.save();
    if (li === 0 && c.shadow && c.shadow.on) {
      ctx.shadowColor = c.shadow.color;
      ctx.shadowBlur = c.shadow.blur * px;
      ctx.shadowOffsetX = c.shadow.dist * px * 0.7;
      ctx.shadowOffsetY = c.shadow.dist * px;
    }
    lines.forEach((l, i) => {
      if (!l) return;
      const y = top + lineH * (i + 0.5);
      if (layer.fill) {
        ctx.fillStyle = fillStyle;
        ctx.fillText(l, ax, y);
      } else {
        ctx.strokeStyle = layer.stroke;
        ctx.lineWidth = layer.width;
        ctx.strokeText(l, ax, y);
      }
    });
    ctx.restore();
  });
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// --- 重ねる画像・動画 ---------------------------------------------------------

// 画面上の位置と大きさ（中心・幅・高さ・回転）。scale は出力の幅に対する割合
export function overlayRect(ov, W, H, srcW, srcH) {
  const w = ov.scale * W;
  const h = (w * srcH) / Math.max(1, srcW);
  return { cx: ov.x * W, cy: ov.y * H, w, h, rot: (ov.rot * Math.PI) / 180 };
}

function overlayPath(ctx, ov, w, h) {
  ctx.beginPath();
  if (ov.shape === 'circle') ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (ov.shape === 'round') roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.12);
  else ctx.rect(-w / 2, -h / 2, w, h);
}

// src: { w, h, draw(ctx, x, y, w, h) }
export function drawOverlay(ctx, ov, W, H, t, src) {
  const a = t == null ? { alpha: 1, scale: 1, dy: 0 } : animState(ov, t);
  if (a.alpha <= 0) return;
  const r = overlayRect(ov, W, H, src.w, src.h);
  ctx.save();
  ctx.translate(r.cx, r.cy + a.dy * r.h * 0.4);
  ctx.rotate(r.rot);
  ctx.scale(a.scale, a.scale);
  ctx.globalAlpha *= ov.opacity * a.alpha;
  const base = Math.min(W, H);
  if (ov.shadow) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = base * 0.04;
    ctx.shadowOffsetY = base * 0.012;
    overlayPath(ctx, ov, r.w, r.h);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  overlayPath(ctx, ov, r.w, r.h);
  ctx.clip();
  if (ov.flip) ctx.scale(-1, 1);
  ctx.imageSmoothingQuality = 'high';
  src.draw(ctx, -r.w / 2, -r.h / 2, r.w, r.h);
  ctx.restore();
  if (ov.border && ov.border.on && ov.border.width > 0) {
    overlayPath(ctx, ov, r.w, r.h);
    ctx.lineWidth = ov.border.width * base;
    ctx.strokeStyle = ov.border.color;
    ctx.stroke();
  }
  ctx.restore();
}
