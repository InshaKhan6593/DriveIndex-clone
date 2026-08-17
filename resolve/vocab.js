// Vocabulary tables for entity resolution.
//
// ANSWER TO "mapping tables or regex — what does DriveIndex do?": ground truth §7 measured
// their catalogue and the answer is essentially NEITHER. They normalise the sale title and
// the resulting string BECOMES the model. The evidence is conclusive — 5/5 indicators:
//   • 2.73 avg words per model name (a curated taxonomy is 1-2)
//   • body style sits inside the model name 29% of the time (2,130 of 7,240)
//   • 163 near-duplicate model pairs within the same make
//   • `generation` populated on 6 of 7,240 rows
//   • 373 model names contain marketing words
// Their own catalogue contains "R8 V10 Performance Coupe Quattro" AND "R8 V10 Performance
// Quattro Coupe" as SEPARATE models with SEPARATE price histories. Same car, different word
// order. No human curated that, and no regex normalised it.
//
// So: they use a mapping table only for MAKE (§3's source registry is a mapping table, and
// their make list is curated — "Mercedes-AMG" and "Mercedes-Benz" are deliberately distinct).
// Everything after the make is raw derived string.
//
// WHAT WE DO INSTEAD (ground truth §7's own recommendation, which it reports as tested at
// "12 correct merges, zero wrong merges"): derive from the title the same way — so we
// inherit the zero-maintenance property — but additionally (a) pull body style into its own
// column, (b) sort the remaining tokens so word-order variants collapse, and (c) keep a
// variant allowlist so GT3 RS can never merge into GT3.
//
// These tables are small and additive. A make we've never seen doesn't break the pipeline;
// it just doesn't get canonicalised (see MAKE_ALIASES usage in resolve-car-v2.js).

