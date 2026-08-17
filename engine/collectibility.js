// [V] VERIFIED — ground truth §4.6, lists and curated override table reproduced verbatim.
//
// Matching is UPPERCASE SUBSTRING (`f.includes(e)` where f is the uppercased model name),
// and the four tier lists are checked in strict else-if order: grail -> track -> perf -> mass.
// That order is load-bearing: "NISMO" appears in BOTH the track list and the perf list, so
// it must score +3, not +2. Likewise "GT R" (track) vs "GT3"/"GTS" (perf).
//
// CORRECTION LOG: the previous version of this file used lowercase lists with a partial
// transcription, and carried only 7 of the ~100 curated-override entries. Both are fixed
// here against the verbatim extraction.

// +4 — Ultra-rare limited production
const GRAIL = ["ENZO","F40","F50","LAFERRARI","CLK GTR","SLR MCLAREN","CARRERA GT","918 SPYDER",
  "P1","SENNA","SPEEDTAIL","AMG ONE","VEYRON","CHIRON","ZONDA","HUAYRA","CENTENARIO",
  "VENENO","REVENTON","MIURA","COUNTACH","GT40","FORD GT","VALKYRIE",
  "812 COMPETIZIONE","288 GTO","250 GTO","959","2000GT","SLS AMG"];

// +3 — Very limited / track-focused
const TRACK = ["GT2 RS","GT3 RS","GT4 RS","BLACK SERIES","CSL","Z06","ZR1","GT350R","GT500",
  "SPORT CLASSIC","PERFORMANTE","SVJ","STO","SCUDERIA","PISTA","SPECIALE",
  "CHALLENGE STRADALE","600LT","765LT","GT3 TOURING","SPEEDSTER","GT2","MURCIELAGO",
  "AVENTADOR","DIABLO","AMG GT R","GT R","DEMON","ACR","NISMO","HEMI CUDA"];

// +2 — Desirable performance model
const PERF = ["GT3","GT4","GTS","TURBO S","M3","M4","M5","M2","C63","E63","AMG GT","RS3","RS4",
  "RS5","RS6","RS7","TYPE R","STI","NISMO","NSX","SUPRA","SKYLINE","RX-7","LFA",
  "VANTAGE","DB11","DBS","CONTINENTAL GT","WRAITH","720S","570S","488","F8","SF90","812"];

// -2 — Mass-production model
const MASS = ["CAYENNE","MACAN","PANAMERA","URUS","LEVANTE","GHIBLI","X3","X5","Q5","Q7","GLE",
  "GLC","RANGE ROVER SPORT","F-PACE","FLYING SPUR","CULLINAN","BENTAYGA"];

const COLLECTOR_BRANDS = ["Ferrari","Porsche","Lamborghini","Bugatti","Pagani","Koenigsegg","McLaren","Aston Martin"];
const DEPRECIATING_BRANDS = ["Maserati","Jaguar","Land Rover"];

// [V] Curated override table — longest matching key wins and DISCARDS the computed score.
const CURATED_OVERRIDES = {
  "918 SPYDER":10,"LAFERRARI":10,"P1":10,"F40":10,"F50":10,"ENZO":10,"CARRERA GT":10,
  "SLR MCLAREN":10,"CLK GTR":10,"VEYRON":10,"CHIRON":10,"ZONDA":10,"HUAYRA":10,"CENTENARIO":10,
  "VENENO":10,"REVENTON":10,"MIURA":10,"COUNTACH":10,"GT40":10,"AMG ONE":10,"SENNA":10,"SPEEDTAIL":10,
  "VALKYRIE":10,"812 COMPETIZIONE":10,"288 GTO":10,"250 GTO":10,"FORD GT":10,"2000GT":10,
  "959":10,"SLS AMG":9,"SLS AMG BLACK SERIES":10,"SLS AMG GT FINAL EDITION":9,"GT2 RS":9,
  "GT3 RS":9,"GT4 RS":9,"CAYMAN GT4 RS":9,"488 PISTA":9,"458 SPECIALE":9,"430 SCUDERIA":9,
  "CHALLENGE STRADALE":9,"SF90 STRADALE":9,"SF90 SPIDER":9,"F8 TRIBUTO":9,"F8 SPIDER":9,
  "HURACAN STO":9,"HURACAN PERFORMANTE":9,"AVENTADOR SVJ":9,"765LT":9,"600LT":9,"720S":9,
  "AMG GT BLACK SERIES":9,"AMG GT R":9,"GT BLACK SERIES":9,"GT R":9,"CORVETTE ZR1":9,
  "CORVETTE Z06":9,"CHALLENGER SRT DEMON":9,"CHALLENGER SRT DEMON 170":9,"VIPER ACR":9,
  "GT-R NISMO":9,"M3 CSL":9,"M4 CSL":9,"MUSTANG SHELBY GT500":9,"MUSTANG SHELBY GT350":9,
  "MUSTANG SHELBY GT350R":9,"HEMI CUDA":9,"CHARGER DAYTONA":9,"12CILINDRI":9,
  "12CILINDRI SPIDER":9,"911 S/T":10,"REVUELTO":10,"BATUR":10,"GT3":8,"GT3 TOURING":8,
  "TURBO S":8,"CAYMAN GT4":8,"SPORT CLASSIC":8,"SPEEDSTER":8,"812 SUPERFAST":8,"812 GTS":8,
  "F12BERLINETTA":8,"488 GTB":8,"488 SPIDER":8,"296 GTB":8,"296 GTS":8,"PUROSANGUE":8,"DB12":7,
  "SPECTRE":8,"URUS PERFORMANTE":8,"750S":8,"HURACAN TECNICA":8,"AVENTADOR":8,"AVENTADOR S":8,
  "570S":8,"ARTURA":8,"DBS SUPERLEGGERA":8,"DB11":8,"M5 CS":8,"M4 CS":8,"M3 COMPETITION":8,
  "M4 GTS":8,"VIPER":8,"CAMARO ZL1":8,"CAMARO Z28":8,"NSX":8,"LFA":8,"RX-7":8,
};

