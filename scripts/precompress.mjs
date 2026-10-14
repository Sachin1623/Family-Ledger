// Run after `vite build`: writes a Brotli (.br) and a gzip (.gz) copy next to every compressible file in dist/, so the
// server can send the small version straight from disk instead of compressing the 7 MB app bundle on every request
// (which would burn server CPU). server.ts picks the right copy from the browser's Accept-Encoding header.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.join(process.cwd(), 'dist');
const COMPRESSIBLE = /\.(js|mjs|css|html|svg|json|map|txt|xml|webmanifest)$/i;
const MIN_BYTES = 1024;

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

let before = 0;
let afterBr = 0;
let files = 0;
for (const file of walk(root)) {
  if (!COMPRESSIBLE.test(file) || file.endsWith('server.cjs') || file.endsWith('server.cjs.map')) continue; // never served to clients
  const buf = fs.readFileSync(file);
  if (buf.length < MIN_BYTES) continue;
  const br = zlib.brotliCompressSync(buf, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  });
  const gz = zlib.gzipSync(buf, { level: 9 });
  if (br.length < buf.length) fs.writeFileSync(file + '.br', br);
  if (gz.length < buf.length) fs.writeFileSync(file + '.gz', gz);
  before += buf.length;
  afterBr += Math.min(br.length, buf.length);
  files++;
}
console.log(`precompress: ${files} files, ${(before / 1048576).toFixed(1)} MB -> ${(afterBr / 1048576).toFixed(1)} MB with Brotli`);
