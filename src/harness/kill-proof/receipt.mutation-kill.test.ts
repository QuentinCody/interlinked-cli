// Mutation-kill tests for kill-proof/receipt.ts — 2026-11-05 dogfood campaign
// (docs/reviews/kill-proof-dogfood.md). Each case pins the observable a surviving
// engine-shaped fault changed: the id binding, the digest, integrity, certification
// per file, the uncommitted check and config-declared inputs.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VitestRun } from "../fail-before-fix/index.js";
import { configDeclaredInputs, declaredVitestConfig, receiptDigest, receiptId, sealReceipt } from "./receipt.js";
import { freshKillsForTest, integrityReasons, receiptCertifies, uncommittedPaths, verifyKillProof } from "./receipt-freshness.js";
import { proveKill } from "./run.js";
import { requirementCovered } from "./source-cases.js";
import type { KillProofReceipt, ResolvedMutant } from "./types.js";

const SOURCE = "export function clamp(n: number, max: number): number {\n\treturn n > max ? max : n;\n}\n";
const TEST = "import { clamp } from './clamp.js';\nit('caps', () => { expect(clamp(5, 3)).toBe(3); });\n";
const TEST_FILE = "src/clamp.test.ts";
const OTHER_FILE = "src/clamp.other.test.ts";
const SPEC = { kind: "explicit", file: "src/clamp.ts", find: "n > max", replace: "n >= max" } as const;

let root: string;
const git = (...args: string[]): void => { execFileSync("git", ["-C", root, ...args], { stdio: "ignore" }); };
function write(path: string, text: string): void {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), text);
}
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-receipt-mk-")));
	git("init", "-q");
	write("src/clamp.ts", SOURCE);
	write(TEST_FILE, TEST);
	git("add", ".");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Case = VitestRun["cases"][number];
const passing = (name: string, file = TEST_FILE): Case => ({ file, name, title: name, status: "passed" });
const failing = (name: string, file = TEST_FILE): Case => ({ file, name, title: name, status: "failed", message: "AssertionError: expected 5 to be 3" });
const okRun = (cases: Case[]): VitestRun => ({ cases, timedOut: false, exitCode: 0, durationMs: 10 });
function fakeRunner(baseline: VitestRun, mutated: VitestRun) {
	return async (dir: string): Promise<VitestRun> => {
		const source = readFileSync(join(dir, "src/clamp.ts"), "utf8");
		if (source.includes("kill-proof canary")) return okRun(baseline.cases.map(row => ({ ...row, status: "failed", message: "Error: canary" })));
		return source === SOURCE ? baseline : mutated;
	};
}
async function provenKill(tests: string[] = [TEST_FILE], mutated: VitestRun = okRun([failing("caps")])): Promise<KillProofReceipt> {
	const baseline = okRun(tests.map(file => passing("caps", file)));
	const result = await proveKill({ root, spec: SPEC, tests, budgetMs: 1000, runner: fakeRunner(baseline, mutated) });
	if (!result.ok) throw new Error(`expected a receipt: ${result.reasons.join("; ")}`);
	return result.receipt;
}
/** Deep key reversal: the shape `parseKillProof` could rebuild in another insertion order. */
function reversed(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reversed);
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([k, v]) => [k, reversed(v)]));
	return value;
}

const MUTANT: ResolvedMutant = { file: "src/clamp.ts", offset: 64, originalLexeme: "n > max", replacement: "n >= max", line: 2, source: "explicit" };
const ENV = { node: "v22.0.0", vitest: "4.0.0", platform: "linux-x64", config: null, setupFiles: [] };
const HASHED = { source: { path: "src/clamp.ts", sha256: "a" }, tests: [{ path: TEST_FILE, sha256: "b" }], boundImports: [], environment: ENV };

describe("receiptId — the binding covers the whole mutant", () => {
	// test-contract: invariant - two proofs that differ only in the replacement are different proofs; sharing an id would make one overwrite the other
	it("a different replacement at the same site yields a different id", () => {
		const a = receiptId({ ...HASHED, mutant: MUTANT });
		const b = receiptId({ ...HASHED, mutant: { ...MUTANT, replacement: "n < max" } });
		expect(a).not.toBe(b);
		expect(receiptId({ ...HASHED, mutant: { ...MUTANT } })).toBe(a);
	});
});

describe("receiptDigest — covers the verdict and is key-order independent", () => {
	// test-contract: invariant - the digest changes when ONLY the verdict is flipped, so a verdict-only edit is detected by the digest itself
	it("flipping the verdict alone changes the digest and is named as a digest mismatch", async () => {
		const receipt = await provenKill();
		const flipped = { ...receipt, verdict: "survived" as const };
		expect(receiptDigest(flipped)).not.toBe(receipt.digest);
		expect(integrityReasons(root, flipped)).toContain("receipt digest does not match its contents (edited receipt)");
	});
	// test-contract: invariant - canonical JSON sorts keys, so a receipt rebuilt by the parser in another insertion order still matches its digest
	it("the same receipt with every object's keys in reverse order has the same digest", async () => {
		const receipt = await provenKill();
		expect(receiptDigest(reversed(receipt) as KillProofReceipt)).toBe(receipt.digest);
	});
});

