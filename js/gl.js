// 色調補正・フィルター・グリーンバック合成（WebGL で1フレームずつ加工する）
// プレビューと書き出しで同じ処理を使う。

const VS = `
attribute vec2 p;
varying vec2 v;
void main() { v = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `
precision highp float;
varying vec2 v;
uniform sampler2D tex;
uniform float bright, contrast, sat, temp, tint, vig, fade;
uniform int mode;
uniform int key;
uniform vec3 keyColor;
uniform float sim, smooth_, spill;
vec2 uv(vec3 c) { return vec2(-0.169 * c.r - 0.331 * c.g + 0.5 * c.b, 0.5 * c.r - 0.419 * c.g - 0.081 * c.b); }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec4 src = texture2D(tex, v);
  vec3 c = src.a > 0.0 ? src.rgb / src.a : src.rgb;
  float a = src.a;
  if (key == 1) {
    float d = length(vec3((uv(c) - uv(keyColor)) * 1.0, (luma(c) - luma(keyColor)) * 0.3));
    float k = smoothstep(sim, sim + smooth_, d);
    a *= k;
    // 縁に残る緑（青）っぽさを抑える
    float s = (1.0 - smoothstep(sim, sim + smooth_ + spill, d)) * step(0.001, spill);
    c = mix(c, vec3(luma(c)), s);
  }
  c += bright;
  c = (c - 0.5) * contrast + 0.5;
  c = mix(vec3(luma(c)), c, sat);
  c.r += temp * 0.08; c.b -= temp * 0.08; c.g += tint * 0.06;
  if (mode == 1) c = vec3(luma(c));
  else if (mode == 2) { float l = luma(c); c = vec3(l * 1.07 + 0.05, l * 0.95 + 0.02, l * 0.78); }
  else if (mode == 3) { float l = luma(c); c = mix(c, c * vec3(1.08, 0.98, 0.86), smoothstep(0.4, 1.0, l)); c = mix(c, c * vec3(0.86, 1.0, 1.1), 1.0 - smoothstep(0.0, 0.5, l)); }
  else if (mode == 4) { c = mix(c, c * vec3(1.06, 1.0, 0.9), 0.8); }
  else if (mode == 5) { c = mix(c, c * vec3(0.9, 1.0, 1.1), 0.8); }
  c = mix(c, vec3(0.5) + (c - 0.5) * 0.8 + 0.06, fade);
  float r = distance(v, vec2(0.5));
  c *= 1.0 - vig * smoothstep(0.25, 0.8, r);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0) * a, a);
}`;

export const COLOR_PRESETS = [
  { key: 'none', label: 'なし', v: {} },
  { key: 'vivid', label: 'ビビッド', v: { sat: 1.35, contrast: 1.1 } },
  { key: 'cinema', label: 'シネマ', v: { mode: 3, contrast: 1.12, sat: 0.9, vig: 0.35 } },
  { key: 'warm', label: 'ウォーム', v: { mode: 4, temp: 0.6 } },
  { key: 'cool', label: 'クール', v: { mode: 5, temp: -0.5 } },
  { key: 'retro', label: 'レトロ', v: { fade: 0.35, sat: 0.8, temp: 0.4, vig: 0.3 } },
  { key: 'film', label: 'フィルム', v: { fade: 0.25, contrast: 0.95, sat: 0.85 } },
  { key: 'mono', label: 'モノクロ', v: { mode: 1, contrast: 1.1 } },
  { key: 'sepia', label: 'セピア', v: { mode: 2 } },
];

export const defaultColor = () => ({ preset: 'none', bright: 0, contrast: 1, sat: 1, temp: 0, tint: 0, vig: 0, fade: 0, mode: 0 });
export const defaultChroma = () => ({ on: false, color: '#00ff00', sim: 0.12, smooth: 0.08, spill: 0.1 });

export function applyColorPreset(c, key) {
  const p = COLOR_PRESETS.find((x) => x.key === key);
  Object.assign(c, defaultColor(), p ? p.v : {}, { preset: key });
}

export const colorActive = (c) => !!c && (c.bright !== 0 || c.contrast !== 1 || c.sat !== 1 || c.temp !== 0 || c.tint !== 0 || c.vig !== 0 || c.fade !== 0 || c.mode !== 0);
export const chromaActive = (k) => !!k && k.on;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

class GLProc {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.tmp = document.createElement('canvas');
    this.tctx = this.tmp.getContext('2d');
    const gl = (this.gl = this.canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: true }));
    if (!gl) { this.failed = true; return; }
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(pr);
    gl.useProgram(pr);
    this.pr = pr;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    this.u = {};
    for (const n of ['bright', 'contrast', 'sat', 'temp', 'tint', 'vig', 'fade', 'mode', 'key', 'keyColor', 'sim', 'smooth_', 'spill']) this.u[n] = gl.getUniformLocation(pr, n);
  }

  // draw(ctx2d, w, h): 素材を (0,0,w,h) に描く関数。加工した結果のキャンバスを返す
  process(draw, w, h, color, chroma) {
    if (this.failed) return null;
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (this.tmp.width !== w || this.tmp.height !== h) { this.tmp.width = w; this.tmp.height = h; }
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.tctx.clearRect(0, 0, w, h);
    draw(this.tctx, w, h);
    const gl = this.gl, u = this.u;
    gl.viewport(0, 0, w, h);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.tmp);
    const c = color || defaultColor();
    gl.uniform1f(u.bright, c.bright * 0.3);
    gl.uniform1f(u.contrast, c.contrast);
    gl.uniform1f(u.sat, c.sat);
    gl.uniform1f(u.temp, c.temp);
    gl.uniform1f(u.tint, c.tint);
    gl.uniform1f(u.vig, c.vig);
    gl.uniform1f(u.fade, c.fade);
    gl.uniform1i(u.mode, c.mode | 0);
    const k = chroma && chroma.on ? chroma : null;
    gl.uniform1i(u.key, k ? 1 : 0);
    gl.uniform3fv(u.keyColor, k ? hex(k.color) : [0, 1, 0]);
    gl.uniform1f(u.sim, k ? k.sim : 0);
    gl.uniform1f(u.smooth_, k ? Math.max(0.001, k.smooth) : 0.001);
    gl.uniform1f(u.spill, k ? k.spill : 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

let shared = null;
export function glProc() {
  if (!shared) { try { shared = new GLProc(); } catch (e) { console.warn('webgl', e); shared = { failed: true, process: () => null }; } }
  return shared;
}

// 素材の色（縁の平均色）を調べる。グリーンバックの色を自動で決めるのに使う
export function edgeColor(draw, w, h) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = Math.max(8, Math.round((64 * h) / w));
  const g = c.getContext('2d');
  draw(g, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let r = 0, gg = 0, b = 0, n = 0;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (x > 2 && x < c.width - 3 && y > 2 && y < c.height - 3) continue;
    const i = (y * c.width + x) * 4;
    r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++;
  }
  const hx = (v) => Math.round(v / n).toString(16).padStart(2, '0');
  return '#' + hx(r) + hx(gg) + hx(b);
}
