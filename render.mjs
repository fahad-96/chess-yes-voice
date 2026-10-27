#!/usr/bin/env node
// Renders every clip in clips.json with Kokoro-82M (CPU, in Node) into
// pack/<slug>.mp3 and pack/manifest.json. Resumable and shardable.
//
//   node render.mjs [clips.json] [options]
//
//   --out <dir>        output folder (default: pack)
//   --jobs <n>         run n shard processes in parallel and merge (default: 1)
//   --shard <k/n>      render only every n-th clip starting at k (1-based)
//   --threads <t>      ONNX Runtime threads per process (default: cores / jobs)
//   --dtype <d>        fp32 (default) or q8
//   --kbps <b>         MP3 bitrate (default: 48)
//   --lufs=<l>         loudness target (default: -18; write negative values with '=')
//   --speed <s>        speaking speed (default: 1)
//   --limit <n>        stop after n newly rendered clips (for quick tests)
//   --wav <dir>        also write the processed audio as WAV files (for listening)
//   --force            re-render everything, ignoring finished clips
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { encodeMp3, normalise, trimSilence, wavBytes } from './lib/audio.mjs';
import { MODEL_ID, SAMPLE_RATE, buildManifest, isDone, loadClipList, loadState, recordState, sha256, slugFor, textHash } from './lib/clips.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', default: 'pack' },
      jobs: { type: 'string', default: '1' },
      shard: { type: 'string' },
      threads: { type: 'string' },
      dtype: { type: 'string', default: 'fp32' },
      kbps: { type: 'string', default: '48' },
      lufs: { type: 'string', default: '-18' },
      speed: { type: 'string', default: '1' },
      limit: { type: 'string' },
      wav: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
  });
} catch (error) {
  console.error(`render: ${error.message}`);
  process.exit(1);
}
const { values: opt, positionals } = args;

const clipsPath = resolve(positionals[0] ?? 'clips.json');
const outDir = resolve(opt.out);
const jobs = Math.max(1, parseInt(opt.jobs, 10) || 1);
const settings = {
  dtype: opt.dtype,
  kbps: Number(opt.kbps),
  lufs: Number(opt.lufs),
  speed: Number(opt.speed),
  trim: { thresholdDb: -50, marginMs: 40, fadeMs: 4 },
  ceilingDbfs: -1.5,
  pipeline: 1, // bump when the processing below changes in a way that should re-render
};
if (!['fp32', 'q8'].includes(settings.dtype)) fail(`--dtype must be fp32 or q8`);
// Below 40 kbps the encoder would also resample to 22.05 kHz and low-pass at 8 kHz.
if (![40, 48, 56, 64, 80, 96].includes(settings.kbps)) fail('--kbps must be one of 40, 48, 56, 64, 80, 96');
if (!(settings.speed >= 0.5 && settings.speed <= 2)) fail('--speed must be between 0.5 and 2');
if (!(settings.lufs >= -30 && settings.lufs <= -10)) fail('--lufs must be between -30 and -10, e.g. --lufs=-18');
const settingsHash = sha256(JSON.stringify(settings)).slice(0, 16);
// Synthesis depends only on these; the raw audio is cached so changing the
// bitrate or loudness later re-encodes in minutes instead of re-rendering.
const synthKey = (voice, text) => sha256(JSON.stringify({ model: MODEL_ID, dtype: settings.dtype, voice, speed: settings.speed, text })).slice(0, 24);
const RAW_DIR = join(ROOT, '.cache', 'raw');

function fail(message) {
  console.error(`render: ${message}`);
  process.exit(1);
}

const fmtTime = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);

let list;
try {
  list = loadClipList(clipsPath);
} catch (error) {
  fail(error.message);
}

if (jobs > 1 && !opt.shard) await runParallel();
else await renderShard();

