// Generator for the two client-bundled Scramble word lists:
//   - src/data/scrambleWords.json — the broad VALIDATION dictionary (any of these counts as a
//     correct answer if it's spellable from the round's tiles). Deliberately generous so a
//     player's creative-but-real word isn't unfairly rejected. NOT capped/sampled — an earlier
//     version randomly sampled 4000 words/length to control bundle size, which meant genuinely
//     common words (e.g. "fans") could be missing purely by chance and get falsely rejected as
//     "not a valid word". Correctness matters more than bundle size for a word-validity check, so
//     this now bundles the FULL filtered list every time.
//   - src/data/scrambleTargetWords.json — the smaller, frequency-curated pool a round's target
//     word (the one whose letters get scrambled into tiles) is actually PICKED from. Drawn from
//     `most-common-words-by-language`'s English frequency list, intersected with the validation
//     dictionary (drops internet jargon/proper nouns the frequency list otherwise includes, and
//     guarantees every possible target word is itself always a valid, acceptable answer).
// Run with: node scripts/generateScrambleWords.cjs
const fs = require('fs');
const path = require('path');
const allWords = require('an-array-of-english-words');
const { getWordsList } = require('most-common-words-by-language');
const { Filter } = require('bad-words');

const filter = new Filter();
const banned = new Set(filter.list.map((w) => w.toLowerCase()));

const MIN_LEN = 4;
const MAX_LEN = 10;

// --- Validation dictionary ---
// (previously used a seeded shuffle to randomly sample down to a capped size — removed now that
// the full list is bundled uncapped; see header comment.)
const byLength = {};
for (let len = MIN_LEN; len <= MAX_LEN; len++) byLength[len] = [];

for (const raw of allWords) {
  const w = raw.toLowerCase();
  if (!/^[a-z]+$/.test(w)) continue;
  if (w.length < MIN_LEN || w.length > MAX_LEN) continue;
  if (banned.has(w)) continue;
  byLength[w.length].push(w);
}

const validationDict = {};
let total = 0;
for (let len = MIN_LEN; len <= MAX_LEN; len++) {
  const words = byLength[len].slice().sort();
  validationDict[len] = words;
  total += words.length;
  console.log(`validation length ${len}: ${words.length} words`);
}
console.log('total validation words:', total);

const validationOutPath = path.join(__dirname, '..', 'src', 'data', 'scrambleWords.json');
fs.writeFileSync(validationOutPath, JSON.stringify(validationDict));
console.log('wrote', validationOutPath, (fs.statSync(validationOutPath).size / 1024).toFixed(0), 'KB');

// --- Target-word pool (common words only) ---
const fullDictSet = new Set(allWords.map((w) => w.toLowerCase()));
const commonWords = getWordsList('english');

// Every common word regardless of length (e.g. "met", only 3 letters) — kept separately from the
// length-filtered candidate list below so a plural's shorter singular can still be recognized even
// if the singular itself is too short to ever be a target word on its own.
const commonWordSet = new Set();
for (const raw of commonWords) {
  const w = raw.toLowerCase();
  if (!/^[a-z]+$/.test(w)) continue;
  if (banned.has(w)) continue;
  if (!fullDictSet.has(w)) continue; // drops jargon/proper nouns the frequency list includes
  commonWordSet.add(w);
}

// Drop simple regular plurals ("+s"/"+es") of another common word — e.g. "balls" once "ball" is
// common, "mets" once "met" is — so target SELECTION doesn't burn variety on trivial base+plural
// pairs. Checked against the FULL common-word set (any length), not just length-4-10 candidates,
// so a short base like "met" (3 letters) still counts even though it's below the target pool's own
// minimum length. Doesn't touch the separate VALIDATION dictionary — "balls"/"mets" are still
// perfectly good answers, they just won't be chosen as what a round makes someone solve.
function isRegularPluralOfCommon(word) {
  if (word.endsWith('es') && commonWordSet.has(word.slice(0, -2))) return true;
  if (word.endsWith('s') && commonWordSet.has(word.slice(0, -1))) return true;
  return false;
}

const targetByLength = {};
for (let len = MIN_LEN; len <= MAX_LEN; len++) targetByLength[len] = [];
for (const w of commonWordSet) {
  if (w.length < MIN_LEN || w.length > MAX_LEN) continue;
  if (isRegularPluralOfCommon(w)) continue;
  targetByLength[w.length].push(w);
}

const targetDict = {};
let targetTotal = 0;
for (let len = MIN_LEN; len <= MAX_LEN; len++) {
  const words = targetByLength[len].slice().sort();
  targetDict[len] = words;
  targetTotal += words.length;
  console.log(`target length ${len}: ${words.length} common words`);
}
console.log('total target words:', targetTotal);

const targetOutPath = path.join(__dirname, '..', 'src', 'data', 'scrambleTargetWords.json');
fs.writeFileSync(targetOutPath, JSON.stringify(targetDict));
console.log('wrote', targetOutPath, (fs.statSync(targetOutPath).size / 1024).toFixed(0), 'KB');
