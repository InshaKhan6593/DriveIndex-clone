// STANDING REVIEW DECISIONS.
//
// The review queue is only useful if decisions STICK. Without this, every nightly run
// re-queues the same tank, the same wheel sets, the same motorcycles, and the "human review"
// number never falls — the operator reviews the same 11 things forever and stops reading it.
//
// Each entry below was adjudicated by inspecting the real record. `reject` means "this is
// not a car for a car price index" and the item is dropped silently on future runs instead
// of re-queued. Anything NOT matched here still goes to a human, so this is an allowlist of
// settled cases, never a catch-all.
//
// Adjudicated 2026-08-15 against the 11 items then in the queue.

const STANDING_REJECTIONS = [
  // --- parts / automobilia (not vehicles) ---
  { re: /\bwheels?\b.*\bfor\b|^\d+×[\d.]+″/i, reason: "wheels/parts listing", adjudicated: "2026-08-15" },
  { re: /\b(sign|poster|memorabilia|literature|toolkit|gas pump)\b/i, reason: "automobilia, not a vehicle", adjudicated: "2026-08-15" },

  // --- powered but not cars ---
  { re: /\boutboard\b|\bevinrude\b/i, reason: "marine engine", adjudicated: "2026-08-15" },
  { re: /\bharley-?davidson\b|\bindian\b\s+model|\bamb\s*001\b|\bbrough superior\b/i, reason: "motorcycle", adjudicated: "2026-08-15" },
  // Motorcycle MODELS from makes that also build cars (Honda, Suzuki, BMW, Yamaha) — the
  // make alone cannot decide these, so they are matched on the model. Added after
  // "2000 Yamaha V Star" (Mecum) reached the queue: it was correctly identified as
  // out-of-scope but still asked a human, which is wasted attention for a settled category.
  { re: /\bv[- ]?star\b|\bvmax\b|\bvirago\b|\bgold ?wing\b|\bcbr\d|\bhayabusa\b|\bgsx-?r\b|\bboulevard\b|\bv-?strom\b/i, reason: "motorcycle model", adjudicated: "2026-08-15" },
  { re: /\b(medium\s+)?tank\b|\bt-34\b/i, reason: "military vehicle", adjudicated: "2026-08-15" },

  // --- vehicles, but no consumer model-year to index against ---
  { re: /\bracing single-?seater\b|\busac\b|\bvollstedt\b/i, reason: "one-off racing chassis, no consumer model", adjudicated: "2026-08-15" },
];

// Cases that are REAL cars but must never merge into the genuine model's price curve.
// These are ACCEPTED into the corpus, tagged, and kept separate — not rejected.
const STANDING_TAGS = [
  { re: /\breplica\b|\bre-?creation\b|\btribute\b|\bcontinuation\b/i, modification: "Replica", adjudicated: "2026-08-15" },
];

function standingDecision(title) {
  const t = String(title || "");
  for (const r of STANDING_REJECTIONS) if (r.re.test(t)) return { action: "reject", reason: r.reason };
  for (const g of STANDING_TAGS) if (g.re.test(t)) return { action: "tag", modification: g.modification };
  return null;
}

module.exports = { standingDecision, STANDING_REJECTIONS, STANDING_TAGS };