// Multi-word makes must be tried before single-word ones (longest-prefix match).
const MAKE_ALIASES = new Map(Object.entries({
  "mercedes-benz": "Mercedes-Benz", "mercedes benz": "Mercedes-Benz", "mercedes": "Mercedes-Benz",
  "mercedes-amg": "Mercedes-AMG", "mercedes amg": "Mercedes-AMG",
  "mercedes-maybach": "Mercedes-Maybach",
  "aston martin": "Aston Martin", "astonmartin": "Aston Martin",
  "land rover": "Land Rover", "range rover": "Land Rover",
  "rolls-royce": "Rolls-Royce", "rolls royce": "Rolls-Royce",
  "alfa romeo": "Alfa Romeo",
  "de tomaso": "De Tomaso", "detomaso": "De Tomaso",
  "shelby mustang": "Shelby",
  "porsche": "Porsche", "ferrari": "Ferrari", "lamborghini": "Lamborghini", "mclaren": "McLaren",
  "bugatti": "Bugatti", "pagani": "Pagani", "koenigsegg": "Koenigsegg", "maserati": "Maserati",
  "bentley": "Bentley", "lotus": "Lotus", "jaguar": "Jaguar", "bmw": "BMW", "audi": "Audi",
  "volkswagen": "Volkswagen", "vw": "Volkswagen", "chevrolet": "Chevrolet", "chevy": "Chevrolet",
  "ford": "Ford", "dodge": "Dodge", "cadillac": "Cadillac", "buick": "Buick", "pontiac": "Pontiac",
  "oldsmobile": "Oldsmobile", "chrysler": "Chrysler", "jeep": "Jeep", "gmc": "GMC",
  "lincoln": "Lincoln", "toyota": "Toyota", "lexus": "Lexus", "honda": "Honda", "acura": "Acura",
  "nissan": "Nissan", "datsun": "Datsun", "infiniti": "Infiniti", "mazda": "Mazda",
  "mazdaspeed": "Mazdaspeed", "subaru": "Subaru", "mitsubishi": "Mitsubishi", "mini": "MINI",
  "fiat": "Fiat", "lancia": "Lancia", "cord": "Cord", "packard": "Packard",
  "studebaker": "Studebaker", "duesenberg": "Duesenberg", "hudson": "Hudson",
  "plymouth": "Plymouth", "amc": "AMC", "shelby": "Shelby", "iso": "Iso", "tvr": "TVR",
  "morgan": "Morgan", "triumph": "Triumph", "mg": "MG", "austin": "Austin",
  "austin-healey": "Austin-Healey", "healey": "Austin-Healey", "rover": "Rover",
  "saab": "Saab", "volvo": "Volvo", "peugeot": "Peugeot", "renault": "Renault", "citroen": "Citroën",
  "hummer": "Hummer", "saleen": "Saleen", "ruf": "RUF", "alpina": "Alpina", "abarth": "Abarth",
  "tesla": "Tesla", "rivian": "Rivian", "lucid": "Lucid", "polestar": "Polestar",
  "genesis": "Genesis", "hyundai": "Hyundai", "kia": "Kia", "suzuki": "Suzuki",
  "isuzu": "Isuzu", "scion": "Scion", "eagle": "Eagle", "merkur": "Merkur", "delorean": "DeLorean",
  "willys": "Willys", "international": "International", "autocar": "Autocar",
  // added from a census of makes actually observed in scraped auction-source data
  "international harvester": "International", "amphicar": "Amphicar",
  "bizzarrini": "Bizzarrini", "panoz": "Panoz", "noble": "Noble", "jensen": "Jensen",
  "maybach": "Maybach", "mercury": "Mercury", "excalibur": "Excalibur", "cizeta": "Cizeta",
  "vector": "Vector", "spyker": "Spyker", "wiesmann": "Wiesmann", "gumpert": "Gumpert",
  "rimac": "Rimac", "lucid": "Lucid", "polestar": "Polestar", "saleen": "Saleen",
  "hennessey": "Hennessey", "ruf": "RUF", "alpina": "Alpina", "radical": "Radical",
  "ac": "AC", "allard": "Allard", "bristol": "Bristol", "facel": "Facel Vega",
  "lagonda": "Lagonda", "pierce-arrow": "Pierce-Arrow", "auburn": "Auburn",
  "stutz": "Stutz", "franklin": "Franklin", "nash": "Nash", "desoto": "DeSoto",
  "edsel": "Edsel", "checker": "Checker", "crosley": "Crosley", "kaiser": "Kaiser",
  "tucker": "Tucker", "vauxhall": "Vauxhall", "opel": "Opel", "simca": "Simca",
  "borgward": "Borgward", "nsu": "NSU", "dkw": "DKW", "tatra": "Tatra", "skoda": "Škoda",
  "seat": "SEAT", "dacia": "Dacia", "lada": "Lada", "trabant": "Trabant",
  // added after a real review-queue item turned out to be a genuine car the table lacked
  // (1967 Reliant Regal 3/25). Everything else in that queue was correctly rejected.
  "reliant": "Reliant", "riley": "Riley", "wolseley": "Wolseley", "sunbeam": "Sunbeam",
  "hillman": "Hillman", "humber": "Humber", "singer motors": "Singer Motors",
  "daimler": "Daimler", "alvis": "Alvis", "armstrong siddeley": "Armstrong Siddeley",
  "matra": "Matra", "panhard": "Panhard", "delahaye": "Delahaye", "delage": "Delage",
  "hotchkiss": "Hotchkiss", "talbot": "Talbot", "bugeye": "Austin-Healey",
  "goggomobil": "Goggomobil", "messerschmitt": "Messerschmitt", "isetta": "BMW",
  "autobianchi": "Autobianchi", "innocenti": "Innocenti", "de-lorean": "DeLorean",
  // modern/EV marques — added after "2023 Fisker Ocean" hit the review queue from Cars & Bids.
  // Newer makes appear in auction data as soon as early cars start changing hands, so this
  // list needs a periodic top-up; the review queue is what surfaces the gap.
  "fisker": "Fisker", "karma": "Karma", "vinfast": "VinFast", "byd": "BYD",
  "nio": "NIO", "xpeng": "XPeng", "faraday": "Faraday Future", "bollinger": "Bollinger",
  "hennessey": "Hennessey", "czinger": "Czinger", "drako": "Drako", "aspark": "Aspark",
  "pininfarina": "Pininfarina", "automobili pininfarina": "Pininfarina",
  "gordon murray": "Gordon Murray", "de tomaso automobili": "De Tomaso",
  "ineos": "INEOS", "cupra": "Cupra", "genesis": "Genesis",
  // Legitimate car marques surfaced by the review queue at volume. This is completing a
  // reference table, not memorising edge cases — each is a real manufacturer of road cars,
  // and the evidence layer (resolve/evidence.js) still governs anything NOT listed here.
  "ariel": "Ariel", "daihatsu": "Daihatsu", "rambler": "Rambler", "bricklin": "Bricklin",
  "bac": "BAC", "saturn": "Saturn", "ram": "RAM", "moke": "Moke", "metropolitan": "Metropolitan",
  "sterling": "Sterling", "geo": "Geo", "yugo": "Yugo", "daewoo": "Daewoo",
  "asuna": "Asuna", "passport": "Passport", "avanti": "Avanti", "clenet": "Clenet",
  "zimmer": "Zimmer", "qvale": "Qvale", "mosler": "Mosler", "callaway": "Callaway",
  "lister": "Lister", "ginetta": "Ginetta", "caterham": "Caterham", "westfield": "Westfield",
  "donkervoort": "Donkervoort", "artega": "Artega", "melkus": "Melkus",
  // Two marques notes/SOURCE-ONBOARDING.md §4 already confirmed by web research ("Real car
  // marque", with sourcing) but never actually landed here — the research and the code had
  // drifted apart. Fixed while clearing the review queue at volume (2026-08-17).
  "lasalle": "LaSalle", "steyr-puch": "Steyr-Puch", "steyr": "Steyr-Puch",
  // Confirmed real historic/production car marques, found while clearing the review queue at
  // volume — each verified against automotive-history references, not guessed. Pre-war American
  // and European marques dominate because that era has the thinnest curated coverage; the
  // evidence layer still governs anything not listed here.
  "mercer": "Mercer", "hispano-suiza": "Hispano-Suiza", "amilcar": "Amilcar",
  "delaunay-belleville": "Delaunay-Belleville", "lorraine-dietrich": "Lorraine-Dietrich",
  "dual-ghia": "Dual-Ghia", "mitsuoka": "Mitsuoka", "rossion": "Rossion",
  "stevens-duryea": "Stevens-Duryea", "osca": "OSCA", "horch": "Horch", "minerva": "Minerva",
  "cisitalia": "Cisitalia", "veritas": "Veritas", "gaz": "GAZ", "uaz": "UAZ", "zaz": "ZAZ",
  "zil": "ZIL", "luaz": "LuAZ", "wanderer": "Wanderer", "glas": "Glas", "winton": "Winton",
  "kissel": "Kissel", "peerless": "Peerless", "essex": "Essex", "oakland": "Oakland",
  "terraplane": "Terraplane", "erskine": "Erskine", "frazer": "Frazer", "paige": "Paige",
  "simplex": "Simplex", "cole": "Cole", "doble": "Doble", "overland": "Overland",
  "baker": "Baker Electric", "milburn": "Milburn", "rauch & lang": "Rauch & Lang",
  "scripps-booth": "Scripps-Booth", "wills sainte claire": "Wills Sainte Claire",
  "marquette": "Marquette", "lexington": "Lexington", "flanders": "Flanders", "reo": "Reo",
  "jowett": "Jowett", "swallow": "Swallow Doretti", "gilbern": "Gilbern", "bitter": "Bitter",
  "salmson": "Salmson", "bedelia": "Bedelia", "rosengart": "Rosengart", "tracta": "Tracta",
  "sizaire-naudin": "Sizaire-Naudin", "pegaso": "Pegaso", "eunos": "Eunos", "emw": "EMW",
  "berkeley": "Berkeley", "chalmers": "Chalmers", "cartercar": "Cartercar", "whippet": "Whippet",
  "rickenbacker": "Rickenbacker", "richard-brasier": "Richard-Brasier",
  "stoddard-dayton": "Stoddard-Dayton", "moretti": "Moretti", "tempo": "Tempo",
  "rene bonnet": "René Bonnet", "serenissima": "Serenissima", "napier": "Napier",
  "railton": "Railton", "squire": "Squire", "mitchell": "Mitchell",
  // Found by comparing our make list against DriveIndex's live filter dropdown (2026-08-17).
  // "am general" specifically fixes a real split: the single-token inference rule was taking
  // "AM" alone as the make and leaving "General M998" in the model, for every AM General
  // military-surplus vehicle in the corpus (measured: 13,000+ affected rows).
  "am general": "AM General", "autokraft": "Autokraft",
}));

