#!/usr/bin/env node
/**
 * Test runner: rebuild the harness, then execute every suite in order.
 *
 *   npm test
 *   node tests/run-all.mjs 03           # only suites matching "03"
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2];

console.log("Building test harness…");
execFileSync("node", [join(here, "prepare.mjs")], { stdio: "inherit" });

const suites = readdirSync(here)
  .filter((f) => /^\d+-.*\.mjs$/.test(f))
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (suites.length === 0) {
  console.error(`No suites matched ${filter ?? "(none)"}`);
  process.exit(1);
}

let totalPassed = 0;
let totalFailed = 0;
const broken = [];

for (const suite of suites) {
  console.log(`\n${"=".repeat(64)}\n${suite}\n${"=".repeat(64)}`);
  const res = spawnSync("node", [join(here, suite)], {
    encoding: "utf8",
    cwd: here,
  });

  // Handler code logs recovered errors to stderr on purpose; only surface it
  // when the suite actually failed, so passing runs stay readable.
  process.stdout.write(res.stdout ?? "");

  const summary = (res.stdout ?? "").match(/(\d+) passed, (\d+) failed/);
  if (summary) {
    totalPassed += Number(summary[1]);
    totalFailed += Number(summary[2]);
  }

  if (res.status !== 0) {
    broken.push(suite);
    if (!summary) {
      console.error(res.stderr ?? "");
    }
  }
}

console.log(`\n${"=".repeat(64)}`);
console.log(`TOTAL: ${totalPassed} passed, ${totalFailed} failed`);
if (broken.length > 0) console.log(`failing suites: ${broken.join(", ")}`);
console.log("=".repeat(64));

process.exit(totalFailed === 0 && broken.length === 0 ? 0 : 1);
