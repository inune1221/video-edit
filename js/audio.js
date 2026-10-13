// 音声まわり: ファイルのデコード、速度変更（ピッチ維持）、ミックス、波形
import { timelineDuration } from './project.js';

export const SR = 48000;

// 音声ファイル（mp3 / m4a / wav / 動画など）を 48kHz の AudioBuffer にする
export async function decodeAudioFile(file) {
  const data = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(2, SR, SR);
  return await ctx.decodeAudioData(data);
}

// 波形表示用のピーク（0〜1）
export function computePeaks(channels, buckets) {
  const n = channels[0].length;
  const out = new Float32Array(buckets);
  const step = n / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * step), e = Math.min(n, Math.floor((b + 1) * step));
    let m = 0;
    for (const ch of channels) {
      for (let i = s; i < e; i += 4) {
        const v = Math.abs(ch[i]);
        if (v > m) m = v;
      }
    }
    out[b] = Math.min(1, m);
  }
  return out;
}

// 単純な線形補間でのサンプリングレート変換（元動画の音声が 44.1kHz などのとき用）
export function resample(ch, from, to) {
  if (from === to) return ch;
  const ratio = from / to;
  const n = Math.floor(ch.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio, j = Math.floor(x), f = x - j;
    const a = ch[j], b = j + 1 < ch.length ? ch[j + 1] : a;
    out[i] = a + (b - a) * f;
  }
  return out;
}

// 速度だけ変える（ピッチも変わる）
function stretchRate(chs, speed) {
  return chs.map((ch) => {
    const n = Math.floor(ch.length / speed);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i * speed, j = Math.floor(x), f = x - j;
      const a = ch[j] ?? 0, b = ch[j + 1] ?? a;
      out[i] = a + (b - a) * f;
    }
    return out;
  });
}

// WSOLA による速度変更（声の高さを保つ）
export function timeStretch(chs, speed, keepPitch = true) {
  if (Math.abs(speed - 1) < 1e-4) return chs;
  if (!keepPitch) return stretchRate(chs, speed);
  const N = 2048, Hs = N / 2, tol = 384;
  const len = chs[0].length;
  const outLen = Math.floor(len / speed);
  const out = chs.map(() => new Float32Array(outLen + N));
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  // 相関計算用のモノラル
  const mono = new Float32Array(len);
  for (const ch of chs) for (let i = 0; i < len; i++) mono[i] += ch[i] / chs.length;

  let prevPos = 0; // 前のフレームで採用した入力位置
  for (let k = 0, o = 0; o < outLen; k++, o += Hs) {
    const nominal = Math.round(o * speed);
    let best = nominal;
    if (k > 0) {
      // 前フレームの続き（prevPos + Hs）と最も似ている位置を nominal±tol から探す
      const ref = prevPos + Hs;
      let bestScore = -Infinity;
      for (let d = -tol; d <= tol; d += 4) {
        const cand = nominal + d;
        if (cand < 0 || cand + Hs >= len || ref + Hs >= len) continue;
        let s = 0;
        for (let i = 0; i < Hs; i += 8) s += mono[ref + i] * mono[cand + i];
        if (s > bestScore) { bestScore = s; best = cand; }
      }
      // 細かく詰める
      const coarse = best;
      for (let d = -3; d <= 3; d++) {
        const cand = coarse + d;
        if (cand < 0 || cand + Hs >= len || ref + Hs >= len || d === 0) continue;
        let s = 0;
        for (let i = 0; i < Hs; i += 8) s += mono[ref + i] * mono[cand + i];
        if (s > bestScore) { bestScore = s; best = cand; }
      }
    }
    best = Math.max(0, Math.min(len - 1, best));
    prevPos = best;
    for (let c = 0; c < chs.length; c++) {
      const src = chs[c], dst = out[c];
      for (let i = 0; i < N; i++) {
        const si = best + i;
        if (si >= len) break;
        dst[o + i] += src[si] * win[i];
      }
    }
  }
  return out.map((ch) => ch.subarray(0, outLen));
}

// 最終的な音声（48kHz ステレオ）を作る
// orig: { channels: Float32Array[], sampleRate } … 元動画の音声（trimIn〜trimOut の範囲）。無ければ null
// buffers: Map(audioClipId -> AudioBuffer)
// afx: 元の動画の音声にかける EQ・エフェクトの設定（dsp.js の Chain の params）。null なら何もしない
export function mixProject(p, orig, buffers, afx = null) {
  const total = Math.ceil(timelineDuration(p) * SR);
  const L = new Float32Array(total), R = new Float32Array(total);

  if (orig && p.origVolume > 0) {
    let chs = orig.channels.map((c) => resample(c, orig.sampleRate, SR));
    chs = timeStretch(chs, p.speed, p.keepPitch);
    if (afx && globalThis.DSP) chs = globalThis.DSP.processBuffers(SR, chs[0], chs[1] || chs[0], afx);
    const l = chs[0], r = chs[1] || chs[0];
    const n = Math.min(total, l.length);
    const g = p.origVolume;
    for (let i = 0; i < n; i++) { L[i] += l[i] * g; R[i] += r[i] * g; }
  }

  // 追加した音声と、重ねた動画の音声
  const clips = [...p.audios.map((a) => [a, buffers.get(a.id)]), ...(p.overlays || []).filter((o) => o.type === 'video').map((o) => [o, buffers.get(o.mediaId)])];
  for (const [a, buf] of clips) {
    if (!buf || a.volume <= 0) continue;
    const l = buf.getChannelData(0), r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
    const s0 = Math.max(0, Math.round(a.start * SR));
    const s1 = Math.min(total, Math.round(a.end * SR));
    const off = Math.round(a.offset * SR) - Math.round(a.start * SR);
    const clipLen = (a.end - a.start) * SR;
    const fi = a.fadeIn * SR, fo = a.fadeOut * SR;
    for (let i = s0; i < s1; i++) {
      const si = i + off;
      if (si < 0 || si >= l.length) continue;
      const pos = i - a.start * SR;
      let g = a.volume;
      if (fi > 0 && pos < fi) g *= pos / fi;
      if (fo > 0 && clipLen - pos < fo) g *= Math.max(0, (clipLen - pos) / fo);
      L[i] += l[si] * g;
      R[i] += r[si] * g;
    }
  }

  // 音割れ防止（-0.3dB を超える部分だけをやわらかく抑える）
  const th = 0.966;
  for (const ch of [L, R]) {
    for (let i = 0; i < total; i++) {
      const v = ch[i], av = Math.abs(v);
      if (av > th) ch[i] = Math.sign(v) * (th + (1 - th) * Math.tanh((av - th) / (1 - th)));
    }
  }
  return [L, R];
}