async function runParallel() {
  const threads = opt.threads ?? String(Math.max(1, Math.floor(availableParallelism() / jobs)));
  const passThrough = process.argv.slice(2).filter((a, i, all) => !(a === '--jobs' || all[i - 1] === '--jobs' || a.startsWith('--jobs=') || a === '--threads' || all[i - 1] === '--threads' || a.startsWith('--threads=')));
  // Download the model once here, so parallel shards never race on the cache.
  const modelDir = join(ROOT, '.cache', 'models', ...MODEL_ID.split('/'));
  if (!existsSync(join(modelDir, 'onnx', settings.dtype === 'q8' ? 'model_quantized.onnx' : 'model.onnx')) || !existsSync(join(modelDir, 'tokenizer.json'))) {
    console.log('render: downloading the model');
    const { model } = await openModel(1);
    await model.dispose();
  }
  const started = Date.now();
  console.log(`render: ${jobs} processes x ${threads} threads`);
  const codes = await Promise.all(
    Array.from({ length: jobs }, (_, i) =>
      new Promise((done) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...passThrough, '--shard', `${i + 1}/${jobs}`, '--threads', threads], { stdio: ['ignore', 'pipe', 'pipe'] });
        for (const stream of [child.stdout, child.stderr]) {
          let buf = '';
          stream.on('data', (d) => {
            buf += d;
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const l of lines) if (l.trim()) (stream === child.stderr ? console.error : console.log)(l);
          });
        }
        child.on('close', done);
      }),
    ),
  );
  const elapsed = (Date.now() - started) / 1000;
  if (codes.some((c) => c !== 0)) fail(`a shard failed (exit codes ${codes.join(', ')}); run the same command again to resume`);
  finish(elapsed);
}

/** Loads Kokoro (downloading it into .cache/models on first use). threads 0 lets ONNX Runtime choose. */
async function openModel(threads) {
  const { env, StyleTextToSpeech2Model, AutoTokenizer } = await import('@huggingface/transformers');
  env.cacheDir = join(ROOT, '.cache', 'models') + '/';
  const [model, tokenizer] = await Promise.all([
    StyleTextToSpeech2Model.from_pretrained(MODEL_ID, { dtype: settings.dtype, device: 'cpu', session_options: threads ? { intraOpNumThreads: threads, interOpNumThreads: 1 } : {} }),
    AutoTokenizer.from_pretrained(MODEL_ID),
  ]);
  return { model, tokenizer };
}

