# Chess Yes voice

The coach voice for [Chess Yes](https://chessyes.netlify.app), the free chess game review app.

Everything the coach can say is rendered once, ahead of time, into small MP3 clips: moves ("Knight takes e5", "Queen to b8, check!"), squares, numbers and short verdicts ("That's a blunder.", "was better."). The app downloads this pack when it is built, serves it from its own site and stitches clips into sentences with the Web Audio API. Phones get a natural voice that starts instantly and works offline, and no speech model ever runs on the device.

This repository holds the tooling that renders and packs the clips. The audio is published as release archives.

## The voice

| | |
|---|---|
| Model | [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) v1.0 by hexgrad (Apache-2.0), run through the ONNX export [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) with [kokoro-js](https://www.npmjs.com/package/kokoro-js) on the CPU at full precision (fp32) |
| Voice | `af_bella` (American English) |
| Format | MP3, mono, 24 kHz, 48 kbps CBR: about 6.4 kB per second of speech |
| Trimming | leading and trailing silence removed, 40 ms of the original audio kept on each side |
| Loudness | every clip normalised to -18 LUFS (ITU-R BS.1770) with a -1.5 dBFS peak ceiling, so stitched clips sound equally loud |
| Gapless | each file carries an Info/LAME tag with the encoder delay and padding, so browsers that honour it (verified in Chromium, which covers Chrome, Edge and Android) decode exactly the rendered samples instead of adding about 46 ms of silence |

## What a release contains

`chess-yes-voice-af_bella-v1.tar.gz` (plus a `.sha256` file) unpacks flat into one folder:

```
manifest.json
LICENSE-AUDIO
move-nf3-check-77e6e8.mp3
phrase-verdict_blunder_1-b7bd04.mp3
...
```

`manifest.json` maps every clip key to its file and duration:

```json
{
  "version": 1,
  "voice": "af_bella",
  "model": "onnx-community/Kokoro-82M-v1.0-ONNX",
  "dtype": "fp32",
  "sampleRate": 24000,
  "kbps": 48,
  "lufs": -18,
  "license": "CC-BY-4.0",
  "attribution": "Chess Yes voice pack by Fahad Yousuf, generated with Kokoro-82M",
  "clips": {
    "move:Nf3+": { "file": "move-nf3-check-77e6e8.mp3", "ms": 1170 }
  }
}
```

`ms` is the exact length of the encoded audio, including the 40 ms margins. File names are a readable form of the key plus a short hash of it, so they are always URL-safe and never collide, even on case-insensitive file systems. Always look them up in the manifest rather than building them.

### Stitching clips

Decode each clip once with `AudioContext.decodeAudioData` and schedule the pieces back to back with `AudioBufferSourceNode.start(when)`, advancing `when` by each clip's duration plus a gap. With the 40 ms margins on both sides, a 60 ms gap gives a natural pause of about 150 ms inside a sentence ("Bishop takes g8" + "winning the rook for free."); use around 300 ms between sentences. The app's coach script gives each pause as silence between the speech of two clips, so it starts the next clip at the previous clip's end minus 80 ms (the two margins) plus that pause; the margins are near-silent, so a little overlap is inaudible. All clips share one loudness, so no per-clip volume is needed. At about 7 kB per clip it is cheap to fetch only the clips a review needs and let the service worker cache them.

## The clip list

`clips.json` comes from the Chess Yes app and lists every clip with the exact text Kokoro should say:

```json
{
  "version": 1,
  "voice": "af_bella",
  "clips": [
    { "key": "move:Nf3+", "text": "Knight to f3, check!" },
    { "key": "sq:e4", "text": "e4" },
    { "key": "phrase:verdict_blunder_1", "text": "That's a blunder." }
  ]
}
```

Keys are stable ASCII ids: `move:` plus the SAN without disambiguation or annotations, `sq:` plus a square, `phrase:` plus a snake_case id, `num:` for numbers. Bump `version` whenever the set of clips changes in a way the app depends on; it names the release.

## Regenerating the pack

You need Node 20 or newer (tested on Node 24) and about 2 GB of free disk space. No GPU is needed: on a 12-thread laptop CPU, about 2,800 clips take roughly an hour with `--jobs 3`.

```sh
npm install
node render.mjs --jobs 3       # clips.json -> pack/*.mp3 + pack/manifest.json
node pack.mjs                  # pack/ -> dist/chess-yes-voice-af_bella-v1.tar.gz
```

The first run downloads the model (325 MB) into `.cache/`. Keep a laptop plugged in and in its best performance power mode: with power saving, rendering can run at half speed. Rendering is resumable: stop it at any time and run the same command again, and it continues where it left off. A clip is rendered again only when its text, the voice or the settings change. The raw synthesis is cached in `.cache/raw/`, so changing the bitrate or loudness later re-encodes in a minute instead of rendering again.

Then publish the archive as a GitHub release (the tag is `v` plus the clip list version):

```sh
gh release create v1 dist/chess-yes-voice-af_bella-v1.tar.gz dist/chess-yes-voice-af_bella-v1.tar.gz.sha256 \
  --title "Voice pack v1 (af_bella)" \
  --notes "Pre-rendered coach voice for Chess Yes. Audio: CC BY 4.0, Chess Yes voice pack by Fahad Yousuf, generated with Kokoro-82M."
```

The app's build downloads that asset, checks it against the `.sha256` and unpacks it into the site.

### render.mjs options

| Option | Default | |
|---|---|---|
| `[clips.json]` | `clips.json` | the clip list to render |
| `--jobs <n>` | 1 | run n processes in parallel, each on its own shard, then write the manifest |
| `--shard <k/n>` | | render only shard k of n (to split the work by hand, even across machines; copy `pack/` together afterwards and run `pack.mjs`) |
| `--threads <t>` | cores / jobs | ONNX Runtime threads per process (with one job, ONNX Runtime chooses) |
| `--out <dir>` | `pack` | output folder |
| `--dtype <d>` | `fp32` | `q8` (8-bit quantised) also works, but on a desktop CPU it is slower than fp32 and only approximates the full model |
| `--kbps <b>` | 48 | MP3 bitrate, 40 to 96 (below 48 the encoder cuts the treble) |
| `--lufs=<l>` | -18 | loudness target (write negative values with `=`) |
| `--speed <s>` | 1 | speaking speed |
| `--limit <n>` | | stop after n new clips, per process with `--jobs` (quick tests) |
| `--wav <dir>` | | also write the processed clips as WAV files for listening |
| `--force` | | process every clip again; the synthesis cached in `.cache/raw/` is reused, so delete that folder to synthesise from scratch |

Each finished clip is logged with its phonemes, trimming and loudness figures in `pack/.state/*.jsonl`, which is how runs resume and how parallel shards are merged. `pack.mjs` builds the manifest from those logs, refuses to pack an incomplete render or one that mixes settings, reads the archive back to verify it, and produces the same bytes every time for the same clips.

`npm test` runs quick checks of the audio, naming and archive code without the model; try the whole pipeline with `node render.mjs test/test-clips.json --out pack-test`.

## Files

```
render.mjs        renders clips.json into pack/
pack.mjs          packs pack/ into dist/*.tar.gz and prints its sha256
lib/audio.mjs     silence trimming, loudness, peak limiter, MP3 with gapless tag
lib/clips.mjs     clip list, file names, resumable state, manifest
lib/tar.mjs       minimal ustar writer and reader
test/             self-test and a 30-clip test list
clips.json        the clip list from the app
```

`pack/`, `pack-*/`, `dist/` and `.cache/` are generated and not committed.

## Licences

- Code in this repository: MIT, see [LICENSE](LICENSE).
- Generated audio (the clips and manifest in the releases): [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), see [LICENSE-AUDIO](LICENSE-AUDIO). Attribution: "Chess Yes voice pack by Fahad Yousuf, generated with Kokoro-82M".
- The Kokoro-82M model and its voices are by hexgrad, Apache-2.0: <https://huggingface.co/hexgrad/Kokoro-82M>.
- Rendering uses kokoro-js and @huggingface/transformers (Apache-2.0) and @breezystack/lamejs (LGPL-3.0) as development tools; none of them ship with the audio.

Created and maintained by Fahad Yousuf (https://fahad-yousuf.netlify.app/).
