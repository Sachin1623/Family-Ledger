// Turns a spoken sentence ("spent 450 on groceries at Sharma Dairy yesterday") into the fields Add Expense needs. Runs entirely on the
// phone with plain rules — no server and no AI call — so it costs nothing and the sentence never leaves the device. What it cannot
// work out is simply left empty for the person to fill in.

export interface SpokenExpense {
  amount?: number;
  description: string;
  categoryId?: string;
  date?: string; // YYYY-MM-DD
  isIncome: boolean;
}

interface CategoryRef {
  id: string;
  name: string;
}

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, lakh: 100000, lakhs: 100000, lac: 100000, crore: 10000000, crores: 10000000 };

// "two thousand five hundred" -> 2500. Only whole words that are number words are folded; everything else is left as it was said.
function foldNumberWords(words: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  const isNum = (w: string) => w in ONES || w in TENS || w in SCALES;
  while (i < words.length) {
    if (!isNum(words[i])) { out.push(words[i]); i += 1; continue; }
    let total = 0;
    let current = 0;
    while (i < words.length && (isNum(words[i]) || (words[i] === 'and' && i + 1 < words.length && isNum(words[i + 1])))) {
      const w = words[i];
      if (w === 'and') { i += 1; continue; }
      if (w in ONES) current += ONES[w];
      else if (w in TENS) current += TENS[w];
      else {
        const scale = SCALES[w];
        if (scale === 100) current = (current || 1) * 100;
        else { total += (current || 1) * scale; current = 0; }
      }
      i += 1;
    }
    out.push(String(total + current));
  }
  return out;
}

const CATEGORY_WORDS: Record<string, string[]> = {
  groceries: ['grocery', 'groceries', 'vegetable', 'vegetables', 'veggies', 'fruit', 'fruits', 'milk', 'kirana', 'supermarket', 'zepto', 'blinkit', 'bigbasket', 'instamart', 'dmart', 'provisions', 'atta', 'rice', 'dairy'],
  food: ['noodles', 'maggi', 'momos', 'momo', 'sandwich', 'thali', 'paratha', 'dosa', 'idli', 'samosa', 'chaat', 'juice', 'cake', 'dessert', 'pasta', 'fries', 'meal', 'food', 'tiffin', 'canteen', 'bakery', 'chinese', 'dinner', 'lunch', 'breakfast', 'restaurant', 'cafe', 'coffee', 'tea', 'pizza', 'burger', 'swiggy', 'zomato', 'snacks', 'biryani', 'eating', 'takeaway', 'dhaba', 'chai', 'ice cream', 'dominos'],
  travel: ['petrol', 'diesel', 'fuel', 'uber', 'ola', 'rapido', 'auto', 'cab', 'taxi', 'metro', 'bus', 'train', 'flight', 'toll', 'parking', 'fastag', 'rickshaw', 'ticket', 'cng'],
  bills: ['electricity', 'light bill', 'water bill', 'gas', 'wifi', 'internet', 'broadband', 'recharge', 'mobile bill', 'phone bill', 'dth', 'bill', 'utility', 'postpaid', 'prepaid'],
  health: ['doctor', 'medicine', 'medicines', 'medical', 'pharmacy', 'hospital', 'chemist', 'tablets', 'lab test', 'dentist', 'clinic', 'checkup'],
  education: ['school', 'fees', 'fee', 'tuition', 'books', 'course', 'college', 'exam', 'stationery'],
  kids: ['toys', 'toy', 'diapers', 'diaper', 'baby', 'daycare', 'kids'],
  ent: ['movie', 'movies', 'netflix', 'cinema', 'party', 'concert', 'outing', 'subscription', 'hotstar', 'spotify', 'prime', 'game', 'games'],
  finance: ['emi', 'loan', 'insurance', 'premium', 'sip', 'investment', 'credit card'],
  shopping: ['clothes', 'cloth', 'shirt', 'shirts', 'shoes', 'dress', 'apparel', 'jeans', 'saree', 'kurta', 'jacket', 'tshirt'],
  household: ['cleaning', 'maid', 'plumber', 'repair', 'furniture', 'appliance', 'utensils', 'detergent', 'electrician', 'carpenter', 'househelp'],
  gifts: ['gift', 'gifts', 'present', 'birthday', 'wedding', 'donation'],
  personal: ['haircut', 'salon', 'spa', 'grooming', 'barber', 'parlour', 'parlor', 'gym'],
  housing: ['rent', 'maintenance', 'society', 'mortgage'],
  // income
  salary: ['salary', 'payroll', 'wages', 'stipend'],
  house_rent: ['rent received', 'rental income'],
  sale: ['sold', 'sale'],
  reimbursement: ['reimbursement', 'reimbursed'],
  interest: ['interest', 'dividend', 'returns'],
  refund: ['refund', 'cashback'],
  gift: ['gift received'],
};

const INCOME_WORDS = ['received', 'earned', 'salary', 'credited', 'income', 'refund', 'cashback', 'reimbursement', 'reimbursed', 'dividend', 'got paid', 'sold'];
const FILLER = new Set([
  'i', 'we', 'spent', 'spend', 'spends', 'spending', 'paid', 'pay', 'payed', 'paying', 'bought', 'buy', 'purchased',
  // what the phone's recogniser often hears when you say "spent": "send", "sent", "spin", "bend"
  'send', 'sent', 'spin', 'bend', 'pant', 'pent', 'bent', 'sand', 'had', 'ate', 'eat', 'eaten', 'having', 'took', 'ordered', 'add', 'an', 'a', 'the', 'expense', 'expenses', 'for', 'on', 'to', 'at', 'of', 'my', 'was', 'is', 'it',
  'rupees', 'rupee', 'rs', 'inr', 'only', 'today', 'yesterday', 'ago', 'just', 'please', 'log', 'record', 'received', 'earned', 'got', 'credited',
]);

