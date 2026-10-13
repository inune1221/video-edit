// 解析（自動EQ）と音量合わせの計算を、画面を止めないように別スレッドで行う
// 素材ごとの音声を受け取っておき、クリップの並びに合わせてつなげたものを解析する
importScripts('dsp.js');

const fs = 48000;
const srcs = new Map();
let L = new Float32Array(0), R = new Float32Array(0);

onmessage = (e) => {
  const m = e.data;
  const reply = (data) => postMessage({ id: m.id, ...data });
  try {
    switch (m.type) {
      case 'addSource':
        srcs.set(m.sid, { L: m.L, R: m.R });
        reply({ ok: true });
        break;
      case 'setClips': {
        // clips: [{ srcId, in, out, volume }]（速度変更は解析に影響が小さいので無視する）
        const parts = m.clips.map((c) => ({ c, n: Math.max(0, Math.round((c.out - c.in) * fs)) }));
        const total = parts.reduce((a, p) => a + p.n, 0);
        L = new Float32Array(total); R = new Float32Array(total);
        let at = 0;
        for (const { c, n } of parts) {
          const s = srcs.get(c.srcId);
          if (s) {
            const a = Math.round(c.in * fs), g = c.volume;
            for (let i = 0; i < n && a + i < s.L.length; i++) { L[at + i] = s.L[a + i] * g; R[at + i] = s.R[a + i] * g; }
          }
          at += n;
        }
        reply({ ok: true, length: total });
        break;
      }
      case 'analyze':
        if (L.length < fs * 0.5) { reply({ analysis: null }); break; }
        reply({ analysis: DSP.analyze(fs, L, R) });
        break;
      case 'gain':
        if (L.length < fs * 0.5) { reply({ gain: 0 }); break; }
        reply({ gain: DSP.solveOutGain(fs, L, R, m.params, m.target, m.quick !== false) });
        break;
    }
  } catch (err) {
    reply({ error: String((err && err.message) || err) });
  }
};
