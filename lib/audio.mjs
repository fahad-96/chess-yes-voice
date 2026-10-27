// Audio helpers for the voice pack: silence trimming, loudness normalisation,
// a transparent peak limiter, WAV writing and MP3 encoding (with a LAME/Info
// tag so browsers can drop the encoder delay and padding for gapless stitching).
import { Mp3Encoder } from '@breezystack/lamejs';

const dbToGain = (db) => 10 ** (db / 20);
export const gainToDb = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);

export function peakOf(samples) {
  let p = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > p) p = a;
  }
  return p;
}

/** RMS of consecutive windows of `win` samples. */
function windowRms(samples, win) {
  const n = Math.ceil(samples.length / win);
  const out = new Float64Array(n);
  for (let w = 0; w < n; w++) {
    let s = 0;
    const a = w * win;
    const b = Math.min(samples.length, a + win);
    for (let i = a; i < b; i++) s += samples[i] * samples[i];
    out[w] = Math.sqrt(s / Math.max(1, b - a));
  }
  return out;
}

/**
 * Trims leading and trailing silence. Speech is detected on 5 ms RMS windows
 * against a threshold relative to the loudest window (default -50 dB, never
 * below -70 dBFS), then `marginMs` of the original audio is kept on each side
 * so soft onsets and releases ("th", "f", trailing "s") survive. A short
 * raised-cosine fade sits inside the margin to guarantee click-free edges.
 */
export function trimSilence(samples, sampleRate, { thresholdDb = -50, floorDb = -70, marginMs = 40, fadeMs = 4 } = {}) {
  const win = Math.max(1, Math.round(sampleRate * 0.005));
  const rms = windowRms(samples, win);
  let loudest = 0;
  for (const r of rms) if (r > loudest) loudest = r;
  const threshold = Math.max(loudest * dbToGain(thresholdDb), dbToGain(floorDb));
  let first = rms.findIndex((r) => r >= threshold);
  if (first < 0) return { samples: new Float32Array(0), start: 0, end: 0, stats: null };
  let last = rms.length - 1;
  while (last > first && rms[last] < threshold) last--;
  const margin = Math.round((sampleRate * marginMs) / 1000);
  const speechStart = first * win;
  const speechEnd = Math.min(samples.length, (last + 1) * win);
  const start = Math.max(0, speechStart - margin);
  const end = Math.min(samples.length, speechEnd + margin);
  const out = samples.slice(start, end);
  const fade = Math.min(Math.round((sampleRate * fadeMs) / 1000), Math.floor(out.length / 2));
  for (let i = 0; i < fade; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    out[i] *= g;
    out[out.length - 1 - i] *= g;
  }
  // Waveform evidence that only silence was removed.
  const removedPeak = Math.max(peakOf(samples.subarray(0, start)), peakOf(samples.subarray(end)));
  return {
    samples: out,
    start,
    end,
    stats: {
      leadTrimMs: (start / sampleRate) * 1000,
      tailTrimMs: ((samples.length - end) / sampleRate) * 1000,
      leadMarginMs: ((speechStart - start) / sampleRate) * 1000,
      tailMarginMs: ((end - speechEnd) / sampleRate) * 1000,
      thresholdDbfs: gainToDb(threshold),
      removedPeakDbfs: gainToDb(removedPeak),
      speechPeakDbfs: gainToDb(peakOf(samples)),
    },
  };
}

/** RBJ biquad coefficients for the two ITU-R BS.1770 K-weighting stages at any sample rate. */
function kWeightingFilters(sampleRate) {
  const shelf = (() => {
    const G = 4.0, Q = 1 / Math.SQRT2, fc = 1500;
    const A = 10 ** (G / 40), w0 = (2 * Math.PI * fc) / sampleRate, cw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Q), sA = 2 * Math.sqrt(A) * alpha;
    const a0 = A + 1 - (A - 1) * cw + sA;
    return {
      b: [A * (A + 1 + (A - 1) * cw + sA) / a0, (-2 * A * (A - 1 + (A + 1) * cw)) / a0, (A * (A + 1 + (A - 1) * cw - sA)) / a0],
      a: [(2 * (A - 1 - (A + 1) * cw)) / a0, (A + 1 - (A - 1) * cw - sA) / a0],
    };
  })();
  const highpass = (() => {
    const Q = 0.5, fc = 38;
    const w0 = (2 * Math.PI * fc) / sampleRate, cw = Math.cos(w0), alpha = Math.sin(w0) / (2 * Q);
    const a0 = 1 + alpha;
    return { b: [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0], a: [(-2 * cw) / a0, (1 - alpha) / a0] };
  })();
  return [shelf, highpass];
}