describe("integrityReasons — verdict/case agreement in both directions", () => {
	// test-contract: invariant - a receipt that records a killed case but claims survived is inconsistent, even when its digest was recomputed
	it("a sealed receipt claiming survived over a killed case is flagged", async () => {
		const receipt = await provenKill();
		const forged = sealReceipt({ ...receipt, verdict: "survived" });
		expect(integrityReasons(root, forged)).toContain("verdict disagrees with the recorded cases");
	});
});

describe("requirementCovered — an exact title matches the full name only", () => {
	// test-contract: boundary - a killed case's full name must EQUAL the exact title (round 4 replaced the describe-boundary suffix rule); a title that is only the tail of a longer name does not match
	it("a title that is only the tail of a longer title does not match", () => {
		const killed = (name: string) => [{ name, verdict: "killed" as const }];
		expect(requirementCovered({ kind: "exact", name: "kills boundary" }, killed("kills boundary"))).toBe(true);
		expect(requirementCovered({ kind: "exact", name: "kills boundary" }, killed("suite > kills boundary"))).toBe(false);
		expect(requirementCovered({ kind: "exact", name: "boundary" }, killed("killsboundary"))).toBe(false);
		expect(requirementCovered({ kind: "exact", name: "boundary" }, killed("the unboundary"))).toBe(false);
	});
});

describe("receiptCertifies — per named file, only the files the receipt killed through", () => {
	// test-contract: invariant - a receipt that killed through file A does not certify file B, even though B is named in the receipt and its bytes are unchanged (review R2)
	it("a receipt is not evidence for a named file whose cases all survived", async () => {
		write(OTHER_FILE, TEST);
		git("add", ".");
		const mutated = okRun([failing("caps"), passing("caps", OTHER_FILE)]);
		const receipt = await provenKill([TEST_FILE, OTHER_FILE], mutated);
		expect(receipt.killedTests).toEqual([TEST_FILE]);
		expect(receiptCertifies(root, receipt.id, TEST_FILE).certified).toBe(true);
		const other = receiptCertifies(root, receipt.id, OTHER_FILE);
		expect(other.certified).toBe(false);
		expect(other.certified ? [] : other.reasons).toContain(`receipt did not kill through ${OTHER_FILE}`);
		expect(freshKillsForTest(root, OTHER_FILE)).toEqual([]);
	});
});

describe("uncommittedPaths — untracked files are uncommitted", () => {
	// test-contract: public-api - a bound file git does not track at all is reported, not silently treated as committed
	it("an untracked file is listed", () => {
		write("src/untracked.ts", "export const x = 1;\n");
		expect(uncommittedPaths(root, [{ path: "src/untracked.ts", sha256: "x" }])).toEqual(["src/untracked.ts"]);
	});
});

describe("environment freshness — the vitest config is bound", () => {
	// test-contract: invariant - editing the vitest config after the proof stales the receipt: the runtime the proof certified includes the config bytes
	it("a config edit after the proof is a named staleness reason", async () => {
		write("vitest.config.ts", "export default {};\n");
		const receipt = await provenKill();
		expect(receipt.environment.config?.path).toBe("vitest.config.ts");
		expect(verifyKillProof(root, receipt)).toEqual({ fresh: true });
		write("vitest.config.ts", "export default { test: {} };\n");
		const after = verifyKillProof(root, receipt);
		expect(after.fresh).toBe(false);
		expect(after.fresh ? [] : after.reasons).toContain("vitest/vite config changed since the proof");
		expect(freshKillsForTest(root, TEST_FILE)).toEqual([]);
	});
});

describe("declaredVitestConfig / configDeclaredInputs — the grammar the receipt binds", () => {
	// test-contract: public-api - vitest's short `-c <file>` flag declares a config just as `--config` does
	it("`vitest run -c <file>` in scripts.test is the declared config", () => {
		write("vitest.unit.config.ts", "export default {};\n");
		write("package.json", `${JSON.stringify({ name: "p", scripts: { test: "vitest run -c vitest.unit.config.ts" } })}\n`);
		expect(declaredVitestConfig(root)).toBe("vitest.unit.config.ts");
	});
	// test-contract: public-api - a `globalSetup` file is a declared input of the config, bound like `setupFiles` (review N9)
	it("a globalSetup literal is a declared input", () => {
		write("global-setup.ts", "export default () => {};\n");
		write("vitest.config.ts", "export default { test: { globalSetup: './global-setup.ts' } };\n");
		expect(configDeclaredInputs(root, "vitest.config.ts")).toEqual(["global-setup.ts"]);
	});
});
