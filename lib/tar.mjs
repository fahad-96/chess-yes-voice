// Minimal, dependency-free ustar writer and reader (regular files only),
// enough to build and verify a reproducible .tar.gz of the voice pack.

const BLOCK = 512;

function octal(value, width) {
  // width includes the trailing NUL
  const s = value.toString(8);
  if (s.length > width - 1) throw new Error(`value ${value} does not fit a ${width}-byte tar field`);
  return s.padStart(width - 1, '0') + '\0';
}

function splitName(path) {
  const bytes = Buffer.byteLength(path);
  if (bytes <= 100) return { name: path, prefix: '' };
  const cut = path.lastIndexOf('/', 155);
  if (cut <= 0 || Buffer.byteLength(path.slice(cut + 1)) > 100) throw new Error(`path too long for ustar: ${path}`);
  return { name: path.slice(cut + 1), prefix: path.slice(0, cut) };
}

function header(path, size, mtime) {
  if (!/^[\x20-\x7e]+$/.test(path)) throw new Error(`non-ASCII tar path: ${path}`);
  const h = Buffer.alloc(BLOCK);
  const { name, prefix } = splitName(path);
  h.write(name, 0, 100, 'ascii');
  h.write(octal(0o644, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(mtime, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii'); // checksum placeholder (8 spaces)
  h.write('0', 156, 'ascii'); // regular file
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write('root', 265, 'ascii');
  h.write('root', 297, 'ascii');
  h.write(prefix, 345, 155, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 'ascii');
  return h;
}

/**
 * @param {{ path: string, data: Buffer }[]} entries in the order to write them
 * @param {number} mtime seconds since the epoch, shared by every entry (reproducible output)
 */
export function createTar(entries, mtime = 0) {
  const parts = [];
  for (const { path, data } of entries) {
    parts.push(header(path, data.length, mtime), data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** Reads back regular files from a ustar archive (used to verify what we wrote). */
export function readTar(buf) {
  const files = [];
  let o = 0;
  while (o + BLOCK <= buf.length) {
    const h = buf.subarray(o, o + BLOCK);
    if (h.every((b) => b === 0)) break;
    const str = (a, n) => h.toString('ascii', a, a + n).replace(/\0.*$/s, '');
    const stored = parseInt(str(148, 8).trim(), 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== stored) throw new Error(`bad tar checksum at offset ${o}`);
    const prefix = str(345, 155);
    const name = (prefix ? prefix + '/' : '') + str(0, 100);
    const size = parseInt(str(124, 12), 8);
    const type = str(156, 1) || '0';
    o += BLOCK;
    if (type === '0') files.push({ path: name, data: buf.subarray(o, o + size) });
    o += Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}