// Body style -> its own column, never left inside the model string. Ground truth §7 measured
// 29% of their model names polluted with these; removing them is where most of the
// safe merges come from.
const BODY_STYLES = new Map(Object.entries({
  "coupe": "Coupe", "coupé": "Coupe", "berlinetta": "Coupe", "fastback": "Coupe",
  "hardtop": "Coupe", "notchback": "Coupe", "liftback": "Coupe",
  "cabriolet": "Convertible", "convertible": "Convertible", "roadster": "Convertible",
  "spyder": "Convertible", "spider": "Convertible", "barchetta": "Convertible",
  "drophead": "Convertible", "cabrio": "Convertible", "speedster": "Convertible",
  "targa": "Targa",
  "sedan": "Sedan", "saloon": "Sedan", "berlina": "Sedan", "limousine": "Sedan",
  "wagon": "Wagon", "avant": "Wagon", "estate": "Wagon", "touring": "Wagon",
  "shooting-brake": "Wagon", "sportwagon": "Wagon", "kombi": "Wagon",
  "suv": "SUV", "crossover": "SUV",
  "hatchback": "Hatchback", "hatch": "Hatchback",
  "pickup": "Pickup", "truck": "Pickup",
  "van": "Van", "minivan": "Van",
}));

// ⚠️ Body words that are ALSO real model/variant names. If one of these is the only thing
// left after stripping, it is the MODEL, not the body style — never strip it to empty.
// "911 Targa" -> model 911, body Targa. But Porsche "Speedster" and "911 R" are models.
const BODY_WORDS_ALSO_MODELS = new Set(["speedster", "targa", "touring", "roadster", "spyder"]);

