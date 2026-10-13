// 動画の読み込みと書き出し（Mediabunny + WebCodecs。すべて端末内で処理する）
import {
  Input, BlobSource, ALL_FORMATS, VideoSampleSink, AudioBufferSink,
  Output, Mp4OutputFormat, MovOutputFormat, StreamTarget, BufferTarget,
  CanvasSource, AudioBufferSource, Conversion, canEncodeVideo, canEncodeAudio,
} from './vendor/mediabunny.min.mjs';
import { renderFrame } from './render.js';
import { mainNeeds, drawMain } from './compose.js';
import { outputSize, timelineDuration, clipTimes, fitRect } from './project.js';
import { mixProject, SR, resample, timeStretch } from './audio.js';

const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];

export async function openVideo(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt) throw new Error('動画トラックが見つかりません');
  const at = await input.getPrimaryAudioTrack();
  const [duration, stats, first, canVideo] = await Promise.all([
    input.computeDuration(),
    vt.computePacketStats(240),
    vt.getFirstTimestamp(),
    vt.canDecode(),
  ]);
  let fps = stats.averagePacketRate || 30;
  const near = COMMON_FPS.reduce((a, b) => (Math.abs(b - fps) < Math.abs(a - fps) ? b : a));
  if (Math.abs(near - fps) / fps < 0.03) fps = near;
  return {
    input, videoTrack: vt, audioTrack: at, firstTimestamp: first, canDecodeVideo: canVideo,
    info: {
      name: file.name,
      width: vt.displayWidth,
      height: vt.displayHeight,
      duration: duration - first,
      fps,
      codec: vt.codec,
      hasAudio: !!at,
    },
  };
}

// 元動画の音声を [start, end)（秒）の範囲でデコードする
export async function decodeSourceAudio(media, start, end, onProgress) {
  const at = media.audioTrack;
  if (!at) return null;
  const off = media.firstTimestamp;
  if (await at.canDecode()) {
    const sink = new AudioBufferSink(at);
    const parts = [];
    let rate = at.sampleRate, chN = Math.min(2, at.numberOfChannels);
    const s = start + off, e = end + off;
    for await (const { buffer, timestamp } of sink.buffers(s, e)) {
      rate = buffer.sampleRate;
      parts.push({ buffer, timestamp });
      onProgress && onProgress(Math.min(1, (timestamp - s) / Math.max(0.001, e - s)));
    }
    if (!parts.length) return null;
    const total = Math.ceil((e - s) * rate);
    const channels = Array.from({ length: chN }, () => new Float32Array(total));
    for (const { buffer, timestamp } of parts) {
      const at0 = Math.round((timestamp - s) * rate);
      for (let c = 0; c < chN; c++) {
        const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
        const dst = channels[c];
        for (let i = 0; i < src.length; i++) {
          const j = at0 + i;
          if (j >= 0 && j < total) dst[j] = src[i];
        }
      }
    }
    return { channels, sampleRate: rate };
  }
  // WebCodecs で音声をデコードできない場合: 音声だけの m4a を作って Web Audio でデコードする
  const out = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const conv = await Conversion.init({ input: media.input, output: out, video: { discard: true } });
  await conv.execute();
  const ctx = new OfflineAudioContext(2, SR, SR);
  const buf = await ctx.decodeAudioData(out.target.buffer);
  const a = Math.floor(start * SR), b = Math.min(buf.length, Math.ceil(end * SR));
  const channels = [0, Math.min(1, buf.numberOfChannels - 1)].map((c) => buf.getChannelData(c).slice(a, b));
  return { channels, sampleRate: SR };
}

// 書き出しファイルをメモリ上で組み立てる（後から先頭付近を書き換える処理にも対応）
class MemoryFile {
  constructor() { this.parts = []; this.size = 0; }
  write(data, position) {
    const end = position + data.length;
    if (position < this.size) {
      for (const p of this.parts) {
        const ps = p.pos, pe = p.pos + p.data.length;
        if (pe <= position || ps >= end) continue;
        const s = Math.max(ps, position), e = Math.min(pe, end);
        p.data.set(data.subarray(s - position, e - position), s - ps);
      }
    }
    if (end > this.size) {
      if (position > this.size) {
        this.parts.push({ pos: this.size, data: new Uint8Array(position - this.size) });
        this.size = position;
      }
      const tail = data.slice(this.size - position);
      this.parts.push({ pos: this.size, data: tail });
      this.size = end;
    }
  }
  toBlob(type) { return new Blob(this.parts.map((p) => p.data), { type }); }
}

// 高画質: iPhone のカメラと同じくらい（4K30 の H.264 で約 47Mbps）、最高画質: その約1.6倍
export function bitrateFor(w, h, fps, codec, quality) {
  const bpp = (quality === 'max' ? 0.3 : 0.19) * (codec === 'hevc' ? 0.6 : 1);
  return Math.round(Math.min(160e6, w * h * fps * bpp));
}

