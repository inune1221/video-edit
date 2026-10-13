// 試聴用: 動画の音声（<video> → MediaElementSource）にリアルタイムで EQ・エフェクトをかける。
// dsp.js と連結して読み込む（app.js 参照）。
class FxProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chain = new DSP.Chain(sampleRate);
    this.chain.set({ bypass: true, bands: [], drum: { kick: 0, snare: 0, scoop: 0, mix: 0.4 } });
    this.peak = 0;
    this.tick = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === 'params') this.chain.set(e.data.params);
    };
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const oL = out[0], oR = out[1] || out[0], n = oL.length;
    if (!inp || !inp.length) { oL.fill(0); oR.fill(0); return true; }
    oL.set(inp[0]);
    oR.set(inp[1] || inp[0]);
    this.chain.process(oL, oR, n);
    for (let i = 0; i < n; i++) { const a = Math.abs(oL[i]), b = Math.abs(oR[i]); if (a > this.peak) this.peak = a; if (b > this.peak) this.peak = b; }
    if ((++this.tick & 7) === 0) { this.port.postMessage({ type: 'peak', peak: this.peak }); this.peak = 0; }
    return true;
  }
}
registerProcessor('fx-processor', FxProcessor);
