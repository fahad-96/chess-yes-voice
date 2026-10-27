#!/usr/bin/env node
// Packs a finished render into dist/chess-yes-voice-<voice>-v<version>.tar.gz
// (pure Node: ustar + gzip), after merging the shard state into manifest.json.
//
//   node pack.mjs [clips.json] [--out pack] [--dist dist]
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { buildManifest, loadClipList } from './lib/clips.mjs';
import { createTar, readTar } from './lib/tar.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
let args;
try {
  args = parseArgs({ allowPositionals: true, options: { out: { type: 'string', default: 'pack' }, dist: { type: 'string', default: 'dist' } } });
} catch (error) {
  console.error(`pack: ${error.message}`);
  process.exit(1);
}
const { values: opt, positionals } = args;

function fail(message) {
  console.error(`pack: ${message}`);
  process.exit(1);
}

let list;
try {
  list = loadClipList(resolve(positionals[0] ?? 'clips.json'));
} catch (error) {
  fail(error.message);
}
const outDir = resolve(opt.out);
let built;
try {
  built = buildManifest(outDir, list);
} catch (error) {
  fail(error.message);
}
const { missing, manifest } = built;
if (missing.length) fail(`${missing.length} clips are not rendered yet (first: ${missing.slice(0, 5).join(', ')}). Finish render.mjs first.`);

// Fixed timestamps and order make the archive byte-for-byte reproducible.
const MTIME = Number(process.env.SOURCE_DATE_EPOCH ?? 1767225600); // 2026-01-01T00:00:00Z
const files = [...new Set(Object.values(manifest.clips).map((c) => c.file))].sort();
const entries = [
  { path: 'manifest.json', data: readFileSync(join(outDir, 'manifest.json')) },
  { path: 'LICENSE-AUDIO', data: readFileSync(join(ROOT, 'LICENSE-AUDIO')) },
  ...files.map((f) => ({ path: f, data: readFileSync(join(outDir, f)) })),
];
const stale = readdirSync(outDir).filter((f) => f.endsWith('.mp3') && !files.includes(f));

const tar = createTar(entries, MTIME);
const gz = gzipSync(tar, { level: 9 });
gz[9] = 0xff; // gzip "OS: unknown", so the bytes do not depend on where it was packed

// Read the archive back and compare every file before calling it done.
const back = readTar(gunzipSync(gz));
if (back.length !== entries.length || back.some((f, i) => f.path !== entries[i].path || !f.data.equals(entries[i].data))) fail('archive verification failed');

const name = `chess-yes-voice-${manifest.voice}-v${manifest.version}.tar.gz`;
const distDir = resolve(opt.dist);
mkdirSync(distDir, { recursive: true });
const target = join(distDir, name);
writeFileSync(target, gz);
const sha = createHash('sha256').update(gz).digest('hex');
writeFileSync(`${target}.sha256`, `${sha}  ${basename(target)}\n`);

const audioBytes = files.reduce((s, f) => s + entries.find((e) => e.path === f).data.length, 0);
const totalMs = Object.values(manifest.clips).reduce((s, c) => s + c.ms, 0);
console.log(`pack: ${Object.keys(manifest.clips).length} clips, ${(totalMs / 60000).toFixed(1)} min of speech, MP3 total ${(audioBytes / 1048576).toFixed(2)} MB`);
console.log(`pack: wrote ${target}`);
console.log(`pack: size   ${gz.length} bytes (${(gz.length / 1048576).toFixed(2)} MB)`);
console.log(`pack: sha256 ${sha}`);
if (stale.length) console.log(`pack: ${stale.length} MP3 files in ${opt.out}/ are no longer in the clip list and were left out (e.g. ${stale.slice(0, 3).join(', ')})`);
