// Icons for shopping: a picture for each item (guessed from its words) and for each list (guessed from its name, or picked by hand).
// Everything is a guess from common words, so an item that matches nothing just gets a neutral bag.

// word(s) -> emoji, checked top to bottom; each word may be plural ("eggs", "tomatoes")
const ITEM_ICONS: [string, string][] = [
  ['ice cream|icecream|kulfi', '🍦'], // before dairy, so "cream" in it is not read as milk
  // dairy and eggs
  ['milk|doodh|toned|dahi|curd|yogurt|yoghurt|lassi|buttermilk|chaas|cream', '🥛'],
  ['egg|anda', '🥚'],
  ['butter|ghee|margarine', '🧈'],
  ['cheese|paneer|tofu', '🧀'],
  // bakery and grains
  ['bread|bun|pav|toast|roti|chapati|paratha|naan|bagel|croissant|rusk', '🍞'],
  ['cake|pastry|cupcake|brownie|muffin', '🎂'],
  ['rice|basmati|poha|oats|cornflakes|cereal|muesli|atta|flour|maida|suji|rava|semolina|besan|wheat|dal|daal|lentil|chana|rajma|moong|toor|urad|pulses|beans', '🌾'],
  ['pasta|noodle|maggi|macaroni|spaghetti|vermicelli|sewai', '🍜'],
  // fruit
  ['banana', '🍌'], ['apple', '🍎'], ['mango', '🥭'], ['orange|mosambi|kinnow|tangerine', '🍊'], ['lemon|lime|nimbu', '🍋'],
  ['grape|angoor', '🍇'], ['watermelon|melon|tarbooz', '🍉'], ['pineapple|ananas', '🍍'], ['strawberr', '🍓'], ['papaya|guava|pomegranate|anar|kiwi|pear|peach|plum|fruit', '🍑'],
  ['coconut|nariyal', '🥥'], ['dates|raisin|almond|cashew|walnut|pistachio|nuts|badam|kaju|dry fruit', '🥜'],
  // vegetables
  ['tomato|tamatar', '🍅'], ['onion|pyaz|pyaaz', '🧅'], ['potato|aloo|batata', '🥔'], ['carrot|gajar', '🥕'], ['garlic|lehsun|ginger|adrak', '🧄'],
  ['chilli|chili|mirch|capsicum|pepper', '🌶️'], ['cucumber|kheera|zucchini', '🥒'], ['brinjal|eggplant|baingan', '🍆'], ['corn|bhutta|maize', '🌽'],
  ['cauliflower|broccoli|gobi|cabbage', '🥦'], ['spinach|palak|coriander|dhania|mint|pudina|lettuce|methi|greens|leafy|curry leaves', '🥬'], ['mushroom', '🍄'],
  ['vegetable|veggies|sabzi|sabji', '🥗'],
  // meat and fish
  ['chicken|murgh', '🍗'], ['mutton|lamb|beef|pork|meat|keema|bacon|sausage|ham', '🥩'], ['fish|prawn|shrimp|crab|salmon|tuna|seafood', '🐟'],
  // drinks
  ['tea|chai', '🍵'], ['coffee|nescafe', '☕'], ['juice|squash|sharbat', '🧃'], ['water|bisleri|soda', '💧'], ['cola|pepsi|coke|sprite|fanta|drink|beverage|energy', '🥤'],
  ['beer|wine|whisky|whiskey|vodka|rum|liquor|alcohol', '🍺'],
  // pantry
  ['sugar|jaggery|gur|honey|shakkar', '🍯'], ['salt|namak', '🧂'], ['oil|mustard oil|olive', '🫒'], ['masala|spice|turmeric|haldi|jeera|cumin|cardamom|elaichi|clove|cinnamon|pepper powder', '🌶️'],
  ['sauce|ketchup|jam|pickle|achar|mayonnaise|mayo|vinegar|spread|peanut butter', '🥫'],
  // snacks and sweets
  ['biscuit|cookie|cracker|parle', '🍪'], ['chips|namkeen|snack|popcorn|bhujia|nachos|kurkure', '🍟'], ['chocolate|candy|toffee|sweet|mithai|dessert|laddu|ladoo', '🍫'],
  ['pizza|burger|sandwich|biryani|food|lunch|dinner|breakfast|snacks', '🍔'],
  // household
  ['soap|handwash|hand wash|body wash|sanitizer|sanitiser', '🧼'], ['shampoo|conditioner|lotion|moisturi[sz]er|cream|face wash|sunscreen|oil hair|deodorant|deo|perfume|serum', '🧴'],
  ['toothpaste|toothbrush|mouthwash|floss', '🪥'], ['tissue|toilet|napkin|paper towel|wipes|diaper|pad|sanitary', '🧻'],
  ['detergent|surf|ariel|vim|dish|cleaner|phenyl|harpic|lizol|bleach|floor|mop|broom|brush|sponge|scrub|duster|wipe', '🧹'],
  ['garbage|trash|dustbin|bin bag|polythene|carry bag|bag', '🗑️'], ['bulb|light|lamp|battery|cell|charger|cable|extension|plug|switch|fan', '💡'],
  ['gas|cylinder|lighter|matchbox|candle|agarbatti|incense|diya', '🕯️'], ['foil|wrap|container|box|bottle|tiffin|lunchbox|flask', '🥡'],
  // health, baby, pets
  ['medicine|tablet|capsule|syrup|paracetamol|crocin|dolo|vitamin|ointment|balm|bandage|cotton|thermometer|mask|band-aid|bandaid|first aid', '💊'],
  ['baby|diaper|pampers|formula|cerelac|wipes baby', '👶'], ['dog|puppy|cat food|kitten|pet|pedigree', '🐕'],
  // clothes, school, gifts
  ['shirt|tshirt|t-shirt|jeans|trouser|pant|kurta|saree|sari|dress|jacket|sweater|socks|inner|underwear|clothes|dupatta|lehenga', '👕'], ['shoe|sandal|slipper|chappal|sneaker|boot', '👟'],
  ['pen|pencil|notebook|copy|book|register|eraser|sharpener|stationery|marker|glue|file|folder|paper|chart', '✏️'], ['bag pack|backpack|school bag', '🎒'],
  ['gift|present|hamper|wrapping|card', '🎁'], ['flower|bouquet|garland|rose|marigold', '💐'], ['balloon|decoration|party|rangoli|firecracker|crackers', '🎉'],
  ['phone|mobile|laptop|earphone|headphone|charger|tv|speaker', '📱'], ['toy|game|lego|puzzle|doll|ball', '🧸'],
];