function pad(n: number) {
  return String(n).padStart(2, '0');
}
function ymd(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseSpokenExpense(spoken: string, categories: CategoryRef[], now: Date = new Date()): SpokenExpense {
  let text = ` ${spoken.toLowerCase().replace(/₹/g, ' rupees ').replace(/[$€£]/g, ' ').replace(/(\d),(\d{3})/g, '$1$2').replace(/[,.!?]+(?=\s|$)/g, ' ')} `;
  text = text.replace(/\b(\d+(?:\.\d+)?)\s*k\b/g, (_, n) => ` ${Math.round(parseFloat(n) * 1000)} `);
  text = text.replace(/\b(\d+(?:\.\d+)?)\s*(lakh|lakhs|lac)\b/g, (_, n) => ` ${Math.round(parseFloat(n) * 100000)} `);

  // ── date ──
  let date: string | undefined;
  const dayShift = (n: number) => { const d = new Date(now); d.setDate(d.getDate() - n); return ymd(d); };
  const dateWords: Array<[RegExp, () => string]> = [
    [/\bday before yesterday\b/, () => dayShift(2)],
    [/\b(yesterday|last night)\b/, () => dayShift(1)],
    [/\b(\d+|one|two|three|four|five|six|seven) days? ago\b/, () => dayShift(1)],
  ];
  for (const [re, fn] of dateWords) {
    if (re.test(text)) {
      const m = text.match(re)!;
      date = re.source.includes('days?') ? dayShift(Number(foldNumberWords([m[1]])[0]) || 1) : fn();
      text = text.replace(re, ' ');
      break;
    }
  }
  if (!date) {
    const ord = text.match(/\bon (?:the )?(\d{1,2})(?:st|nd|rd|th)\b/) || text.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/);
    if (ord) {
      const day = Number(ord[1]);
      if (day >= 1 && day <= 31) {
        const d = new Date(now.getFullYear(), now.getMonth(), day);
        if (d.getTime() > now.getTime()) d.setMonth(d.getMonth() - 1);
        date = ymd(d);
        text = text.replace(ord[0], ' ');
      }
    }
  }
  text = text.replace(/\btoday\b/g, ' ');

  const words = foldNumberWords(text.split(/\s+/).filter(Boolean));

  // ── amount: a number next to a currency word wins, otherwise the first plain number ──
  let amount: number | undefined;
  let amountIdx = -1;
  const isNumber = (w: string) => /^\d+(\.\d+)?$/.test(w);
  for (let i = 0; i < words.length; i++) {
    if (!isNumber(words[i])) continue;
    const near = [words[i - 1], words[i + 1]];
    if (near.some((w) => w === 'rupees' || w === 'rupee' || w === 'rs' || w === 'inr')) { amount = parseFloat(words[i]); amountIdx = i; break; }
  }
  if (amount === undefined) {
    for (let i = 0; i < words.length; i++) {
      if (isNumber(words[i]) && parseFloat(words[i]) > 0) { amount = parseFloat(words[i]); amountIdx = i; break; }
    }
  }

  // ── income or expense ──
  const joined = ` ${words.join(' ')} `;
  const isIncome = INCOME_WORDS.some((w) => joined.includes(` ${w} `));

  // ── category: custom/renamed names first, then the keyword lists ──
  const wantedIds = new Set(categories.map((c) => c.id));
  let categoryId: string | undefined;
  for (const c of categories) {
    const nm = c.name.toLowerCase();
    if (nm.length > 2 && joined.includes(` ${nm} `)) { categoryId = c.id; break; }
  }
  if (!categoryId) {
    let best = 0;
    for (const [id, list] of Object.entries(CATEGORY_WORDS)) {
      if (!wantedIds.has(id)) continue;
      const hits = list.filter((w) => joined.includes(` ${w} `) || joined.includes(` ${w}s `)).length;
      if (hits > best) { best = hits; categoryId = id; }
    }
  }
  if (isIncome && !categoryId) categoryId = wantedIds.has('other_income') ? 'other_income' : undefined;

  // ── description: what is left once the amount, dates and filler words are removed ──
  let left = words.filter((w, i) => i !== amountIdx && !FILLER.has(w) && !isNumber(w));
  // "500 rupees pant on pizza": whatever sits between the amount and the first "on / for / at / to" is the verb (mis-heard or not), not
  // part of what it was for — so when a preposition follows the amount and something follows that, the description starts after it.
  if (amountIdx >= 0) {
    const prepAt = words.findIndex((w, i) => i > amountIdx && (w === 'on' || w === 'for' || w === 'at' || w === 'to'));
    if (prepAt >= 0) {
      const afterPrep = words.slice(prepAt + 1).filter((w) => !FILLER.has(w) && !isNumber(w));
      if (afterPrep.length > 0) left = afterPrep;
    }
  }
  let description = left.join(' ').trim();
  description = description.replace(/\b([a-z])/g, (m) => m.toUpperCase());

  return { amount, description, categoryId, date, isIncome };
}
