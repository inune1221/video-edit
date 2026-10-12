// 動画の読み込みと書き出し（Mediabunny + WebCodecs。すべて端末内で処理する）
import {
  Input, BlobSource, ALL_FORMATS, VideoSampleSink, AudioBufferSink,
  Output, Mp4OutputFormat, MovOutputFormat, StreamTarget, BufferTarget,
  CanvasSource, AudioBufferSource, Conversion, canEncodeVideo, canEncodeAudio,
} from './vendor/mediabunny.min.mjs';
import { renderFrame } from './render.js';
import { outputSize, timelineDuration } from './project.js';
import { mixProject, SR } from './audio.js';

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

export function bitrateFor(w, h, fps, codec, quality) {
  const bpp = (quality === 'max' ? 0.28 : 0.17) * (codec === 'hevc' ? 0.6 : 1);
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
export async function exportVideo({ media, proj, buffers, settings, onProgress, signal }) {
  const report = (phase, k, extra) => onProgress && onProgress(phase, k, extra);
  const { w: W, h: H } = outputSize(proj, settings.limit);
  const fps = settings.fps;
  const dur = timelineDuration(proj);

  // 1) 音声
  report('audio', 0);
  let orig = null;
  if (media.audioTrack && proj.origVolume > 0) {
    orig = await decodeSourceAudio(media, proj.trimIn, proj.trimOut, (k) => report('audio', k * 0.7));
  }
  if (signal?.aborted) throw new DOMException('canceled', 'AbortError');
  const hasAudio = !!orig || proj.audios.some((a) => buffers.get(a.id));
  const mix = hasAudio ? mixProject(proj, orig, buffers) : null;
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
    const sink = new VideoSampleSink(media.videoTrack);
    const srcW = media.info.width, srcH = media.info.height;
    const off = media.firstTimestamp;
    const lastSrc = off + proj.trimOut - 0.5 / fps;
    function* times() {
      for (let i = 0; i < frames; i++) yield Math.min(lastSrc, off + proj.trimIn + (i / fps) * proj.speed + 1e-4);
    }
    const t0 = performance.now();
    let i = 0;
    for await (const sample of sink.samplesAtTimestamps(times())) {
      if (signal?.aborted) { sample?.close(); break; }
      const t = i / fps;
      renderFrame(ctx, W, H, proj, t, (c) => { if (sample) sample.draw(c, 0, 0, srcW, srcH); });
      sample?.close();
      await videoSource.add(t, 1 / fps);
      i++;
      if (i % 5 === 0 || i === frames) {
        const el = (performance.now() - t0) / 1000;
        report('video', i / frames, { eta: (el / i) * (frames - i), frame: i, frames });
      }
    }
    if (signal?.aborted) throw new DOMException('canceled', 'AbortError');
    videoSource.close();
    report('finalize', 1);
    await output.finalize();
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  const ext = useAac ? 'mp4' : 'mov';
  const type = useAac ? 'video/mp4' : 'video/quicktime';
  const base = (media.info.name || 'video').replace(/\.[^.]+$/, '');
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  return {
    file: new File([file.toBlob(type)], `${base}_edit_${stamp}.${ext}`, { type }),
    width: W, height: H, fps, codec, audioCodec: mix ? (useAac ? 'aac' : 'pcm') : null,
  };
}