const ITEM_RULES = ITEM_ICONS.map(([words, icon]) => ({ re: new RegExp(`\\b(?:${words})(?:s|es)?\\b`, 'i'), icon }));

export const DEFAULT_ITEM_ICON = '🛍️';

export function itemIcon(text: string): string {
  const t = (text || '').trim();
  if (!t) return DEFAULT_ITEM_ICON;
  return ITEM_RULES.find((r) => r.re.test(t))?.icon || DEFAULT_ITEM_ICON;
}

// A list's icon: the words in its name first ("Diwali shopping" -> a lamp), then the icon of its category.
const LIST_ICONS: [string, string][] = [
  ['diwali|deepavali|festival|puja|pooja', '🪔'], ['holi|eid|christmas|new year|navratri|ganesh|raksha|rakhi', '🎉'],
  ['birthday|party|anniversary|wedding|shaadi|function|celebration', '🎂'], ['grocer|kirana|sabzi|vegetable|fruit|ration|monthly|weekly|supermarket|mart', '🛒'],
  ['medicine|pharmacy|chemist|health|medical', '💊'], ['baby|kids|child|school|stationery|books', '🎒'], ['trip|travel|vacation|holiday|picnic|camping|packing|goa|flight', '🧳'],
  ['clothes|clothing|apparel|shoes|fashion|wardrobe', '👕'], ['home|house|kitchen|household|cleaning|furniture|decor|hardware|diy|repair', '🏠'],
  ['gift|present', '🎁'], ['electronics|gadget|phone|laptop|tech', '📱'], ['pet|dog|cat', '🐕'], ['bbq|barbecue|dinner|lunch|restaurant|takeaway', '🍽️'],
  ['garden|plant|flower|nursery', '🌱'], ['office|work|desk', '💼'], ['gym|fitness|sports', '🏋️'],
];
const LIST_RULES = LIST_ICONS.map(([words, icon]) => ({ re: new RegExp(`\\b(?:${words})`, 'i'), icon }));

export function listIconGuess(name: string): string | null {
  const t = (name || '').trim();
  if (!t) return null;
  return LIST_RULES.find((r) => r.re.test(t))?.icon || null;
}

// Hand-pick choices for a list's own icon, for when none of the guesses fit
export const LIST_EMOJI_CHOICES = [
  '🛒', '🧺', '🥕', '🍎', '🥛', '🍞', '🍗', '🍽️', '☕', '🎂', '🎉', '🪔',
  '💊', '🧴', '🧹', '🏠', '👕', '👟', '🎁', '🧸', '🎒', '✏️', '📱', '💡',
  '🧳', '🏖️', '🐕', '🌱', '🔧', '💼', '🏋️', '⭐',
];
