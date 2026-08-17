// Shared helpers + the one piece of shared state: which formulas below are copied verbatim
// from the reverse-engineered build spec (VERIFIED, read directly from DriveIndex's shipped
// bundle) vs. reconstructed from a described METHOD without exact published code (INFERRED).
// Carrying that same provenance framework from the original teardown into this codebase —
// don't let a defensible reconstruction quietly masquerade as a verified constant.

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

module.exports = { clamp };
