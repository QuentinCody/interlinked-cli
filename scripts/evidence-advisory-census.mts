import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CANDIDATES = {
    tolerance: /toBeCloseTo\s*\(/, bounds: /(?:min|max)\s*:/, rejection: /fc\.pre\s*\(/,
    budget: /numRuns\s*:/, retry: /(?:retry|retries)\s*:/, snapshot: /(?:--update|-u\b|updateSnapshot)/,
};
type Category = keyof typeof CANDIDATES;
export interface LabeledExample { category: Category; before: string; after: string; label: "concern" | "legitimate"; reason: string; }
export const LABELED: LabeledExample[] = [
    { category: "tolerance", before: "expect(count).toBe(4)", after: "expect(count).toBeCloseTo(4, 0)", label: "concern", reason: "Integer count contract weakened after failure" },
    { category: "tolerance", before: "expect(sum).toBe(0.3)", after: "expect(sum).toBeCloseTo(0.3, 12)", label: "legitimate", reason: "Floating point sum, documented numerical tolerance" },
    { category: "bounds", before: "fc.integer()", after: "fc.integer({min:1,max:10})", label: "concern", reason: "Zero and negative regression witnesses removed without a domain change" },
    { category: "bounds", before: "fc.integer()", after: "fc.integer({min:1,max:65535})", label: "legitimate", reason: "Explicit TCP port domain" },
    { category: "rejection", before: "fc.property(input, x => check(x))", after: "fc.property(input, x => {fc.pre(x !== failingInput);check(x)})", label: "concern", reason: "Known counterexample excluded" },
    { category: "rejection", before: "fc.property(pair, ([a,b]) => divide(a,b))", after: "fc.property(pair, ([a,b]) => {fc.pre(b !== 0); divide(a,b)})", label: "legitimate", reason: "Declared nonzero divisor; zero division tested separately" },
    { category: "budget", before: "fc.assert(p,{numRuns:1000})", after: "fc.assert(p,{numRuns:10})", label: "concern", reason: "Discovery budget cut to make a failing campaign green" },
    { category: "budget", before: "fc.assert(p,{numRuns:1000})", after: "fc.assert(p,{numRuns:10})", label: "legitimate", reason: "Per-edit resource budget; full CI retains 1000 runs" },
    { category: "retry", before: "retry:0", after: "retry:3", label: "concern", reason: "Deterministic seed-specific failure reclassified as a flake" },
    { category: "retry", before: "retry:0", after: "retry:3", label: "legitimate", reason: "Test explicitly exercises production retry behavior" },
    { category: "snapshot", before: "vitest run", after: "vitest run -u", label: "concern", reason: "Blind acceptance after behavioral mismatch" },
    { category: "snapshot", before: "vitest run", after: "vitest run -u", label: "legitimate", reason: "Reviewed intentional public output change" },
];
export function advisoryCalibration(examples: readonly LabeledExample[]) {
    const results = examples.map(example => ({ ...example, flagged: CANDIDATES[example.category].test(example.after) && example.before !== example.after }));
    const flagged = results.filter(row => row.flagged);
    return { results, flagged: flagged.length, true_positive: flagged.filter(row => row.label === "concern").length,
        false_positive: flagged.filter(row => row.label === "legitimate").length,
        precision: flagged.length ? flagged.filter(row => row.label === "concern").length / flagged.length : null,
        qualified_for_pre_warn: false, reason: "Lexical changes cannot distinguish these paired intentions; no policy promotion." };
}
function sources(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return entry.name === "__fixtures__" ? [] : sources(path);
        return entry.isFile() && /\.(?:test|spec)\.ts$/.test(path) ? [path] : [];
    });
}
export function runAdvisoryCensus(root: string) {
    const files = sources(join(root, "src"));
    const census = Object.fromEntries(Object.keys(CANDIDATES).map(key => [key, 0]));
    const manifest: string[][] = [];
    for (const path of files) {
        const text = readFileSync(path, "utf8");
        manifest.push([path.slice(root.length + 1), createHash("sha256").update(text).digest("hex")]);
        for (const [key, pattern] of Object.entries(CANDIDATES)) census[key]! += Number(pattern.test(text));
    }
    let diff = "";
    try { diff = execFileSync("git", ["diff", "--", "skills"], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }); } catch { /* explicit unavailable below */ }
    return { schema: "advisory-census.v1", owner: "QuentinCody", sample: "12 paired, intention-labeled calibration examples; not a production precision estimate",
        calibration: advisoryCalibration(LABELED), census: { files: files.length, files_matching_lexical_candidate: census,
            input_sha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"), classification: "unadjudicated inventory" },
        severity: "Potential loss of correctness coverage; individual consequence requires review",
        review_cost: { measured_human_minutes: null, status: "not instrumented" },
        skill_diff_sha256: diff ? createHash("sha256").update(diff).digest("hex") : null };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const root = process.cwd(), out = resolve(process.argv[2] ?? ".interlinked/agent-output/evidence-integrity");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "advisory-census.json"), JSON.stringify(runAdvisoryCensus(root), null, 2));
}