// Tokens that MUST survive into the model core. This is the guard that stops "GT3 RS"
// collapsing into "GT3" — the exact failure ground truth §4.5 warns about, where one
// mis-filed higher-spec car drags an entire model-year's value up and can flip its signal.
const VARIANT_TOKENS = new Set([
  "rs","gt","gt1","gt2","gt3","gt4","gts","gtb","gtc","gte","gtr","gt-r","gtd","gto","gtv",
  "s","t","r","sv","svj","svr","sto","tr","cs","csl","rsr","srt","ss","z06","zr1","zl1","z28",
  "turbo","supercharged","hybrid","e-hybrid","plug-in",
  "4s","2s","4","2","c4","c2","carrera","targa","speedster","clubsport","cup",
  "amg","m3","m4","m5","m2","m6","c63","e63","c43","s63","g63",
  "quadrifoglio","competizione","performante","tecnica","superfast","pista","speciale",
  "scuderia","stradale","lusso","america","lightweight","weissach","touring",
  "denim","heritage","nismo","type-r","typer","sti","wrx","evo","evolution",
  "lp640","lp670","lp700","lp750","lp770","lp610","lp580","vt","gt350","gt500","kr","boss",
  "shelby","cobra","mach","raptor","demon","hellcat","redeye","widebody","scat","jailbreak",
  "black","series","first","edition","final","anniversary","exclusive","tailor","made",
  "n","x51","x50","aerokit","phase","stage","i","ii","iii","iv",
]);

// Prefix noise: descriptive lead-ins BaT and others put before the year. All are removed
// before parsing. Every one of these was observed in real scraped titles.
const NOISE_PREFIX_PATTERNS = [
  /^[\d,.]+\s*k?-?\s*(mile|miles|kilometer|kilometers|km)\b[-\s]*/i,  // "28k-Mile", "1,500-Mile", "298-Mile"
  /^\d+[-\s]?(year|years)[-\s]?(owned|ownership)\b[-\s]*/i,            // "34-Years-Owned"
  /^(one|single|two|three|original|first)[-\s](owner|family)[-\s]?(owned)?\b[-\s]*/i,
  /^(row|euro|european|jdm|usa|us|uk|japanese-market|german-market|canadian)\b[-\s]+/i,
  /^ca\.?\s*/i,                                                        // "ca.1945"
  /^(no[-\s]reserve|nr)\b[-\s]*/i,
];

// Modification markers -> these must NOT silently merge into the stock model's price curve.
// A Singer 911 sells for multiples of a stock 911 of the same year; an RWB-widebody or an
// LS-swap is a different asset. Kept as its own model variant rather than queued, so the
// pipeline stays automatic — but never merged with stock.
const MODIFICATION_MARKERS = [
  { re: /\bby singer\b|\bsinger[-\s]built\b/i, tag: "Singer" },
  { re: /\brwb\b|\brauh[-\s]?welt\b/i, tag: "RWB" },
  { re: /\brestomod\b|\breimagined\b/i, tag: "Restomod" },
  { re: /\b(ls\d?|coyote|hemi|2jz|k-series)[-\s]swap(ped)?\b/i, tag: "EngineSwap" },
  { re: /\b(swap|swapped)\b/i, tag: "EngineSwap" },
  { re: /\bre-?creation\b|\breplica\b|\btribute\b|\bcontinuation\b|\bhomage\b/i, tag: "Replica" },
  { re: /\bwidebody[-\s]converted\b|\brwd[-\s]converted\b|\bconverted\b/i, tag: "Converted" },
  { re: /\b(paxton|whipple|procharger)[-\s]?supercharged\b/i, tag: "Supercharged" },
  { re: /\bhot[-\s]rod\b|\brat[-\s]rod\b|\bcustom[-\s]built\b/i, tag: "HotRod" },
  { re: /\brace[-\s]car\b|\bracing[-\s]single-seater\b|\bformula\b/i, tag: "RaceCar" },
];

