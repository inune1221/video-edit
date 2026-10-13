// 解析（自動EQ）と音量合わせの計算を、画面を止めないように別スレッドで行う
importScripts('dsp.js');

let fs = 48000, L = null, R = null;

onmessage = (e) => {
  const m = e.data;
  const reply = (data) => postMessage({ id: m.id, ...data });
  try {
    switch (m.type) {
      case 'init':
        fs = m.fs; L = m.L; R = m.R;
        reply({ ok: true });
        break;
      case 'analyze':
        reply({ analysis: DSP.analyze(fs, L, R) });
        break;
      case 'gain':
        reply({ gain: DSP.solveOutGain(fs, L, R, m.params, m.target, m.quick !== false) });
        break;
    }
  } catch (err) {
    reply({ error: String((err && err.message) || err) });
  }
};