const OVERRIDE_KEYS_BY_LENGTH = Object.keys(CURATED_OVERRIDES).sort((a, b) => b.length - a.length);

/**
 * @param {object} p
 * @param {string} p.modelName
 * @param {string} p.make
 * @param {number} p.value              - current value in USD
 * @param {number|null} p.msrp
 * @param {number} p.age
 * @param {boolean} [p.useCuratedOverrides=true] - set false when backtesting. The override
 *   table encodes 2026 hindsight about which cars turned out desirable; applying it inside
 *   a historical fold is lookahead bias (ground truth §4.6 warning).
 */
function collectibility({ modelName, make, value, msrp, age, useCuratedOverrides = true }) {
  const f = String(modelName || "").toUpperCase();
  const reasons = [];
  let o = 5;

  if (GRAIL.some((e) => f.includes(e))) { o += 4; reasons.push("Ultra-rare limited production"); }
  else if (TRACK.some((e) => f.includes(e))) { o += 3; reasons.push("Very limited / track-focused"); }
  else if (PERF.some((e) => f.includes(e))) { o += 2; reasons.push("Desirable performance model"); }
  else if (MASS.some((e) => f.includes(e))) { o -= 2; reasons.push("Mass-production model"); }

  if (/MANUAL|6-SPEED|6 SPEED/.test(f)) { o += 1; reasons.push("Manual transmission"); }

  if (value > 5e5) { o += 2; reasons.push("High-value segment"); }
  else if (value > 2e5) { o += 1; reasons.push("Premium segment"); }
  else if (value < 3e4) { o -= 1; reasons.push("Entry-level pricing"); }

  if (msrp && msrp > 0) {
    const ratio = value / msrp;
    if (ratio > 1.5) { o += 2; reasons.push("Trading well above MSRP"); }
    else if (ratio > 1.1) { o += 1; reasons.push("Trading above MSRP"); }
  }

  if (age >= 20 && age <= 35) { o += 1; reasons.push("Classic age — peak collectibility"); }
  else if (age >= 40) { o += 1; reasons.push("Vintage — established collector market"); }

  if (COLLECTOR_BRANDS.includes(make)) { o += 1; reasons.push("Strong collector brand"); }
  else if (DEPRECIATING_BRANDS.includes(make)) { o -= 1; reasons.push("Historically depreciates"); }

  const computed = Math.max(1, Math.min(10, o));

  if (useCuratedOverrides) {
    const key = OVERRIDE_KEYS_BY_LENGTH.find((k) => f.includes(k));
    if (key) {
      return { score: CURATED_OVERRIDES[key], reasons: [`Curated: ${key}`], overridden: true, computedScore: computed };
    }
  }

  return { score: computed, reasons, overridden: false, computedScore: computed };
}

module.exports = { collectibility, GRAIL, TRACK, PERF, MASS, CURATED_OVERRIDES, COLLECTOR_BRANDS, DEPRECIATING_BRANDS };