function biquad(x, { b, a }) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/**
 * Integrated loudness (LUFS, mono) per ITU-R BS.1770-4: K-weighting, 400 ms
 * blocks with 75 % overlap, absolute gate -70 LUFS and relative gate -10 LU.
 * Clips shorter than one block are measured as a single block.
 */
export function integratedLoudness(samples, sampleRate) {
  if (samples.length === 0) return -Infinity;
  let y = samples;
  for (const f of kWeightingFilters(sampleRate)) y = biquad(y, f);
  const block = Math.round(sampleRate * 0.4);
  const step = Math.round(sampleRate * 0.1);
  const z = [];
  if (y.length <= block) {
    let s = 0;
    for (let i = 0; i < y.length; i++) s += y[i] * y[i];
    z.push(s / y.length);
  } else {
    for (let a = 0; a + block <= y.length; a += step) {
      let s = 0;
      for (let i = a; i < a + block; i++) s += y[i] * y[i];
      z.push(s / block);
    }
  }
  const L = (ms) => -0.691 + 10 * Math.log10(ms);
  const abs = z.filter((v) => L(v) > -70);
  if (abs.length === 0) return -Infinity;
  const rel = L(abs.reduce((s, v) => s + v, 0) / abs.length) - 10;
  const gated = abs.filter((v) => L(v) > rel);
  return L(gated.reduce((s, v) => s + v, 0) / gated.length);
}

/**
 * Look-ahead peak limiter that never lets |x| exceed `ceiling`. The gain curve
 * is a sliding minimum smoothed by a moving average over the same window (so
 * it starts to dip before a peak and never overshoots), then released slowly.
 * Returns the gain reduction applied, in dB (0 when nothing was touched).
 */
export function limitPeaks(samples, sampleRate, ceiling, { lookaheadMs = 3, releaseMs = 60 } = {}) {
  const n = samples.length;
  const req = new Float64Array(n);
  let need = false;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(samples[i]);
    req[i] = a > ceiling ? ceiling / a : 1;
    if (req[i] < 1) need = true;
  }
  if (!need) return 0;
  const h = Math.max(1, Math.round((sampleRate * lookaheadMs) / 1000));
  const mins = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = 1;
    for (let j = Math.max(0, i - h); j <= Math.min(n - 1, i + h); j++) if (req[j] < m) m = req[j];
    mins[i] = m;
  }
  const smooth = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(n - 1, i + h); j++) { s += mins[j]; c++; }
    smooth[i] = Math.min(s / c, req[i]);
  }
  const rel = 1 - Math.exp(-1 / ((sampleRate * releaseMs) / 1000));
  let g = 1, minGain = 1;
  for (let i = 0; i < n; i++) {
    g = Math.min(smooth[i], g + (1 - g) * rel);
    samples[i] *= g;
    if (g < minGain) minGain = g;
  }
  return -gainToDb(minGain);
}

/**
 * Normalises to `targetLufs` integrated loudness, then limits peaks to
 * `ceilingDbfs` (sample peak; leaves headroom for MP3 overshoot).
 */
export function normalise(samples, sampleRate, { targetLufs = -18, ceilingDbfs = -1.5 } = {}) {
  const before = integratedLoudness(samples, sampleRate);
  const gainDb = Number.isFinite(before) ? targetLufs - before : 0;
  const g = dbToGain(gainDb);
  const out = Float32Array.from(samples, (v) => v * g);
  const limitedDb = limitPeaks(out, sampleRate, dbToGain(ceilingDbfs));
  return {
    samples: out,
    stats: {
      loudnessBefore: before,
      gainDb,
      limitedDb,
      loudnessAfter: integratedLoudness(out, sampleRate),
      peakDbfs: gainToDb(peakOf(out)),
    },
  };
}

export function toInt16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out[i] = Math.round(v < 0 ? v * 32768 : v * 32767);
  }
  return out;
}

/** 16-bit PCM mono WAV. */
export function wavBytes(samples, sampleRate) {
  const pcm = toInt16(samples);
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + pcm.length * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}

// ---- MP3 ------------------------------------------------------------------

const BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // MPEG-1 Layer III
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // MPEG-2/2.5 Layer III
};
const SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };
const ENCODER_DELAY = 576; // LAME's encoder delay; decoders add 529 more, which the tag accounts for.

function parseHeader(b, o) {
  if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return null;
  const ver = { 0: 2.5, 2: 2, 3: 1 }[(b[o + 1] >> 3) & 3];
  if (ver === undefined || ((b[o + 1] >> 1) & 3) !== 1) return null;
  const br = BITRATES[ver === 1 ? 1 : 2][(b[o + 2] >> 4) & 15];
  const sr = SAMPLE_RATES[ver][(b[o + 2] >> 2) & 3];
  if (!br || !sr) return null;
  const pad = (b[o + 2] >> 1) & 1;
  const mono = ((b[o + 3] >> 6) & 3) === 3;
  const spf = ver === 1 ? 1152 : 576;
  const size = Math.floor(((spf / 8) * br * 1000) / sr) + pad;
  const sideInfo = ver === 1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  return { ver, br, sr, spf, size, sideInfo };
}

