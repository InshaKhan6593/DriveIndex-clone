// Shared automobilia gate — extracted from mecum-adapt.js so the Barrett-Jackson adapter
// can use the same, test-hardened pattern instead of forking it.
//
// ⚠️ Every pattern here was checked against REAL CAR NAMES it would destroy:
//   bare "neon"   -> Plymouth Neon          bare "model"  -> Ford Model T / Model A
//   bare "manual" -> "5-Speed Manual"       sign (no \b)  -> AMG "Designo"
//   "print\b"     -> "Sprint" trims         bare "kit"    -> kit-car replicas (review's job)
// Hence "sign\b", "model\s+(kit|by)", "owner's manual", no bare neon/kit.
// Tested by crawler/mecum-automobilia.test.js — objects caught, cars survive.
"use strict";

const AUTOMOBILIA_RE =
  /\b(?:signs?\b|billboard|poster|banner\b|pedestal|display\b|diorama|scale\s+(?:tether\s+)?car|tether\s+car|slot\s+car|pedal\s+car|ride-on|models?\s+(?:kit|by)\b|scale\s+model|toys?\b|badges?\b|pins?\b|buttons?\b|medal|trophy|helmet|jackets?\b|shirt|hats?\b|caps?\b|globe\b|gas\s+pump|lubester|oil\s+bottle|bottles?\b|crate\b|(?:owner'?s?|shop|service)\s+manual|brochure|booklet|literature|\bprint\b|lithograph|painting|artwork|photograph|toolbox|tool\s+kit|tools?\b|jacks?\b|vise\b|anvil|grease\s+gun|spark\s+plug|engine\s+stand|gas\s+can|oil\s+can|grenade|granade|whiskey|decanter|hydroplane\s+model|mailbox|phones?\b|radios?\b|clocks?\b|thermometer|syrup|soda\s+machine|cooler\b|cabinet|chests?\b|trunk\s+lid|keychain|license\s+plates?\b|assortment|collection\s+of|lot\s+of|autographed|signed\s+shadowbox|shadowbox|stadium\s+seats?|kiddie\s+ride|coin\s+operated|rocking\s+boat)\b/i;

module.exports = { AUTOMOBILIA_RE };