// Genuinely out of scope for a CAR price index. These go to human review — the only cases
// that should.
const OUT_OF_SCOPE = [
  { re: /\b(medium\s+)?tank\b|\barmou?red\s+(car|vehicle)\b|\bhalf-?track\b/i, reason: "military vehicle, not a car" },
  { re: /\b(motorcycle|motorbike|scooter|moped)\b/i, reason: "motorcycle, out of scope" },
  { re: /\b(wheels?|seats?|engine|gearbox|transmission|helmet|sign|poster|memorabilia|literature|toolkit|watch|clock|gas\s+pump|pedal\s+car|go-?kart)\s+(for|from)\b/i, reason: "part or automobilia, not a vehicle" },
  { re: /^(recaro|bbs|momo|fuchs|oz)\b/i, reason: "parts listing" },
  { re: /\bjunior\s+car\b|\bchildren'?s\b|\bpedal\s+car\b/i, reason: "junior/pedal car, not a road vehicle" },
  { re: /\btractor\b|\bbulldozer\b|\bforklift\b/i, reason: "industrial vehicle, out of scope" },
  { re: /\bboat\b|\baircraft\b|\bairplane\b|\bhelicopter\b/i, reason: "not a car" },
  // observed in real BaT results: outboard motors, motorcycles branded like car makes
  { re: /\bevinrude\b|\bjohnson\b\s+\d+hp|\boutboard\b/i, reason: "marine engine, not a car" },
  { re: /\bamb\s*001\b|\bbrough\s+superior\b/i, reason: "motorcycle (Aston Martin AMB 001)" },
  { re: /\bsingle-?seater\b|\bindy\s*car\b/i, reason: "open-wheel race car, no consumer model" },
  // ⚠️ "Formula" alone is not safe: Pontiac Firebird "Formula" and Plymouth Barracuda
  // "Formula S" are real factory TRIMS, not open-wheel racing classes. Found by measuring real
  // rejections: 49 genuine Firebirds/Barracudas ("1997 Pontiac Firebird Formula WS6", "1966
  // Plymouth Barracuda Formula S") were being discarded. Excluded by nameplate, and the racing
  // class itself is now an explicit allowlist rather than "formula + any word".
  {
    re: {
      test: (t) => !/\b(firebird|barracuda)\b/i.test(t) &&
        /\bformula\s+(ford|vee|super\s*vee|junior|atlantic|renault|libre|continental|mazda|palmer|b|c|1|2|3|4|5000)\b/i.test(t),
    },
    reason: "open-wheel race car, no consumer model",
  },
  // ⚠️ Bare "quad" is not safe either: "Quad Webers" / "Dual Quad" are four-barrel-carburetor
  // setups, "Quad 4" is a real Oldsmobile engine, "quad cab" is a real truck body style — all
  // common in perfectly normal car titles. Only the actual ATV synonym "quad bike" is unambiguous.
  { re: /\bgo-?kart\b|\bquad\s*bike\b|\batv\b|\bsnowmobile\b|\bgolf\s+cart\b/i, reason: "not a road car" },
];

// Known motorcycle marques — a title like "1916 Indian Model O" has no other tell.
// Marques that ONLY ever made motorcycles — safe to reject on the make alone.
// ⚠️ Deliberately excludes Honda, Suzuki and BMW: all three build cars AND motorcycles, so
// rejecting them by make would throw away real cars. Those have to be caught by MODEL
// instead (see MOTORCYCLE_MODEL_PATTERNS).
const MOTORCYCLE_MAKES = new Set([
  "indian","harley-davidson","harley","ducati","triumph motorcycles","moto guzzi","bsa",
  "norton","vincent","brough","brough superior","husqvarna","ktm","aprilia","mv agusta",
  // added after "2000 Yamaha V Star" reached the review queue from Mecum
  "yamaha","kawasaki","victory motorcycles","buell","royal enfield","benelli","bimota",
  "zero motorcycles","cushman","whizzer","ariel motorcycles","matchless","velocette",
  // Confirmed real motorcycle/moped-only marques, found while clearing the review queue at
  // volume (2026-08-17) — each builds/built motorcycles or mopeds exclusively, never cars.
  "motobecane","velosolex","rokon","greeves","zundapp","derbi","maico","italjet","mz","ossa",
  "fantic","cz","cimatti","malaguti","motobi","bridgestone","sondors","rumi",
  "aermacchi","parilla","penton","simson","terrot","motus",
]);

// For makes that build BOTH cars and motorcycles, match the model instead of the make.
const MOTORCYCLE_MODEL_PATTERNS = [
  // Honda. GB500 added 2026-08-17: found via a real corpus false positive — "Honda GB500
  // Tourist Trophy" (a real motorcycle, named for the Isle of Man TT) was accidentally being
  // excluded by the racing-memorabilia title pattern instead of being recognised as a
  // motorcycle, which is the semantically correct reason. 40+ real instances in the corpus.
  /\bgold ?wing\b|\bcbr\d|\bcb\d{3}\b|\bshadow\s+(aero|spirit|phantom)\b|\bvfr\b|\bafrica twin\b|\bgb500\b/i,
  /\bhayabusa\b|\bgsx-?r\b|\bboulevard\b|\bv-?strom\b|\bintruder\b/i,                                // Suzuki
  /\br\s?nine\s?t\b|\bgs\s?12\d{2}\b|\bk\s?16\d{2}\b|\bs\s?1000\s?rr\b/i,                            // BMW Motorrad
  /\bv[- ]?star\b|\bvmax\b|\bfz\d|\byzf\b|\bvirago\b/i,                                              // Yamaha (belt-and-braces)
];

// Generation codes worth capturing into their own column. Ground truth §7 measured these as
// populated on 6 of 7,240 of DriveIndex's rows — effectively unused. They ARE price-relevant
// (a 991 GT3 is not a 996 GT3), so we extract them when a title volunteers one.
//
// ⚠️ EXPLICIT ALLOWLIST, NOT A NUMERIC RANGE. The first version of this used /\b9[0-9]{2}\b/
// to catch Porsche codes, which also matched 911 — the MODEL — and stripped it out of every
// Porsche title. "1994 Porsche 911 Turbo 3.6" came out as model "3.6 turbo", generation 911,
// i.e. the single most important token in the catalogue was being deleted. Model numbers and
// generation codes overlap numerically and can only be separated by enumeration.
const GENERATION_CODES = new Set([
  // Porsche 911 generations (911/912/914/918/924/928/944/959/962/968 are MODELS, not gens)
  "930", "964", "993", "996", "997", "991", "992", "901",
  // Porsche Boxster/Cayman
  "986", "987", "981", "982",
  // BMW chassis
  "E21","E24","E28","E30","E31","E34","E36","E38","E39","E46","E60","E63","E82","E85","E89","E90","E92","E93",
  "F10","F12","F13","F22","F30","F32","F80","F82","F83","F87","G01","G05","G20","G29","G42","G80","G82","G87",
  // Mercedes
  "W113","W116","W123","W124","W126","W140","W198","W201","W202","W203","W204","W211","W212","R107","R129","R170","R230","C107","C126",
  // Mazda Miata
  "NA","NB","NC","ND",
  // Audi
  "B5","B6","B7","B8","B9","C4","C5","C6","C7","D2","D3",
  // Nissan Skyline/GT-R
  "R32","R33","R34","R35",
  // Land Rover / misc
  "P38",
]);

// Mk-style generations are a pattern, not an enumerable set.
const GENERATION_PATTERNS = [
  /^(MK\s?[IVX]+|MK\s?\d)$/i,
];

module.exports = {
  MAKE_ALIASES, BODY_STYLES, BODY_WORDS_ALSO_MODELS, VARIANT_TOKENS,
  NOISE_PREFIX_PATTERNS, MODIFICATION_MARKERS, OUT_OF_SCOPE, MOTORCYCLE_MAKES,
  GENERATION_PATTERNS, GENERATION_CODES, MOTORCYCLE_MODEL_PATTERNS,
};
