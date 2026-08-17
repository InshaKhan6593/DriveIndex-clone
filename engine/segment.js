// [V] VERIFIED — ground truth §4.11, function N(), reproduced verbatim.
// Was missing entirely from the previous build.
//
// Note Maserati sits in the EXOTIC list here, while the collectibility rules (§4.6) dock it
// -1 as a "historically depreciates" brand. Both are theirs and both are intentional — a
// Maserati is positioned as an exotic but priced as a depreciating asset.

const HYPERCAR_MAKES = ["Bugatti", "Pagani", "Koenigsegg"];
const EXOTIC_MAKES = ["Ferrari", "Lamborghini", "McLaren", "Rolls-Royce", "Bentley", "Aston Martin", "Maserati"];
const PERF_MAKES = ["Porsche", "Mercedes-Benz", "Mercedes-AMG", "BMW", "Audi", "Jaguar", "Land Rover", "Range Rover", "Lotus", "Alfa Romeo"];

function classifySegment(make, value) {
  const v = Number.isFinite(value) ? value : 0;
  if (HYPERCAR_MAKES.includes(make) || v > 15e5) return "hypercar";
  if (EXOTIC_MAKES.includes(make) || v > 4e5) return "exotic";
  if (PERF_MAKES.includes(make) || v > 9e4) return "perf";
  return "mainstream";
}

module.exports = { classifySegment, HYPERCAR_MAKES, EXOTIC_MAKES, PERF_MAKES };
