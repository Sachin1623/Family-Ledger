// Developer-only page used by scripts/generate-spread-posters.mjs: draws every Spread the Word poster (both phones, both wordings) with
// the normal poster code and hands each picture to the local save server. Not linked from the app and not part of the production build.
import { renderSpreadCard, SPREAD_VARIANTS, SPREAD_EDITIONS } from './lib/spreadCardImage';
import { setPosterPlatform } from './lib/cardCanvas';

const params = new URLSearchParams(location.search);
const saveUrl = params.get('save') || 'http://127.0.0.1:5189/save';
const version = params.get('v') || '1';
const log = (m: string) => { const el = document.getElementById('log'); if (el) el.textContent += `\n${m}`; };

(async () => {
  log('start');
  let n = 0;
  for (const platform of ['android', 'ios'] as const) {
    setPosterPlatform(platform);
    for (const v of SPREAD_VARIANTS) {
      for (let edition = 0; edition < SPREAD_EDITIONS; edition++) {
        log(`drawing ${platform} ${v.id} ${edition}`);
        // Saved as JPEG: about a quarter of the size of the PNG, and the app turns it back into a PNG when it is shared.
        const blob = await renderSpreadCard(v.id, 20261019, edition, true);
        log('drawn');
        const name = `${platform}-${v.id}-${edition}-v${version}.jpg`;
        const res = await fetch(`${saveUrl}?file=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
        log(`${res.ok ? 'saved' : 'FAILED'} ${name} (${Math.round(blob.size / 1024)} KB)`);
        n++;
      }
    }
  }
  setPosterPlatform(null);
  log(`done ${n}`);
  await fetch(`${saveUrl}?done=1`, { method: 'POST', body: String(n) });
})().catch((e) => { log(`ERROR ${e?.message || e}`); fetch(`${saveUrl}?error=1`, { method: 'POST', body: String(e?.message || e) }).catch(() => {}); });
