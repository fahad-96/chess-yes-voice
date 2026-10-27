// The clip list (clips.json), file naming, the resumable render state and the
// manifest. Shared by render.mjs and pack.mjs.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const SAMPLE_RATE = 24000;
export const STATE_DIR = '.state';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Reads and validates clips.json: { version, voice, clips: [{ key, text }] }. */
export function loadClipList(path) {
  let list;
  try {
    list = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read clip list ${path}: ${error.message}`);
  }
  const problems = [];
  if (!Number.isInteger(list.version) || list.version < 1) problems.push('"version" must be a positive integer');
  if (typeof list.voice !== 'string' || !/^[a-z]{2}_[a-z]+$/.test(list.voice)) problems.push('"voice" must be a Kokoro voice id such as "af_bella"');
  if (!Array.isArray(list.clips) || list.clips.length === 0) problems.push('"clips" must be a non-empty array');
  const seen = new Map();
  const slugs = new Map();
  for (const [i, clip] of (list.clips ?? []).entries()) {
    const where = `clips[${i}]`;
    if (typeof clip?.key !== 'string' || !/^[\x21-\x7e]+$/.test(clip.key)) {
      problems.push(`${where}: "key" must be printable ASCII without spaces`);
      continue;
    }
    if (typeof clip.text !== 'string' || clip.text.trim() === '') problems.push(`${where} (${clip.key}): "text" is empty`);
    if (seen.has(clip.key)) problems.push(`${where}: duplicate key "${clip.key}" (also clips[${seen.get(clip.key)}])`);
    seen.set(clip.key, i);
    const slug = slugFor(clip.key).toLowerCase();
    if (slugs.has(slug) && slugs.get(slug) !== clip.key) problems.push(`${where}: file name collision between "${clip.key}" and "${slugs.get(slug)}"`);
    slugs.set(slug, clip.key);
  }
  if (problems.length) throw new Error(`invalid clip list ${path}:\n  ${problems.slice(0, 20).join('\n  ')}${problems.length > 20 ? `\n  ... and ${problems.length - 20} more` : ''}`);
  return list;
}

/**
 * Filesystem- and URL-safe file name for a clip key: a readable lowercase
 * part plus a short hash of the exact key, so names never collide (even on
 * case-insensitive file systems). "move:Nf3+" -> "move-nf3-check-<hash>.mp3".
 */
export function slugFor(key) {
  const readable = key
    .replace(/\+/g, '-check')
    .replace(/#/g, '-mate')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
    .replace(/-$/, '');
  return `${readable || 'clip'}-${sha256(key).slice(0, 6)}.mp3`;
}

/** Hash of what is spoken: a clip is re-rendered when its text or voice changes. */
export const textHash = (voice, text) => sha256(`${voice}\n${text}`).slice(0, 16);

/** Appends one finished clip to this process's state log (safe with parallel shards). */
export function recordState(outDir, shardTag, entry) {
  const dir = join(outDir, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${shardTag}.jsonl`), JSON.stringify({ ...entry, at: Date.now() }) + '\n');
}

/** Merges every shard's state log; the newest entry per key wins. */
export function loadState(outDir) {
  const dir = join(outDir, STATE_DIR);
  const state = new Map();
  if (!existsSync(dir)) return state;
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue; // a line cut short by a crash; that clip is simply rendered again
      }
      const prev = state.get(e.key);
      if (!prev || (e.at ?? 0) >= (prev.at ?? 0)) state.set(e.key, e);
    }
  }
  return state;
}

/** True when the clip's MP3 exists and was rendered from this text with these settings. */
export function isDone(outDir, state, voice, clip, settingsHash) {
  const e = state.get(clip.key);
  return !!e && e.textHash === textHash(voice, clip.text) && e.settingsHash === settingsHash && e.file === slugFor(clip.key) && existsSync(join(outDir, e.file));
}

/**
 * Builds manifest.json from the merged state. Returns the keys that are not
 * rendered yet (or were rendered from different text) instead of writing a
 * partial manifest, and refuses to mix clips rendered with different settings.
 */
export function buildManifest(outDir, list) {
  const state = loadState(outDir);
  const missing = [];
  const clips = {};
  const settings = new Map();
  for (const clip of list.clips) {
    const e = state.get(clip.key);
    if (!e || e.textHash !== textHash(list.voice, clip.text) || !existsSync(join(outDir, e.file))) {
      missing.push(clip.key);
      continue;
    }
    settings.set(e.settingsHash, e.settings);
    clips[clip.key] = { file: e.file, ms: e.ms };
  }
  if (missing.length) return { missing };
  if (settings.size > 1) {
    throw new Error(`the pack mixes clips rendered with different settings: ${[...settings.values()].map((s) => JSON.stringify(s)).join(' vs ')}. Re-run render.mjs with one set of options.`);
  }
  const s = [...settings.values()][0];
  const manifest = {
    version: list.version,
    voice: list.voice,
    model: MODEL_ID,
    dtype: s.dtype,
    sampleRate: SAMPLE_RATE,
    kbps: s.kbps,
    lufs: s.lufs,
    license: 'CC-BY-4.0',
    attribution: 'Chess Yes voice pack by Fahad Yousuf, generated with Kokoro-82M',
    clips,
  };
  // Pretty header, one clip per line: small, and readable in diffs.
  const { clips: _, ...head } = manifest;
  const lines = Object.entries(clips).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const text = JSON.stringify(head, null, 2).replace(/\n}$/, `,\n  "clips": {\n${lines.join(',\n')}\n  }\n}\n`);
  const tmp = join(outDir, 'manifest.json.tmp');
  writeFileSync(tmp, text);
  renameSync(tmp, join(outDir, 'manifest.json'));
  return { missing, manifest };
}