export async function detectEncoders(w, h, fps, extra = []) {
  const res = {};
  for (const codec of ['avc', 'hevc', ...extra]) {
    try {
      res[codec] = await canEncodeVideo(codec, { width: w, height: h, bitrate: bitrateFor(w, h, fps, codec, 'high'), frameRate: fps });
    } catch { res[codec] = false; }
  }
  try { res.aac = await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: SR, bitrate: 256000 }); } catch { res.aac = false; }
  return res;
}

// settings: { limit: 'auto'|1080|720, fps, codec: 'avc'|'hevc', quality: 'high'|'max' }
// overlayMedia: Map(mediaId -> { type, file, bitmap, width, height, duration, fps })（重ねる画像・動画）
// メインの動画クリップの音声をつなげる（速度変更・クリップごとの音量を反映）。48kHz ステレオ
export async function buildMainAudio(proj, srcs, onProgress) {
  const total = Math.ceil(timelineDuration(proj) * SR);
  const L = new Float32Array(total), R = new Float32Array(total);
  let any = false;
  const ts = clipTimes(proj);
  for (const x of ts) {
    const s = srcs.get(x.clip.srcId);
    if (!s || !s.media.audioTrack || x.clip.volume <= 0) continue;
    const a = await decodeSourceAudio(s.media, x.clip.in, x.clip.out);
    if (!a) continue;
    let chs = a.channels.map((c) => resample(c, a.sampleRate, SR));
    if (chs.length < 2) chs = [chs[0], chs[0]];
    chs = timeStretch(chs, x.clip.speed, x.clip.keepPitch);
    const at = Math.round(x.start * SR), n = Math.min(chs[0].length, Math.round((x.end - x.start) * SR), total - at);
    const g = x.clip.volume;
    for (let i = 0; i < n; i++) { L[at + i] += chs[0][i] * g; R[at + i] += chs[1][i] * g; }
    any = true;
    onProgress && onProgress((x.index + 1) / ts.length);
  }
  return any ? [L, R] : null;
}