async function renderShard() {
  let k = 1, n = 1;
  if (opt.shard) {
    const m = /^(\d+)\/(\d+)$/.exec(opt.shard);
    if (!m || +m[1] < 1 || +m[1] > +m[2]) fail('--shard must look like 2/3');
    [k, n] = [+m[1], +m[2]];
  }
  const tag = n > 1 ? `[${k}/${n}] ` : '';
  const shardTag = `shard-${k}-of-${n}`;
  mkdirSync(outDir, { recursive: true });
  mkdirSync(RAW_DIR, { recursive: true });
  if (opt.wav) mkdirSync(resolve(opt.wav), { recursive: true });

  const mine = list.clips.filter((_, i) => i % n === k - 1);
  const state = loadState(outDir);
  const todo = opt.force ? mine : mine.filter((c) => !isDone(outDir, state, list.voice, c, settingsHash));
  const limit = opt.limit ? Math.min(todo.length, parseInt(opt.limit, 10)) : todo.length;
  console.log(`${tag}${mine.length} clips in this shard, ${mine.length - todo.length} already rendered, ${limit} to render`);
  if (limit === 0) {
    if (n === 1) finish(0);
    return;
  }

  let tts = null;
  let lastPhonemes = '', lastTokens = 0;
  const loadModel = async () => {
    const t0 = Date.now();
    const { KokoroTTS } = await import('kokoro-js');
    const { model, tokenizer } = await openModel(opt.threads ? parseInt(opt.threads, 10) : 0);
    // Wrap the tokenizer to see the phonemes Kokoro produced (logged in the
    // state file) and to catch texts long enough to be truncated.
    const wrapped = (text, options) => {
      const out = tokenizer(text, options);
      lastPhonemes = text;
      lastTokens = out.input_ids.dims.at(-1);
      return out;
    };
    tts = new KokoroTTS(model, wrapped);
    tts._validate_voice(list.voice);
    console.log(`${tag}model ${settings.dtype} loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  };

  const started = Date.now();
  let synthSeconds = 0, rendered = 0, audioSeconds = 0, bytes = 0;
  for (const clip of todo.slice(0, limit)) {
    const t0 = Date.now();
    const sk = synthKey(list.voice, clip.text);
    const rawPath = join(RAW_DIR, `${sk}.f32`);
    let raw, phonemes = null, fromCache = false;
    if (existsSync(rawPath) && existsSync(rawPath + '.json')) {
      const b = readFileSync(rawPath);
      raw = new Float32Array(b.buffer, b.byteOffset, b.length / 4).slice();
      phonemes = JSON.parse(readFileSync(rawPath + '.json', 'utf8')).phonemes;
      fromCache = true;
    } else {
      if (!tts) await loadModel();
      const ts = Date.now();
      const audio = await tts.generate(clip.text, { voice: list.voice, speed: settings.speed });
      synthSeconds += (Date.now() - ts) / 1000;
      if (lastTokens >= 512) fail(`"${clip.key}" is too long for one Kokoro pass (${lastTokens} tokens); split its text`);
      if (audio.sampling_rate !== SAMPLE_RATE) fail(`unexpected sample rate ${audio.sampling_rate}`);
      raw = audio.audio;
      phonemes = lastPhonemes;
      // Per-process temporary names: parallel shards never share one, even for equal texts.
      const rawTmp = `${rawPath}.${process.pid}.tmp`;
      writeFileSync(rawTmp, Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));
      renameSync(rawTmp, rawPath);
      writeFileSync(rawPath + '.json', JSON.stringify({ text: clip.text, voice: list.voice, phonemes }));
    }

    const trimmed = trimSilence(raw, SAMPLE_RATE, settings.trim);
    if (!trimmed.stats) fail(`"${clip.key}" rendered as silence`);
    const norm = normalise(trimmed.samples, SAMPLE_RATE, { targetLufs: settings.lufs, ceilingDbfs: settings.ceilingDbfs });
    const mp3 = encodeMp3(norm.samples, SAMPLE_RATE, settings.kbps);
    const file = slugFor(clip.key);
    writeFileSync(join(outDir, file + '.tmp'), mp3);
    renameSync(join(outDir, file + '.tmp'), join(outDir, file));
    if (opt.wav) writeFileSync(join(resolve(opt.wav), file.replace(/\.mp3$/, '.wav')), wavBytes(norm.samples, SAMPLE_RATE));
    const ms = Math.round((norm.samples.length / SAMPLE_RATE) * 1000);
    const round = (v) => Math.round(v * 10) / 10;
    recordState(outDir, shardTag, {
      key: clip.key,
      file,
      ms,
      bytes: mp3.length,
      textHash: textHash(list.voice, clip.text),
      settingsHash,
      settings,
      phonemes,
      trim: Object.fromEntries(Object.entries(trimmed.stats).map(([a, v]) => [a, round(v)])),
      loudness: Object.fromEntries(Object.entries(norm.stats).map(([a, v]) => [a, round(v)])),
    });

    const warn = [];
    if (trimmed.stats.removedPeakDbfs > trimmed.stats.speechPeakDbfs - 30) warn.push(`trimmed audio reached ${trimmed.stats.removedPeakDbfs.toFixed(0)} dBFS`);
    if (norm.stats.limitedDb > 3) warn.push(`peaks limited by ${norm.stats.limitedDb.toFixed(1)} dB`);
    if (ms < 250) warn.push(`very short (${ms} ms)`);

    rendered++;
    audioSeconds += ms / 1000;
    bytes += mp3.length;
    const elapsed = (Date.now() - started) / 1000;
    const eta = (elapsed / rendered) * (limit - rendered);
    console.log(
      `${tag}${rendered}/${limit} ${clip.key} "${clip.text}" ${ms} ms, ${(mp3.length / 1024).toFixed(1)} kB` +
        `${fromCache ? ' (cached synthesis)' : ` in ${((Date.now() - t0) / 1000).toFixed(2)} s`}` +
        ` | ETA ${fmtTime(eta)}${warn.length ? ` | WARNING: ${warn.join('; ')}` : ''}`,
    );
  }
  const elapsed = (Date.now() - started) / 1000;
  console.log(
    `${tag}done: ${rendered} clips, ${audioSeconds.toFixed(1)} s of audio, ${(bytes / 1024).toFixed(0)} kB` +
      ` (${(bytes / Math.max(audioSeconds, 0.001) / 1024).toFixed(1)} kB per second of speech)` +
      ` in ${fmtTime(elapsed)}${synthSeconds ? `, synthesis ${(audioSeconds / synthSeconds).toFixed(1)}x real time` : ''}`,
  );
  if (n === 1) finish(elapsed);
}

function finish(elapsed) {
  let built;
  try {
    built = buildManifest(outDir, list);
  } catch (error) {
    fail(error.message);
  }
  const { missing, manifest } = built;
  if (missing.length) {
    console.log(`render: ${missing.length} clips are not rendered yet (first: ${missing.slice(0, 3).join(', ')}); run the command again to continue`);
    return;
  }
  const keys = Object.keys(manifest.clips);
  const totalMs = keys.reduce((s, k) => s + manifest.clips[k].ms, 0);
  console.log(`render: manifest.json written for ${keys.length} clips (${(totalMs / 1000 / 60).toFixed(1)} min of speech)${elapsed ? ` in ${fmtTime(elapsed)}` : ''}`);
}
