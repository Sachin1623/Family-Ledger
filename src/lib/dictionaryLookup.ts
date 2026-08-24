// Best-effort lookup against the free, keyless dictionaryapi.dev API for a solved/revealed word's
// meaning + one example sentence — shown post-solve (see ScrambleGame.tsx / ScrambleMultiplayerGame.tsx)
// and on the multiplayer match-end word-reveal screen. Deliberately NOT bundled offline: the
// target-word pool alone is ~5,800 words and any dictionary-valid answer is a much larger set on
// top of that — no realistic way to ship definitions+examples for all of them in the app bundle.
// This means the definition panel silently shows nothing when offline or the API has no entry —
// the actual game (scoring, validation) never depends on this succeeding.
export interface WordDefinition {
  word: string;
  meaning: string;
  example: string | null;
}

// `status` lets callers tell "the API genuinely has nothing for this word" (not-found) apart from
// "the request itself never completed" (error — network down, blocked by a DNS/ad-blocker, the API
// briefly unreachable, etc.) — these used to both collapse into a plain `null`, which meant a real
// connectivity problem silently rendered as "No dictionary definition found" for every single word
// including ones that obviously have one, with zero trace of what actually went wrong.
export type WordDefinitionResult =
  | { status: 'found'; definition: WordDefinition }
  | { status: 'not-found' }
  | { status: 'error' };

const cache = new Map<string, WordDefinitionResult>();

export async function fetchWordDefinition(word: string): Promise<WordDefinitionResult> {
  const key = word.trim().toLowerCase();
  if (!key) return { status: 'not-found' };
  if (cache.has(key)) return cache.get(key)!;

  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(key)}`);
    if (!res.ok) {
      // 404 = the API genuinely has no entry (a real "not found"); anything else (5xx, a proxy
      // block, etc.) is treated as an error instead, since it's not the API telling us the word
      // doesn't exist.
      const result: WordDefinitionResult = res.status === 404 ? { status: 'not-found' } : { status: 'error' };
      if (result.status === 'error') console.error(`Dictionary lookup for "${key}" failed: HTTP ${res.status}`);
      cache.set(key, result);
      return result;
    }
    const data = await res.json();
    const entry = Array.isArray(data) ? data[0] : null;
    const meanings: any[] = entry?.meanings || [];
    for (const m of meanings) {
      for (const def of m.definitions || []) {
        if (def?.definition) {
          const result: WordDefinitionResult = {
            status: 'found',
            definition: { word: key, meaning: def.definition, example: def.example || null },
          };
          cache.set(key, result);
          return result;
        }
      }
    }
    const result: WordDefinitionResult = { status: 'not-found' };
    cache.set(key, result);
    return result;
  } catch (err) {
    // The fetch itself never completed — offline, DNS/ad-blocker interference, a blocked domain,
    // etc. Deliberately NOT cached: a transient network blip shouldn't permanently poison this
    // word for the rest of the session the way a real "not found" should.
    console.error(`Dictionary lookup for "${key}" failed:`, err);
    return { status: 'error' };
  }
}

// Batch helper for the match-end reveal screen. Originally fired all ~15 words at once via
// Promise.all with no cap — in practice the free dictionaryapi.dev endpoint (and some mobile
// networks) don't handle a full burst of simultaneous requests well, so most came back as
// connection errors while only one or two landed. A small concurrency cap plus one retry for a
// genuine error (not "not-found", which is a real answer from the API, not a failure) fixes that
// without noticeably slowing down the reveal screen.
const BATCH_CONCURRENCY = 3;

export async function fetchWordDefinitions(words: string[]): Promise<Record<string, WordDefinitionResult>> {
  const uniqueWords = Array.from(new Set(words.map((w) => w.trim().toLowerCase()).filter(Boolean)));
  const map: Record<string, WordDefinitionResult> = {};
  let cursor = 0;
  async function worker() {
    while (cursor < uniqueWords.length) {
      const word = uniqueWords[cursor++];
      let result = await fetchWordDefinition(word);
      // Errors are deliberately never cached (see fetchWordDefinition), so a second call is a
      // real retry, not a cache hit.
      if (result.status === 'error') result = await fetchWordDefinition(word);
      map[word] = result;
    }
  }
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, uniqueWords.length) }, worker));
  return map;
}
