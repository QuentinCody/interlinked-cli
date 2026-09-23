// Port of .interlinked/e2e-mutation-gate.mts: this was a library-level
// Stryker probe. Keep real engine assertions here; daemon availability lives
// in src/e2e/mutation-gate.e2e.test.ts. Never overlay the user's repository.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runPerEditMutationGate, type MutationRunner, type PerEditMutationConfig } from "./gate.js";
import { computeSymbolHashes } from "./identity.js";
import { emptyManifest, loadManifest, makeManifestPersister } from "./manifest.js";
import { strykerToAdapted, type MutationRunOutput } from "./stryker-adapter.js";
import type { MutationManifest } from "./types.js";

const project = process.cwd();
let root: string;
const source = "export function above(value: number): boolean { return value > 3; }\n";
const tests = 'import { expect, it } from "vitest";\nimport { above } from "./value.js";\nit("boundary", () => { expect(above(4)).toBe(true); expect(above(3)).toBe(false); });\n';
const meta = { engine: "stryker", engineVersion: "9", dependencyGraphVersion: "fixture", environmentHash: "fixture", authoritativeAt: "fixture" };
const memo = new Map<string, MutationRunOutput>();
beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "mutation-live-"));
    mkdirSync(join(root, "src"));
    symlinkSync(join(project, "node_modules"), join(root, "node_modules"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "mutation-fixture", type: "module" }));
    writeFileSync(join(root, "src/value.ts"), source);
    writeFileSync(join(root, "src/value.test.ts"), tests);
    writeFileSync(join(root, "vitest.config.mjs"), 'export default { test: { include: ["src/value.test.ts"], maxWorkers: 1, retry: 0 } };');
    writeFileSync(join(root, "stryker.config.json"), JSON.stringify({ testRunner: "vitest", mutate: ["src/value.ts"], reporters: ["json"], jsonReporter: { fileName: "reports/mutation.json" }, vitest: { configFile: "vitest.config.mjs" }, concurrency: 1, coverageAnalysis: "perTest", incremental: false, ignorePatterns: [".interlinked/**"] }));
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

function engine(overlay: string): MutationRunOutput {
    const key = overlay + readFileSync(join(root, "src/value.test.ts"), "utf8");
    const cached = memo.get(key);
    if (cached) return cached;
    writeFileSync(join(root, "src/value.ts"), overlay);
    try {
        const suite = spawnSync(process.execPath, [join(project, "node_modules/vitest/vitest.mjs"), "run", "--reporter=json", "--outputFile=tests.json"], { cwd: root, encoding: "utf8", timeout: 60_000 });
        const measured = JSON.parse(readFileSync(join(root, "tests.json"), "utf8"));
        const testRun = { overlayGreen: suite.status === 0, redWitnessSatisfied: null };
        if (suite.status !== 0) return { mutants: [], testRun, executedTestCount: measured.numTotalTests };
        const run = spawnSync(process.execPath, [join(project, "node_modules/@stryker-mutator/core/bin/stryker.js"), "run", "stryker.config.json"], { cwd: root, encoding: "utf8", timeout: 120_000 });
        expect(run.status, run.stdout + run.stderr).toBe(0);
        const adapted = strykerToAdapted(JSON.parse(readFileSync(join(root, "reports/mutation.json"), "utf8")));
        const target = adapted?.find((file) => file.file === "src/value.ts");
        expect(target).toBeDefined();
        const output = { mutants: target?.mutants ?? [], droppedMutants: target?.dropped ?? 0, testRun, executedTestCount: measured.numTotalTests, engineExitCode: run.status };
        memo.set(key, output);
        return output;
    } finally { writeFileSync(join(root, "src/value.ts"), source); }
}

it("preserves the clean/uncovered/test-first/red/oversize mutation discipline with real Stryker", async () => {
    const runner: MutationRunner = { available: () => true, run: async (_file, overlay) => engine(overlay) };
    const dataDir = join(root, ".interlinked");
    const run = (new_string: string, baseManifest: MutationManifest, config: Partial<PerEditMutationConfig> = {}) => runPerEditMutationGate({
        toolName: "Edit", toolInput: { file_path: "src/value.ts", old_string: source, new_string },
        config: { enabled: true, mode: "block", unavailable_behavior: "block", budget_ms: 180_000, ...config }, runner,
        baseManifest, readDisk: (path) => readFileSync(resolve(root, path), "utf8"), persist: makeManifestPersister(dataDir), at: new Date().toISOString(),
    });
    const first = await run(`// reviewed\n${source}`, emptyManifest(meta));
    expect(first?.decision, first?.reason).toBe("allow");
    const gen1 = loadManifest(dataDir);
    expect(gen1?.generation).toBe(1);
    if (!gen1) throw new Error("Missing measured generation");
    const added = `export function below(value: number): boolean { return value < 2; }\n${source}`;
    const uncovered = await run(added, gen1);
    expect(uncovered?.decision).toBe("block");
    expect(uncovered?.reason).toContain("uncovered changed mutation site");
    const shifted = computeSymbolHashes("src/value.ts", added);
    const recorded = Object.values(gen1.files["src/value.ts"] ?? {});
    expect(recorded.length).toBeGreaterThan(0);
    for (const symbol of recorded) expect(shifted?.get(symbol.symbolId)?.symbolHash).toBe(symbol.symbolHash);
    writeFileSync(join(root, "src/value.test.ts"), `${tests}\nimport { below } from "./value.js";\nit("new boundary", () => { expect(below(1)).toBe(true); expect(below(2)).toBe(false); });\n`);
    const fixed = await run(added, gen1);
    expect(fixed?.decision, fixed?.reason).toBe("allow");
    expect(loadManifest(dataDir)?.generation).toBe(2);
    writeFileSync(join(root, "src/value.test.ts"), tests);
    const red = await run(source.replace("value > 3", "value < 3"), gen1);
    expect(red?.decision).toBe("block");
    expect(red?.reason).toContain("RED on this edit");
    const large = await run(added, gen1, { site_count_threshold: 1 });
    expect(large?.decision).toBe("block");
    expect(large?.reason).toContain("small-scope limit");
    const receipts = readFileSync(join(dataDir, "mutation-receipts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(receipts).toHaveLength(2);
    expect(receipts[0].overlayHash).toHaveLength(64);
    expect(readFileSync(join(root, "src/value.ts"), "utf8")).toBe(source);
}, 180_000);