function crc16(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc & 0xffff;
}

/**
 * Builds a Xing "Info" frame with a LAME extension (what the LAME CLI writes)
 * declaring the frame count, byte count, encoder delay and end padding. FFmpeg
 * based decoders (Chrome, Edge, Android) and Firefox use it to return exactly
 * the encoded samples; decoders that ignore it see one frame of silence.
 */
function infoFrame(first, frames, audioBytes, delay, padding, kbps) {
  const h = parseHeader(first, 0);
  const table = BITRATES[h.ver === 1 ? 1 : 2];
  const tagStart = 4 + h.sideInfo;
  const need = tagStart + 120 + 36;
  let idx = table.findIndex((br, i) => i > 0 && Math.floor(((h.spf / 8) * br * 1000) / h.sr) >= need);
  if (idx < 0) return null;
  const size = Math.floor(((h.spf / 8) * table[idx] * 1000) / h.sr);
  const f = Buffer.alloc(size);
  f[0] = first[0];
  f[1] = first[1] | 1; // no CRC protection on the tag frame
  f[2] = (idx << 4) | (first[2] & 0x0c); // bitrate index, same sample rate, no padding
  f[3] = first[3];
  let o = tagStart;
  f.write('Info', o, 'ascii'); o += 4;
  f.writeUInt32BE(0x0f, o); o += 4; // frames, bytes, TOC and quality present
  f.writeUInt32BE(frames, o); o += 4;
  f.writeUInt32BE(size + audioBytes, o); o += 4;
  for (let i = 0; i < 100; i++) f[o + i] = Math.min(255, Math.floor((i * 256) / 100));
  o += 100;
  f.writeUInt32BE(0, o); o += 4;
  f.write('LAME3.100', o, 'ascii'); o += 9;
  f[o++] = 0x01; // tag revision 0, CBR
  f[o++] = 0; // lowpass unknown
  o += 4 + 2 + 2; // peak and ReplayGain: unset
  f[o++] = 0; // flags + ATH type
  f[o++] = Math.min(255, kbps);
  f[o++] = (delay >> 4) & 0xff;
  f[o++] = ((delay & 0x0f) << 4) | ((padding >> 8) & 0x0f);
  f[o++] = padding & 0xff;
  f[o++] = 0; // misc: mono, source <= 32 kHz
  f[o++] = 0; // MP3 gain
  o += 2; // preset / surround
  f.writeUInt32BE(size + audioBytes, o); o += 4;
  f.writeUInt16BE(0, o); o += 2; // music CRC (not used by decoders)
  f.writeUInt16BE(crc16(f.subarray(0, o)), o);
  return f;
}

/** Counts the audio frames in a raw Layer III stream. */
export function countFrames(bytes) {
  let o = 0, frames = 0, spf = 576;
  while (o + 4 <= bytes.length) {
    const h = parseHeader(bytes, o);
    if (!h) throw new Error(`MP3 frame sync lost at byte ${o}`);
    frames++;
    spf = h.spf;
    o += h.size;
  }
  return { frames, spf };
}

/** Encodes mono float samples to CBR MP3 bytes with a gapless Info tag. */
export function encodeMp3(samples, sampleRate, kbps, { tag = true } = {}) {
  const enc = new Mp3Encoder(1, sampleRate, kbps);
  const pcm = toInt16(samples);
  const parts = [];
  for (let i = 0; i < pcm.length; i += 1152) {
    const out = enc.encodeBuffer(pcm.subarray(i, i + 1152));
    if (out.length) parts.push(Buffer.from(out.buffer, out.byteOffset, out.length));
  }
  const tail = enc.flush();
  if (tail.length) parts.push(Buffer.from(tail.buffer, tail.byteOffset, tail.length));
  const audio = Buffer.concat(parts);
  const rate = parseHeader(audio, 0)?.sr;
  if (rate !== sampleRate) throw new Error(`at ${kbps} kbps the encoder resamples ${sampleRate} Hz to ${rate} Hz; use a higher bitrate`);
  const { frames, spf } = countFrames(audio);
  const padding = frames * spf - ENCODER_DELAY - pcm.length;
  if (padding < 0 || padding > 4095) throw new Error(`unexpected MP3 padding ${padding}`);
  const info = tag ? infoFrame(audio, frames, audio.length, ENCODER_DELAY, padding, kbps) : null;
  return info ? Buffer.concat([info, audio]) : audio;
}
