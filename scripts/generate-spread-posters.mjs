// Draws the Spread the Word posters ONCE (12 weekly editions x 5 posters x iPhone/Android) and saves them as JPEG files in
// public/spread-posters/, which the server then serves to everybody. The app shows one edition per week.
//
//   npm run posters            (or: node scripts/generate-spread-posters.mjs)
//
// Run it again whenever the poster design, wording or footer changes, bump SPREAD_POSTER_VERSION in src/lib/spreadPosterCache.ts (and
// POSTER_VERSION below) so phones pick up the new files, then deploy. It uses the app's own poster drawing code, run in a headless
// Edge/Chrome, so nothing needs to be installed beyond the dev dependencies. Needs internet once for the web fonts.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const POSTER_VERSION = 1;
const OUT = path.resolve('public/spread-posters');
const EXPECTED = 120; // 2 phones x 5 posters x 12 weekly editions (keep in step with SPREAD_EDITIONS)
const VITE_PORT = 47188;
const SAVE_PORT = 47189;

const browserCandidates = [
  process.env.POSTER_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const browser = browserCandidates.find((p) => fs.existsSync(p));
if (!browser) throw new Error('No Edge/Chrome found. Set POSTER_BROWSER to its path.');

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.endsWith('.jpg')) fs.rmSync(path.join(OUT, f));

let saved = 0;
let finish;
const finished = new Promise((resolve) => (finish = resolve));

const saver = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  const url = new URL(req.url, `http://127.0.0.1:${SAVE_PORT}`);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (url.searchParams.get('error')) {
      console.error('Poster page error:', body.toString());
      finish(false);
    } else if (url.searchParams.get('done')) {
      finish(true);
    } else {
      const name = path.basename(url.searchParams.get('file') || '');
      if (name.endsWith('.jpg')) {
        fs.writeFileSync(path.join(OUT, name), body);
        saved += 1;
        console.log(`saved ${name} (${Math.round(body.length / 1024)} KB)`);
      }
    }
    res.writeHead(204).end();
  });
});
await new Promise((r) => saver.listen(SAVE_PORT, '127.0.0.1', r));

const vite = await createServer({ server: { port: VITE_PORT, host: 'localhost', strictPort: true }, logLevel: 'error' });
await vite.listen();

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'poster-browser-'));
const child = spawn(browser, [
  '--headless=new',
  '--disable-gpu',
  `--user-data-dir=${profile}`,
  '--window-size=1200,1500',
  '--virtual-time-budget=900000',
  `http://localhost:${VITE_PORT}/posters-export.html?v=${POSTER_VERSION}&save=${encodeURIComponent(`http://127.0.0.1:${SAVE_PORT}/save`)}`,
], { stdio: 'ignore' });

const timeout = setTimeout(() => finish(false), 900000);
const ok = await finished;
clearTimeout(timeout);
child.kill();
await vite.close();
saver.close();
fs.rmSync(profile, { recursive: true, force: true });

if (!ok || saved !== EXPECTED) {
  console.error(`Failed: saved ${saved} of ${EXPECTED} posters.`);
  process.exit(1);
}
console.log(`Done: ${saved} posters in ${OUT}`);
process.exit(0);
