// Fast checks for the audio, naming and archive helpers (no model needed).
//   node test/selftest.mjs
import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import { countFrames, encodeMp3, integratedLoudness, limitPeaks, normalise, peakOf, trimSilence } from '../lib/audio.mjs';
import { slugFor } from '../lib/clips.mjs';
import { createTar, readTar } from '../lib/tar.mjs';

const SR = 24000;
let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};
const sine = (seconds, amp, hz = 1000) => Float32Array.from({ length: Math.round(seconds * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));

test('file names are safe, readable and unique', () => {
  const keys = ['move:Nf3+', 'move:Nf3', 'move:nf3', 'move:Bxc4', 'move:bxc4', 'move:e8=Q#', 'move:O-O-O', 'sq:e4', 'phrase:thats_a_blunder', 'num:2.5'];
  const slugs = keys.map(slugFor);
  for (const s of slugs) assert.match(s, /^[a-z0-9_-]+\.mp3$/);
  assert.equal(new Set(slugs.map((s) => s.toLowerCase())).size, keys.length);
  assert.ok(slugFor('move:Nf3+').startsWith('move-nf3-check-'));
  assert.equal(slugFor('move:Nf3+'), slugFor('move:Nf3+'));
});

test('silence trimming keeps the speech plus 40 ms margins', () => {
  const x = new Float32Array(SR); // 1 s
  x.set(sine(0.5, 0.3), Math.round(0.3 * SR));
  x[Math.round(0.05 * SR)] = 0.0001; // noise far below the threshold
  const { samples, stats } = trimSilence(x, SR, { marginMs: 40 });
  assert.ok(Math.abs(samples.length / SR - 0.58) < 0.006, `length ${samples.length / SR}`);
  assert.ok(stats.removedPeakDbfs < -70);
  assert.equal(samples[0], 0);
  assert.equal(trimSilence(new Float32Array(1000), SR).stats, null);
});

test('soft onsets survive trimming', () => {
  const x = new Float32Array(SR);
  const soft = sine(0.06, 0.004, 5000); // -48 dBFS fricative-like lead-in
  x.set(soft, Math.round(0.2 * SR));
  x.set(sine(0.3, 0.5), Math.round(0.26 * SR));
  const { stats } = trimSilence(x, SR);
  assert.ok(stats.leadTrimMs <= 165, `lead trim ${stats.leadTrimMs} ms cut into the soft onset`);
});

test('loudness matches BS.1770 calibration (1 kHz full-scale sine = -3.01 LUFS)', () => {
  const l = integratedLoudness(sine(2, 1), SR);
  assert.ok(Math.abs(l + 3.01) < 0.3, `got ${l.toFixed(2)} LUFS`);
  const quiet = integratedLoudness(sine(2, 0.1), SR);
  assert.ok(Math.abs(quiet - (l - 20)) < 0.05);
});

test('normalisation hits the target and the limiter respects the ceiling', () => {
  const clean = normalise(sine(1, 0.05), SR, { targetLufs: -18, ceilingDbfs: -1.5 });
  assert.ok(Math.abs(clean.stats.loudnessAfter + 18) < 0.1, `got ${clean.stats.loudnessAfter}`);
  assert.equal(clean.stats.limitedDb, 0);
  const x = sine(1, 0.05);
  x[12000] = 0.9; // a spike that would clip after gain
  const { samples, stats } = normalise(x, SR, { targetLufs: -18, ceilingDbfs: -1.5 });
  assert.ok(peakOf(samples) <= 10 ** (-1.5 / 20) + 1e-6);
  assert.ok(stats.limitedDb > 0);
  const y = sine(0.2, 0.2);
  assert.equal(limitPeaks(y, SR, 0.5), 0);
});

test('MP3 has an Info/LAME tag declaring delay and padding', () => {
  const x = sine(0.7, 0.3, 440);
  const mp3 = encodeMp3(x, SR, 48);
  const tagAt = 4 + 9;
  assert.equal(mp3.toString('ascii', tagAt, tagAt + 4), 'Info');
  const frames = mp3.readUInt32BE(tagAt + 8);
  const lame = tagAt + 120;
  assert.equal(mp3.toString('ascii', lame, lame + 4), 'LAME');
  const d = mp3.readUIntBE(lame + 21, 3);
  const delay = d >> 12, padding = d & 0xfff;
  assert.equal(delay, 576);
  assert.equal(frames * 576 - delay - padding, x.length);
  const tagSize = 192; // 64 kbps tag frame at 24 kHz
  assert.equal(countFrames(mp3.subarray(tagSize)).frames, frames);
  assert.ok(mp3.length / 0.7 < 7500, `${mp3.length} bytes for 0.7 s`); // 48 kbps = 6 kB/s plus the tag
});

test('tar round trip', () => {
  const entries = [
    { path: 'manifest.json', data: Buffer.from('{"a":1}') },
    { path: 'x'.repeat(90) + '.mp3', data: Buffer.alloc(1000, 7) },
    { path: 'empty.mp3', data: Buffer.alloc(0) },
    { path: 'exact.bin', data: Buffer.alloc(512, 1) },
  ];
  const tar = createTar(entries, 1767225600);
  assert.equal(tar.length % 512, 0);
  const back = readTar(gunzipSync(gzipSync(tar)));
  assert.deepEqual(back.map((f) => f.path), entries.map((e) => e.path));
  back.forEach((f, i) => assert.ok(f.data.equals(entries[i].data)));
  assert.ok(createTar(entries, 1767225600).equals(tar), 'not reproducible');
});

console.log(`${passed} tests passed`);
