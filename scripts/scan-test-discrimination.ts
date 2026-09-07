// Read-only, reproducible calibration census. Run from this checkout:
// npx tsx scripts/scan-test-discrimination.ts [corpus-root] [check-id ...]
// Scans tracked JS/TS tests at their CURRENT contents, using absolute paths so
// sibling SUT/config discovery works. Counts are capped per detector/file; they
// measure fire rate, not precision. No files are changed and no config executes.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TEST_DISCRIMINATION_ENTRIES } from "../src/harness/check-registry/entries-warnings/test-discrimination.js";

const root = resolve(process.argv[2] ?? ".");
const requested = new Set(process.argv.slice(3));
const checks = TEST_DISCRIMINATION_ENTRIES.filter((entry) => requested.size === 0 || requested.has(entry.id));
for (const id of requested) {
    if (!checks.some((entry) => entry.id === id)) throw new Error(`Unknown test-discrimination check: ${id}`);
}
const files = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
    .split("\0").filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file));
const totals = Object.fromEntries(checks.map((entry) => [entry.id, { hits: 0, files: 0 }]));
const findings: { check: string; file: string; line: number; text: string }[] = [];
const unreadable: string[] = [];
for (const file of files) {
    let content: string;
    try { content = readFileSync(resolve(root, file), "utf8"); } catch { unreadable.push(file); continue; }
    for (const entry of checks) {
        const matches = entry.fn(content, resolve(root, file));
        const total = totals[entry.id];
        if (!total || matches.length === 0) continue;
        total.hits += matches.length;
        total.files++;
        for (const match of matches) findings.push({ check: entry.id, file, ...match });
    }
}
console.log(JSON.stringify({ corpus: root, trackedTestFiles: files.length, scanned: files.length - unreadable.length, unreadable, totals, findings }, null, 2));
