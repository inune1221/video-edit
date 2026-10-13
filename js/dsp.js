// 音声処理（ライブEQ から移植＋エフェクト追加）。試聴（AudioWorklet）、解析用ワーカー、書き出しで共用する。
// クラシックスクリプト: globalThis.DSP を定義する。worklet に連結して読み込めるよう import は使わない。
(function (G) {
  'use strict';

  const dbToLin = (db) => Math.pow(10, db / 20);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ---------- biquads (RBJ cookbook, transposed direct form II) ----------
  function design(type, f, fs, q, gain) {
    const A = Math.pow(10, gain / 40);
    const w = 2 * Math.PI * clamp(f, 1, fs * 0.49) / fs;
    const cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'peak':
        b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; break;
      case 'hs': {
        const s = 2 * Math.sqrt(A) * al;
        b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
        a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; break;
      }
      case 'ls': {
        const s = 2 * Math.sqrt(A) * al;
        b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s);
        a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s; break;
      }
      case 'lp': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      case 'hp': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      case 'ap': b0 = 1 - al; b1 = -2 * cw; b2 = 1 + al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      default: throw new Error('filter type ' + type);
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  // magnitude in dB of a designed filter at frequency f
  function magDb(c, f, fs) {
    const w = 2 * Math.PI * f / fs;
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = c.b0 + c.b1 * c1 + c.b2 * c2, ni = -(c.b1 * s1 + c.b2 * s2);
    const dr = 1 + c.a1 * c1 + c.a2 * c2, di = -(c.a1 * s1 + c.a2 * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }

  class Biquad {
    constructor(c) { this.set(c || { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }); this.s = new Float64Array(4); }
    set(c) { this.b0 = c.b0; this.b1 = c.b1; this.b2 = c.b2; this.a1 = c.a1; this.a2 = c.a2; }
    // in -> out (may alias); ch selects the state slot (0/1)
    run(inp, out, n, ch) {
      const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2, s = this.s, k = ch * 2;
      let z1 = s[k], z2 = s[k + 1];
      for (let i = 0; i < n; i++) {
        const x = inp[i], y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y; out[i] = y;
      }
      s[k] = z1; s[k + 1] = z2;
    }
  }

  // ---------- band layout ----------
  // Visible bands (detail screen). Macros map 1:1 onto some band gains.
  const BAND_DEFS = [
    { id: 'res', name: '共鳴', type: 'peak', f: 120, q: 4, g: 0 },
    { id: 'kick', name: 'キック', type: 'peak', f: 62, q: 1.3, g: 5 },
    { id: 'snare', name: 'スネア', type: 'peak', f: 220, q: 1.4, g: 0 },
    { id: 'mud', name: 'こもり', type: 'peak', f: 530, q: 1.2, g: -5 },
    { id: 'vocal', name: 'ボーカル', type: 'peak', f: 3000, q: 0.9, g: 0 },
    { id: 'pres', name: '抜け', type: 'peak', f: 6500, q: 0.9, g: 0 },
    { id: 'air', name: 'きらびやか', type: 'hs', f: 10000, q: 0.7, g: 0 },
  ];

  // All EQ filters actually run (visible bands + derived "helper" bands), scaled by depth.
  function eqFilters(bands, depth, fs) {
    const list = bands.map((b) => ({ type: b.type, f: b.f, q: b.q, g: b.g * depth }));
    const by = Object.fromEntries(bands.map((b) => [b.id, b]));
    if (by.kick) list.push({ type: 'peak', f: 3800, q: 2, g: by.kick.g * 0.3 * depth }); // beater click
    if (by.snare) list.push({ type: 'peak', f: 5000, q: 1.5, g: by.snare.g * 0.5 * depth }); // snare crack
    return list.map((b) => design(b.type, b.f, fs, b.q, b.g));
  }

  function eqResponse(bands, depth, fs, hpf, freqs) {
    const cs = eqFilters(bands, depth, fs);
    if (hpf) cs.push(design('hp', hpf, fs, 0.7071, 0));
    return freqs.map((f) => cs.reduce((s, c) => s + magDb(c, f, fs), 0));
  }

  // ---------- dynamics ----------
  class Compressor {
    constructor(fs) { this.fs = fs; this.env = 0; this.set({ thr: 0, ratio: 1, att: 10, rel: 100, makeup: 0 }); }
    set(p) {
      this.thr = p.thr; this.slope = 1 / p.ratio - 1; this.makeup = p.makeup; this.knee = 6;
      this.aa = Math.exp(-1 / (p.att * 0.001 * this.fs)); this.ar = Math.exp(-1 / (p.rel * 0.001 * this.fs));
      this.active = p.ratio > 1.001 || Math.abs(p.makeup) > 0.001;
    }
    // writes per-sample linear gain into g for stereo-linked detector on (l, r)
    gains(l, r, g, n) {
      const aa = this.aa, ar = this.ar, thr = this.thr, sl = this.slope, k = this.knee, mk = this.makeup;
      let env = this.env, cur = this.cur || 1;
      for (let i = 0; i < n; i++) {
        const x = Math.max(Math.abs(l[i]), Math.abs(r[i]));
        env = x > env ? aa * env + (1 - aa) * x : ar * env + (1 - ar) * x;
        // the gain computer (log/pow) only every 4 samples; envelope stays per-sample
        if ((i & 3) === 0) {
          const over = 20 * Math.log10(env + 1e-12) - thr;
          let gr = 0;
          if (over > k / 2) gr = sl * over;
          else if (over > -k / 2) gr = sl * (over + k / 2) * (over + k / 2) / (2 * k);
          cur = Math.pow(10, (gr + mk) / 20);
        }
        g[i] = cur;
      }
      this.env = env; this.cur = cur;
    }
  }

  // 4-band Linkwitz-Riley crossover (120 / 1000 / 5000 Hz) with allpass phase compensation so the
  // bands sum back flat; each band gets its own compressor. Mixing is done per band so the dry part
  // stays phase-coherent with the compressed part.
  const XO = [120, 1000, 5000];
  class DrumComp {
    constructor(fs) {
      this.fs = fs;
      const mk = (t, f) => [new Biquad(design(t, f, fs, 0.7071, 0)), new Biquad(design(t, f, fs, 0.7071, 0))];
      this.lp1k = mk('lp', XO[1]); this.hp1k = mk('hp', XO[1]);
      this.lp120 = mk('lp', XO[0]); this.hp120 = mk('hp', XO[0]);
      this.lp5k = mk('lp', XO[2]); this.hp5k = mk('hp', XO[2]);
      this.ap5k = new Biquad(design('ap', XO[2], fs, 0.7071, 0));
      this.ap120 = new Biquad(design('ap', XO[0], fs, 0.7071, 0));
      this.comps = [0, 1, 2, 3].map(() => new Compressor(fs));
      this.cap = 0; this.alloc(4096);
      this.set({ kick: 0, snare: 0, scoop: 0, mix: 0.4 });
    }
    alloc(n) {
      if (n <= this.cap) return;
      this.cap = n;
      this.b = [0, 1, 2, 3].map(() => [new Float32Array(n), new Float32Array(n)]);
      this.lo = [new Float32Array(n), new Float32Array(n)]; this.hi = [new Float32Array(n), new Float32Array(n)];
      this.g = new Float32Array(n);
    }
    set(p) {
      const k = p.kick / 10, s = p.snare / 10;
      this.mix = clamp(p.mix, 0, 1);
      this.scoop = dbToLin(-p.scoop * 0.6);
      this.enabled = p.kick > 0 || p.snare > 0 || p.scoop > 0;
      this.comps[0].set({ thr: -14 - 10 * k, ratio: 1 + 5 * k, att: 25, rel: 120, makeup: 5 * k });
      this.comps[1].set({ thr: -16 - 6 * s, ratio: 1 + 2.5 * s, att: 8, rel: 90, makeup: 2 * s });
      this.comps[2].set({ thr: -22 - 8 * s, ratio: 1 + 4 * s, att: 15, rel: 80, makeup: 6 * s });
      this.comps[3].set({ thr: -26, ratio: 1 + s, att: 5, rel: 100, makeup: 1.5 * s });
    }
    process(L, R, n) {
      if (!this.enabled) return;
      this.alloc(n);
      const ch = [L, R], b = this.b, lo = this.lo, hi = this.hi;
      for (let c = 0; c < 2; c++) {
        const x = ch[c];
        this.lp1k[0].run(x, lo[c], n, c); this.lp1k[1].run(lo[c], lo[c], n, c);
        this.hp1k[0].run(x, hi[c], n, c); this.hp1k[1].run(hi[c], hi[c], n, c);
        this.ap5k.run(lo[c], lo[c], n, c); this.ap120.run(hi[c], hi[c], n, c);
        this.lp120[0].run(lo[c], b[0][c], n, c); this.lp120[1].run(b[0][c], b[0][c], n, c);
        this.hp120[0].run(lo[c], b[1][c], n, c); this.hp120[1].run(b[1][c], b[1][c], n, c);
        this.lp5k[0].run(hi[c], b[2][c], n, c); this.lp5k[1].run(b[2][c], b[2][c], n, c);
        this.hp5k[0].run(hi[c], b[3][c], n, c); this.hp5k[1].run(b[3][c], b[3][c], n, c);
      }
      L.fill(0, 0, n); R.fill(0, 0, n);
      const g = this.g, mix = this.mix, wet = 1 - mix;
      for (let k = 0; k < 4; k++) {
        const bl = b[k][0], br = b[k][1], comp = this.comps[k], scale = k === 1 ? this.scoop : 1;
        if (comp.active) {
          comp.gains(bl, br, g, n);
          for (let i = 0; i < n; i++) { const m = scale * (mix + wet * g[i]); L[i] += bl[i] * m; R[i] += br[i] * m; }
        } else {
          for (let i = 0; i < n; i++) { L[i] += bl[i] * scale; R[i] += br[i] * scale; }
        }
      }
    }
  }

  // Lookahead peak limiter: sliding-window minimum of the required gain, boxcar-smoothed over the same
  // window (guarantees the ceiling at the delayed sample), then release smoothing.
  class Limiter {
    constructor(fs, ceilingDb = -1.3, lookMs = 3, relMs = 80) {
      this.L = Math.max(1, Math.round(lookMs * 0.001 * fs));
      const N = this.L + 1;
      this.N = N; this.ceil = dbToLin(ceilingDb);
      this.rel = 1 - Math.exp(-1 / (relMs * 0.001 * fs));
      this.dl = new Float32Array(N); this.dr = new Float32Array(N); this.di = 0;
      let cap = 1; while (cap < N + 2) cap <<= 1;
      this.qcap = cap; this.qv = new Float64Array(cap); this.qi = new Float64Array(cap); this.qh = 0; this.qt = 0;
      this.box = new Float64Array(N); this.boxSum = N; this.box.fill(1); this.bi = 0;
      this.t = 0; this.g = 1;
    }
    process(L, R, n) {
      const N = this.N, ceil = this.ceil, mask = this.qcap - 1, qv = this.qv, qi = this.qi, rel = this.rel;
      for (let i = 0; i < n; i++) {
        const xl = L[i], xr = R[i];
        const pk = Math.max(Math.abs(xl), Math.abs(xr));
        const tgt = pk > ceil ? ceil / pk : 1;
        const t = this.t++;
        while (this.qt !== this.qh && qv[(this.qt - 1) & mask] >= tgt) this.qt--;
        qv[this.qt & mask] = tgt; qi[this.qt & mask] = t; this.qt++;
        while (qi[this.qh & mask] <= t - N) this.qh++;
        const held = qv[this.qh & mask];
        this.boxSum += held - this.box[this.bi]; this.box[this.bi] = held; this.bi = (this.bi + 1) % N;
        const avg = this.boxSum / N;
        this.g = avg < this.g ? avg : this.g + (avg - this.g) * rel;
        const di = this.di, ol = this.dl[di], or = this.dr[di];
        this.dl[di] = xl; this.dr[di] = xr; this.di = (di + 1) % N;
        L[i] = ol * this.g; R[i] = or * this.g;
      }
    }
  }

  // ---------- エフェクト ----------
  // ひずみ: ソフトクリップ（tanh）。drive 0〜30dB、tone は後段ローパス、mix は原音との混ぜ具合
  class Dist {
    constructor(fs) { this.fs = fs; this.lp = new Biquad(); this.hp = new Biquad(design('hp', 70, fs, 0.7071, 0)); this.buf = [new Float32Array(128), new Float32Array(128)]; }
    set(p) {
      this.on = !!(p && p.on && p.mix > 0);
      if (!this.on) return;
      this.g = dbToLin(p.drive);
      this.norm = 1 / Math.sqrt(this.g);
      this.mix = clamp(p.mix, 0, 1);
      this.lp.set(design('lp', 1200 * Math.pow(10, p.tone), this.fs, 0.7071, 0)); // tone 0..1 → 1.2k〜12kHz
    }
    process(L, R, n) {
      if (!this.on) return;
      if (this.buf[0].length < n) this.buf = [new Float32Array(n), new Float32Array(n)];
      const g = this.g, k = this.norm, mix = this.mix, dry = 1 - mix;
      [L, R].forEach((x, c) => {
        const w = this.buf[c];
        this.hp.run(x, w, n, c);
        for (let i = 0; i < n; i++) { const v = w[i] * g; w[i] = (v / (1 + Math.abs(v)) * 0.6 + Math.tanh(v) * 0.4) * k; }
        this.lp.run(w, w, n, c);
        for (let i = 0; i < n; i++) x[i] = x[i] * dry + w[i] * mix;
      });
    }
  }

  // ステレオ拡張: M/S の S を強める（0〜100 → 1〜2.2倍）
  class Width {
    set(p) { this.on = !!(p && p.on && p.amount > 0); this.k = 1 + (p ? p.amount : 0) / 100 * 1.2; }
    process(L, R, n) {
      if (!this.on) return;
      const k = this.k, m = 1 / Math.sqrt((1 + k * k) / 2);
      for (let i = 0; i < n; i++) { const mid = (L[i] + R[i]) * 0.5, side = (L[i] - R[i]) * 0.5 * k; L[i] = (mid + side) * m; R[i] = (mid - side) * m; }
    }
  }

  // エコー（ディレイ）: time ms、feedback 0〜0.8、mix。ループ内にローパスを入れて自然に減衰させる
  class Echo {
    constructor(fs) { this.fs = fs; this.len = Math.ceil(fs * 1.2); this.d = [new Float32Array(this.len), new Float32Array(this.len)]; this.w = 0; this.lpS = [0, 0]; }
    set(p) {
      const was = this.on;
      this.on = !!(p && p.on && p.mix > 0);
      if (!this.on) return;
      if (!was) { this.d[0].fill(0); this.d[1].fill(0); this.lpS = [0, 0]; }
      this.delay = clamp(Math.round(p.time * 0.001 * this.fs), 1, this.len - 1);
      this.fb = clamp(p.feedback, 0, 0.85);
      this.mix = clamp(p.mix, 0, 1);
      this.a = 1 - Math.exp(-2 * Math.PI * 4500 / this.fs);
    }
    process(L, R, n) {
      if (!this.on) return;
      const len = this.len, dl = this.d[0], dr = this.d[1], fb = this.fb, mix = this.mix, a = this.a;
      let w = this.w, sl = this.lpS[0], sr = this.lpS[1];
      for (let i = 0; i < n; i++) {
        let r = w - this.delay; if (r < 0) r += len;
        const yl = dl[r], yr = dr[r];
        sl += a * (yl - sl); sr += a * (yr - sr);
        // 左右を入れ替えて戻す（軽いピンポン）
        dl[w] = L[i] + sr * fb; dr[w] = R[i] + sl * fb;
        L[i] += yl * mix; R[i] += yr * mix;
        if (++w >= len) w = 0;
      }
      this.w = w; this.lpS[0] = sl; this.lpS[1] = sr;
    }
  }

  // リバーブ: Freeverb 方式（8コム＋4オールパス×左右）。size 0〜1（広さ）、tone 0〜1（明るさ）、mix、predelay ms
  const COMB = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], AP = [556, 441, 341, 225], SPREAD = 23;
  class Reverb {
    constructor(fs) {
      const k = fs / 44100;
      const mk = (len) => ({ b: new Float32Array(Math.max(2, Math.round(len * k))), i: 0, f: 0 });
      this.comb = [COMB.map((l) => mk(l)), COMB.map((l) => mk(l + SPREAD))];
      this.ap = [AP.map((l) => mk(l)), AP.map((l) => mk(l + SPREAD))];
      this.pre = new Float32Array(Math.ceil(fs * 0.1)); this.pw = 0; this.fs = fs;
      this.hp = new Biquad(design('hp', 180, fs, 0.7071, 0));
      this.tmp = new Float32Array(128);
    }
    clear() {
      for (const side of [this.comb, this.ap]) for (const ch of side) for (const c of ch) { c.b.fill(0); c.f = 0; }
      this.pre.fill(0);
    }
    set(p) {
      const was = this.on;
      this.on = !!(p && p.on && p.mix > 0);
      if (!this.on) return;
      if (!was) this.clear();
      this.fb = 0.7 + clamp(p.size, 0, 1) * 0.28;
      this.damp = 0.05 + (1 - clamp(p.tone, 0, 1)) * 0.6;
      this.mix = clamp(p.mix, 0, 1) * 3;
      this.pd = clamp(Math.round((p.predelay || 0) * 0.001 * this.fs), 0, this.pre.length - 1);
    }
    process(L, R, n) {
      if (!this.on) return;
      if (this.tmp.length < n) this.tmp = new Float32Array(n);
      const t = this.tmp;
      for (let i = 0; i < n; i++) t[i] = (L[i] + R[i]) * 0.5;
      this.hp.run(t, t, n, 0);
      const fb = this.fb, d1 = this.damp, d2 = 1 - d1, mix = this.mix, pre = this.pre, plen = pre.length;
      const [cl, cr] = this.comb, [al, ar] = this.ap;
      let pw = this.pw;
      for (let i = 0; i < n; i++) {
        pre[pw] = t[i] * 0.015;
        let pr = pw - this.pd; if (pr < 0) pr += plen;
        const x = pre[pr];
        if (++pw >= plen) pw = 0;
        let ol = 0, or = 0;
        for (let j = 0; j < 8; j++) {
          let c = cl[j], y = c.b[c.i]; c.f = y * d2 + c.f * d1; c.b[c.i] = x + c.f * fb; if (++c.i >= c.b.length) c.i = 0; ol += y;
          c = cr[j]; y = c.b[c.i]; c.f = y * d2 + c.f * d1; c.b[c.i] = x + c.f * fb; if (++c.i >= c.b.length) c.i = 0; or += y;
        }
        for (let j = 0; j < 4; j++) {
          let a = al[j], bo = a.b[a.i]; a.b[a.i] = ol + bo * 0.5; if (++a.i >= a.b.length) a.i = 0; ol = bo - ol;
          a = ar[j]; bo = a.b[a.i]; a.b[a.i] = or + bo * 0.5; if (++a.i >= a.b.length) a.i = 0; or = bo - or;
        }
        L[i] += ol * mix; R[i] += or * mix;
      }
      this.pw = pw;
    }
  }

  // ---------- full chain ----------
  // params: {inGain, hpf, bands, depth, drum:{kick,snare,scoop,mix}, fx:{dist,width,echo,reverb}, outGain, limit, bypass}
  class Chain {
    constructor(fs) {
      this.fs = fs;
      this.hpf = new Biquad();
      this.eq = [];
      this.drum = new DrumComp(fs);
      this.dist = new Dist(fs);
      this.width = new Width();
      this.echo = new Echo(fs);
      this.reverb = new Reverb(fs);
      this.lim = new Limiter(fs);
      this.p = null;
    }
    set(p) {
      this.p = p;
      this.inG = dbToLin(p.inGain || 0);
      this.outG = dbToLin(p.outGain || 0);
      this.hpf.set(design('hp', p.hpf || 30, this.fs, 0.7071, 0));
      const cs = eqFilters(p.bands, p.depth == null ? 1 : p.depth, this.fs);
      while (this.eq.length < cs.length) this.eq.push(new Biquad());
      this.eq.length = cs.length;
      cs.forEach((c, i) => this.eq[i].set(c));
      this.drum.set(p.drum);
      const fx = p.fx || {};
      this.dist.set(fx.dist);
      this.width.set(fx.width);
      this.echo.set(fx.echo);
      this.reverb.set(fx.reverb);
    }
    // stage: 'pre' = everything before output gain (for loudness measurement), 'full' = all
    process(L, R, n, stage = 'full') {
      const p = this.p;
      if (!p || p.bypass) return;
      const ig = this.inG;
      for (let i = 0; i < n; i++) { L[i] *= ig; R[i] *= ig; }
      this.hpf.run(L, L, n, 0); this.hpf.run(R, R, n, 1);
      for (const f of this.eq) { f.run(L, L, n, 0); f.run(R, R, n, 1); }
      this.drum.process(L, R, n);
      this.dist.process(L, R, n);
      this.width.process(L, R, n);
      this.echo.process(L, R, n);
      this.reverb.process(L, R, n);
      if (stage === 'pre') return;
      const og = this.outG;
      for (let i = 0; i < n; i++) { L[i] *= og; R[i] *= og; }
      if (p.limit !== false) this.lim.process(L, R, n);
    }
  }

  // ---------- loudness (ITU-R BS.1770-4 integrated) ----------
  class Loudness {
    constructor(fs) {
      this.fs = fs;
      // K-weighting, coefficients derived for any sample rate (pyloudnorm formulation)
      let K = Math.tan(Math.PI * 1681.974450955533 / fs);
      const Vh = Math.pow(10, 3.999843853973347 / 20), Vb = Math.pow(Vh, 0.4996667741545416), Q = 0.7071752369554196;
      let a0 = 1 + K / Q + K * K;
      const s1 = { b0: (Vh + Vb * K / Q + K * K) / a0, b1: 2 * (K * K - Vh) / a0, b2: (Vh - Vb * K / Q + K * K) / a0, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
      K = Math.tan(Math.PI * 38.13547087602444 / fs);
      const Q2 = 0.5003270373238773; a0 = 1 + K / Q2 + K * K;
      const s2 = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q2 + K * K) / a0 };
      this.f1 = new Biquad(s1); this.f2 = new Biquad(s2);
      this.step = Math.round(fs * 0.1); this.acc = 0; this.cnt = 0;
      this.sub = []; this.blocks = []; this.peak = 0;
      this.tl = new Float32Array(0); this.tr = new Float32Array(0);
    }
    reset() { this.f1.s.fill(0); this.f2.s.fill(0); this.acc = 0; this.cnt = 0; this.sub = []; }
    add(L, R, n) {
      if (this.tl.length < n) { this.tl = new Float32Array(n); this.tr = new Float32Array(n); }
      const tl = this.tl, tr = this.tr;
      for (let i = 0; i < n; i++) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > this.peak) this.peak = a; if (b > this.peak) this.peak = b; }
      this.f1.run(L, tl, n, 0); this.f2.run(tl, tl, n, 0);
      this.f1.run(R, tr, n, 1); this.f2.run(tr, tr, n, 1);
      for (let i = 0; i < n; i++) {
        this.acc += tl[i] * tl[i] + tr[i] * tr[i];
        if (++this.cnt === this.step) {
          this.sub.push(this.acc / this.step); this.acc = 0; this.cnt = 0;
          if (this.sub.length >= 4) { const s = this.sub; this.blocks.push((s[s.length - 1] + s[s.length - 2] + s[s.length - 3] + s[s.length - 4]) / 4); }
        }
      }
    }
    integrated() {
      const lk = (z) => -0.691 + 10 * Math.log10(z);
      const abs = this.blocks.filter((z) => lk(z) > -70);
      if (!abs.length) return -70;
      const relThr = lk(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
      const g = abs.filter((z) => lk(z) > relThr);
      return lk(g.reduce((a, b) => a + b, 0) / g.length);
    }
  }

  // ---------- offline helpers ----------
  const BLOCK = 4096;

  // run chain over [start, end) of channel arrays; optional sink(L, R, n, offset)
  function runRange(chain, chL, chR, start, end, stage, sink) {
    const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK);
    for (let o = start; o < end; o += BLOCK) {
      const n = Math.min(BLOCK, end - o);
      bl.set(chL.subarray(o, o + n)); br.set(chR.subarray(o, o + n));
      chain.process(bl, br, n, stage);
      if (sink) sink(bl, br, n, o);
    }
  }

  // measure integrated loudness of the processed signal; quick=true measures evenly spaced segments
  function measure(fs, chL, chR, params, stage, quick, onProgress) {
    const len = chL.length, meter = new Loudness(fs);
    let ranges = [[0, len]], warm = 0;
    if (quick && len > fs * 60) {
      const seg = fs * 4, count = 12; warm = Math.round(fs * 0.5);
      ranges = [];
      for (let i = 0; i < count; i++) {
        const s = Math.round((len - seg) * i / (count - 1));
        ranges.push([s, s + seg]);
      }
    }
    let done = 0; const total = ranges.reduce((a, r) => a + r[1] - r[0], 0);
    for (const [s, e] of ranges) {
      const chain = new Chain(fs); chain.set(params);
      const ws = Math.max(0, s - warm);
      meter.reset();
      runRange(chain, chL, chR, ws, e, stage, (l, r, n, o) => {
        if (o + n <= s) return;
        const k = Math.max(0, s - o);
        meter.add(l.subarray(k, n), r.subarray(k, n), n - k);
        done += n - k; if (onProgress) onProgress(done / total);
      });
    }
    return { lufs: meter.integrated(), peak: meter.peak };
  }

  // gain (dB) so that the limited output hits targetLufs; two passes like a mastering limiter
  function solveOutGain(fs, chL, chR, params, target, quick, onProgress) {
    const p1 = measure(fs, chL, chR, params, 'pre', quick, onProgress && ((x) => onProgress(x * 0.5)));
    let g = clamp(target - p1.lufs, -30, 30);
    const p2 = measure(fs, chL, chR, { ...params, outGain: g }, 'full', quick, onProgress && ((x) => onProgress(0.5 + x * 0.5)));
    g = clamp(g + (target - p2.lufs), -30, 36);
    return g;
  }

  // final render to interleaved Int16 with TPDF dither
  function renderInt16(fs, chL, chR, params, channels, onProgress) {
    const len = chL.length, out = new Int16Array(len * channels);
    const chain = new Chain(fs); chain.set(params);
    // compensate the limiter's lookahead delay: run past the end on silence and drop the head
    const lat = params.limit !== false ? chain.lim.L : 0;
    const padL = new Float32Array(len + lat), padR = new Float32Array(len + lat);
    padL.set(chL); padR.set(chR);
    let seed = 22222;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    runRange(chain, padL, padR, 0, len + lat, 'full', (l, r, n, o0) => {
      for (let i = 0; i < n; i++) {
        const o = o0 + i - lat;
        if (o < 0) continue;
        const dl = (rnd() - rnd()), dr = (rnd() - rnd());
        const vl = clamp(Math.round(l[i] * 32767 + dl), -32768, 32767);
        if (channels === 1) out[o] = vl;
        else { out[o * 2] = vl; out[o * 2 + 1] = clamp(Math.round(r[i] * 32767 + dr), -32768, 32767); }
      }
      const o = o0;
      if (onProgress && (o / BLOCK) % 64 === 0) onProgress(o / len);
    });
    return out;
  }

  // Float32 のまま全体を処理する（書き出し用）。リミッターの先読み分の遅れを補正して同じ長さで返す
  function processBuffers(fs, chL, chR, params) {
    const len = chL.length;
    const chain = new Chain(fs); chain.set(params);
    const lat = params.limit !== false && !params.bypass ? chain.lim.L : 0;
    const padL = new Float32Array(len + lat), padR = new Float32Array(len + lat);
    padL.set(chL); padR.set(chR);
    const outL = new Float32Array(len), outR = new Float32Array(len);
    runRange(chain, padL, padR, 0, len + lat, 'full', (l, r, n, o0) => {
      for (let i = 0; i < n; i++) {
        const o = o0 + i - lat;
        if (o >= 0 && o < len) { outL[o] = l[i]; outR[o] = r[i]; }
      }
    });
    return [outL, outR];
  }

  // ---------- analysis / auto EQ ----------
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < len / 2; j++) {
          const a = i + j, b = a + len / 2;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  const THIRD_OCT = Array.from({ length: 30 }, (_, k) => 25 * Math.pow(2, k / 3));

  function averageSpectrum(fs, chL, chR, n = 16384) {
    const win = new Float32Array(n);
    for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    const P = new Float64Array(n / 2 + 1), re = new Float64Array(n), im = new Float64Array(n);
    let frames = 0;
    const hop = Math.max(n, Math.floor((chL.length - n) / 400)); // cap work at ~400 frames
    for (let o = 0; o + n <= chL.length; o += hop) {
      for (let i = 0; i < n; i++) { re[i] = (chL[o + i] + chR[o + i]) * 0.5 * win[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 0; k <= n / 2; k++) P[k] += re[k] * re[k] + im[k] * im[k];
      frames++;
    }
    return { P, n, frames };
  }

  // target: 1/3-octave band energy falls 1.5 dB/oct relative to 1 kHz
  const target = (f) => -1.5 * Math.log2(f / 1000);

  function analyze(fs, chL, chR) {
    const pre = new Loudness(fs);
    { const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK);
      for (let o = 0; o < chL.length; o += BLOCK) { const n = Math.min(BLOCK, chL.length - o); bl.set(chL.subarray(o, o + n)); br.set(chR.subarray(o, o + n)); pre.add(bl, br, n); } }
    const lufs = pre.integrated();

    const { P, n } = averageSpectrum(fs, chL, chR);
    const df = fs / n;
    const bandDb = THIRD_OCT.filter((c) => c * Math.pow(2, 1 / 6) < fs / 2).map((c) => {
      const lo = Math.ceil(c / Math.pow(2, 1 / 6) / df), hi = Math.floor(c * Math.pow(2, 1 / 6) / df);
      let s = 0; for (let k = lo; k <= hi; k++) s += P[k];
      return { f: c, db: 10 * Math.log10(s + 1e-20) };
    });
    const ref = bandDb.reduce((best, b) => (Math.abs(Math.log2(b.f / 1000)) < Math.abs(Math.log2(best.f / 1000)) ? b : best)).db;
    const ltas = bandDb.map((b) => ({ f: b.f, db: b.db - ref, diff: b.db - ref - target(b.f) }));
    const avg = (lo, hi) => { const s = ltas.filter((b) => b.f >= lo && b.f <= hi); return s.reduce((a, b) => a + b.diff, 0) / (s.length || 1); };

    // narrow low-frequency resonance: fine-resolution peak vs local median (±1/2 octave)
    const binDb = (k) => 10 * Math.log10(P[k] + 1e-20);
    let res = null;
    for (let k = Math.ceil(70 / df); k <= Math.floor(250 / df); k++) {
      const v = binDb(k);
      if (v < binDb(k - 1) || v < binDb(k + 1)) continue;
      const f = k * df, lo = Math.floor(f / Math.SQRT2 / df), hi = Math.ceil(f * Math.SQRT2 / df);
      const nb = []; for (let j = lo; j <= hi; j++) nb.push(binDb(j));
      nb.sort((a, b) => a - b);
      const excess = v - nb[nb.length >> 1];
      if (excess > 8 && (!res || excess > res.excess)) res = { f, excess };
    }
    // a single bass note also makes a sharp bin peak; only accept it when its 1/3-octave band
    // clearly stands out from both neighbouring bands as well
    if (res) {
      const i = ltas.reduce((bi, b, k) => (Math.abs(Math.log2(b.f / res.f)) < Math.abs(Math.log2(ltas[bi].f / res.f)) ? k : bi), 0);
      const nbAvg = ((ltas[i - 1] || ltas[i]).db + (ltas[i + 1] || ltas[i]).db) / 2;
      if (ltas[i].db - nbAvg < 5) res = null;
    }

    let mud = { f: 530, d: -Infinity };
    for (const b of ltas) if (b.f >= 250 && b.f <= 800 && b.diff > mud.d) mud = { f: b.f, d: b.diff };
    const lowExcess = avg(50, 170);
    const boomy = !!res || lowExcess > 4;
    const shape = (d, up, down, cap) => Math.round(clamp(d < 0 ? -d * up : -d * down, -cap, cap) * 2) / 2;
    const auto = {
      res: res ? { f: Math.round(res.f), g: -Math.round(clamp(res.excess, 0, 10)) } : { f: 120, g: 0 },
      mud: { f: Math.round(mud.f), g: -Math.round(clamp(mud.d * 0.65, 0, 7)) },
      vocal: shape(avg(2000, 4100), 0.75, 0.4, 6),
      pres: shape(avg(5000, 8100), 0.5, 0.4, 6),
      air: shape(avg(10000, 13000), 0.4, 0.3, 6),
      kick: boomy ? 2 : 5,
    };
    const bright = (auto.vocal + auto.pres + auto.air) / 3;
    const kind = [bright > 2.5 ? 'こもり' : '', boomy ? 'ブーミー' : ''].filter(Boolean).join('＋');
    return { lufs, ltas, auto, kind: kind ? kind + '型' : 'バランス良好', inGain: clamp(-18 - lufs, -20, 24) };
  }

  function autoBands(a) {
    return BAND_DEFS.map((d) => {
      const b = { ...d };
      if (d.id === 'res') { b.f = a.res.f; b.g = a.res.g; }
      if (d.id === 'mud') { b.f = a.mud.f; b.g = a.mud.g; }
      if (d.id === 'vocal') b.g = a.vocal;
      if (d.id === 'pres') b.g = a.pres;
      if (d.id === 'air') b.g = a.air;
      if (d.id === 'kick') b.g = a.kick;
      return b;
    });
  }

  G.DSP = {
    design, magDb, Biquad, Compressor, DrumComp, Limiter, Chain, Loudness,
    BAND_DEFS, eqFilters, eqResponse, analyze, autoBands, measure, solveOutGain, renderInt16, runRange, processBuffers,
    Reverb, Echo, Dist, Width,
    dbToLin, clamp,
  };
})(typeof self !== 'undefined' ? self : globalThis);