// srcs: Map(srcId -> { media（openVideo の結果） })
export async function exportVideo({ srcs, proj, buffers, overlayMedia = new Map(), settings, onProgress, signal }) {
  const report = (phase, k, extra) => onProgress && onProgress(phase, k, extra);
  const { w: W, h: H } = outputSize(proj, settings.limit);
  const fps = settings.fps;
  const dur = timelineDuration(proj);

  // 1) 音声
  report('audio', 0);
  let orig = null;
  if (proj.origVolume > 0) orig = await buildMainAudio(proj, srcs, (k) => report('audio', k * 0.7));
  if (signal?.aborted) throw new DOMException('canceled', 'AbortError');
  const hasAudio = !!orig || proj.audios.some((a) => buffers.get(a.id)) || (proj.overlays || []).some((o) => o.type === 'video' && o.volume > 0 && buffers.get(o.mediaId));
  const mix = hasAudio ? mixProject(proj, orig, buffers, settings.afx) : null;
  orig = null;
  report('audio', 1);

  // 2) エンコーダーの準備
  const enc = await detectEncoders(W, H, fps, [settings.codec]);
  const codec = [settings.codec, 'avc', 'hevc'].find((c) => enc[c]);
  if (!codec) throw new Error(`この端末では ${W}×${H} の動画を書き出せません（エンコーダー非対応）`);
  const useAac = enc.aac;
  const format = useAac ? new Mp4OutputFormat({ fastStart: false }) : new MovOutputFormat({ fastStart: false });
  const file = new MemoryFile();
  const writable = new WritableStream({ write: (chunk) => file.write(chunk.data, chunk.position) });
  const output = new Output({ format, target: new StreamTarget(writable, { chunked: true }) });

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  const videoSource = new CanvasSource(canvas, {
    codec,
    bitrate: bitrateFor(W, H, fps, codec, settings.quality),
    keyFrameInterval: 2,
  });
  output.addVideoTrack(videoSource, { frameRate: fps });
  let audioSource = null;
  if (mix) {
    audioSource = new AudioBufferSource(useAac ? { codec: 'aac', bitrate: 256000 } : { codec: 'pcm-s16' });
    output.addAudioTrack(audioSource);
  }
  const onAbort = () => output.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort);

  try {
    await output.start();

    if (mix) {
      const chunk = SR; // 1秒ずつ
      for (let i = 0; i < mix[0].length; i += chunk) {
        const n = Math.min(chunk, mix[0].length - i);
        const ab = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: SR });
        ab.copyToChannel(mix[0].subarray(i, i + n), 0);
        ab.copyToChannel(mix[1].subarray(i, i + n), 1);
        await audioSource.add(ab);
      }
      audioSource.close();
    }

    // 3) 映像
    const frames = Math.max(1, Math.round(dur * fps));
    // メイン動画: フレームごとに必要なクリップと素材の時刻を先に決め、クリップごとに順番に取り出す
    // （トランジション中は2つのクリップを同時に使う）
    const ts = clipTimes(proj);
    const plan = [];
    const perClip = ts.map(() => []);
    for (let k = 0; k < frames; k++) {
      const needs = mainNeeds(proj, k / fps, ts);
      plan.push(needs);
      for (const n of needs) perClip[n.x.index].push({ k, st: n.st });
    }
    const lastUse = perClip.map((l) => (l.length ? l[l.length - 1].k : -1));
    const clipReaders = new Map();
    const clipReader = (idx) => {
      let r = clipReaders.get(idx);
      if (!r) {
        const s = srcs.get(ts[idx].clip.srcId).media;
        const off = s.firstTimestamp, last = off + s.info.duration - 0.5 / (s.info.fps || fps);
        const times = perClip[idx].map((u) => Math.min(last, Math.max(off, off + u.st + 1e-4)));
        r = new VideoSampleSink(s.videoTrack).samplesAtTimestamps(times)[Symbol.asyncIterator]();
        clipReaders.set(idx, r);
      }
      return r;
    };
    // 重ねる動画: 使うフレームの時刻を先に全部決めておき、順番に取り出す
    const overlays = proj.overlays || [];
    const active = (ov, t) => t >= ov.start && t < ov.end;
    const readers = new Map();
    for (const ov of overlays) {
      const m = overlayMedia.get(ov.mediaId);
      if (!m || m.type !== 'video') continue;
      const inp = new Input({ source: new BlobSource(m.file), formats: ALL_FORMATS });
      const vt = await inp.getPrimaryVideoTrack();
      const ft = await vt.getFirstTimestamp();
      const ts = [];
      const last = ft + m.duration - 0.5 / (m.fps || 30);
      for (let k = 0; k < frames; k++) {
        const t = k / fps;
        if (active(ov, t)) ts.push(Math.min(last, ft + ov.offset + (t - ov.start) + 1e-4));
      }
      readers.set(ov.id, new VideoSampleSink(vt).samplesAtTimestamps(ts)[Symbol.asyncIterator]());
    }
    const t0 = performance.now();
    let i = 0;
    for (let i0 = 0; i0 < frames; i0++) {
      if (signal?.aborted) break;
      const t = i / fps;
      const mainSamples = new Map();
      for (const n of plan[i]) {
        const { value } = await clipReader(n.x.index).next();
        if (value) mainSamples.set(n.x.index, value);
      }
      const getFrame = (x) => {
        const sm = mainSamples.get(x.index);
        if (!sm) return null;
        const info = srcs.get(x.clip.srcId).media.info;
        return { w: info.width, h: info.height, draw: (c, X, Y, Wd, Hd) => sm.draw(c, X, Y, Wd, Hd) };
      };
      const cur = new Map();
      for (const ov of overlays) {
        const r = readers.get(ov.id);
        if (r && active(ov, t)) { const { value } = await r.next(); if (value) cur.set(ov.id, value); }
      }
      const overlaySource = (ov) => {
        const m = overlayMedia.get(ov.mediaId);
        if (!m) return null;
        if (m.type === 'image') return { w: m.width, h: m.height, draw: (c, x, y, w, h) => c.drawImage(m.bitmap, x, y, w, h) };
        const s = cur.get(ov.id);
        return s ? { w: m.width, h: m.height, draw: (c, x, y, w, h) => s.draw(c, x, y, w, h) } : null;
      };
      renderFrame(ctx, W, H, proj, t, (c) => drawMain(c, proj, t, getFrame), { overlaySource });
      for (const sm of mainSamples.values()) sm.close();
      for (const s of cur.values()) s.close();
      for (const n of plan[i]) if (lastUse[n.x.index] === i) { clipReaders.get(n.x.index)?.return?.(); clipReaders.delete(n.x.index); }
      await videoSource.add(t, 1 / fps);
      i++;
      if (i % 5 === 0 || i === frames) {
        const el = (performance.now() - t0) / 1000;
        report('video', i / frames, { eta: (el / i) * (frames - i), frame: i, frames });
      }
    }
    for (const r of readers.values()) r.return?.();
    for (const r of clipReaders.values()) r.return?.();
    if (signal?.aborted) throw new DOMException('canceled', 'AbortError');
    videoSource.close();
    report('finalize', 1);
    await output.finalize();
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  const ext = useAac ? 'mp4' : 'mov';
  const type = useAac ? 'video/mp4' : 'video/quicktime';
  const first = srcs.get(proj.clips[0].srcId).media;
  const base = settings.name || (first.info.name || 'video').replace(/\.[^.]+$/, '');
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  return {
    file: new File([file.toBlob(type)], settings.name ? `${base}.${ext}` : `${base}_edit_${stamp}.${ext}`, { type }),
    width: W, height: H, fps, codec, audioCodec: mix ? (useAac ? 'aac' : 'pcm') : null,
  };
}
