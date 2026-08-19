// Does every JS file in the pipeline actually parse?
//
// WHY THIS EXISTS. A stray newline inside a string literal in db/export-serving.js shipped to a
// GitHub runner, which restored a 73MB database, ingested, and ran a full 71k-car recompute before
// reaching the broken file and dying at the last step. Nothing caught it earlier because no test
// loads that file — it is a CLI entry point, and the test suite only exercises modules it imports.
//
// So the check is not "do the tests pass" but the weaker, broader question the tests cannot ask:
// does every file the pipeline might spawn as a subprocess parse at all? That is worth ten seconds
// at the START of a run rather than an hour in.
//
// Parsing, not requiring: `new vm.Script` compiles without executing, so a file with side effects
// at module level (jobs/cron.js runs the whole pipeline and calls process.exit) is safe to check.
//
//   node validation/syntax-check.js
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Module = require("module");

const ROOT = path.join(__dirname, "..");

// web/ is excluded on purpose: it is TypeScript and ESM, built by Next's own toolchain, and this
// check would report false failures on syntax Node cannot parse as CommonJS.
const SKIP = new Set(["node_modules", ".git", ".next", "_archive", "web", "data", "samples"]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith(".js")) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const files = walk(ROOT).sort();
const broken = [];

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  try {
    // Module.wrap reproduces how Node actually loads a CommonJS file, so `return` at top level
    // and the module/exports/require identifiers parse the same way they would at runtime.
    new vm.Script(Module.wrap(src), { filename: file });
  } catch (err) {
    broken.push({ file: path.relative(ROOT, file), message: err.message });
  }
}

for (const b of broken) {
  console.log(`BROKEN  ${b.file}`);
  console.log(`        ${b.message}`);
}

console.log(`\n${files.length} files checked, ${broken.length} broken`);

if (broken.length) {
  console.log("\nA file that does not parse cannot run. Fix these before anything else — a syntax");
  console.log("error costs a whole pipeline run, because it is only reached when its stage starts.");
  process.exit(1);
}
