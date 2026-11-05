// Kill proof — adversarial review round 3 (docs/reviews/kill-proof-review-round3.md).
// Every case here was REPRODUCED against this branch (the real `tests prove-kill`
// command or the real Stop/nudge functions) and is expected to FAIL until the
// product code is fixed: a red test is the deliverable. N<n> = the system must NOT
// report a kill / must NOT discharge the gap; P<n> = a real situation must NOT be
// misreported. Real-vitest cases build a throwaway git repo whose node_modules
// links to this checkout's.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { killProofNudge } from "../evaluator/post-tool-kill-proof.js";
import type { VitestRun } from "../fail-before-fix/index.js";
import { detectMutationKillEvidenceGaps } from "../mutation-kill-evidence-stop-check.js";
import { freshKillsForTest, killProofsDir, readKillProof, rebuildKillProofIndex, sealReceipt, verifyKillProof } from "./receipt.js";
import { proveKill } from "./run.js";

const NODE_MODULES = fileURLToPath(new URL("../../../node_modules", import.meta.url));
const REAL_RUN_MS = 90_000;
const roots: string[] = [];
const strays: string[] = [];

function makeRepo(files: Record<string, string>, opts: { linkModules?: boolean } = {}): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-r3-")));
	roots.push(root);
	execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	if (opts.linkModules) symlinkSync(NODE_MODULES, join(root, "node_modules"));
	execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	for (const path of strays.splice(0)) rmSync(path, { force: true });
});

const MATH = "// helper: add two numbers\nexport function add(a: number, b: number): number {\n\treturn a + b;\n}\n";
const CONFIG = 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["test/**/*.test.ts"] } });\n';
const realRepo = (tests: Record<string, string>, extra: Record<string, string> = {}) =>
	makeRepo({ ".gitignore": "node_modules\n.interlinked\n", "package.json": '{"name":"fx","type":"module"}\n', "vitest.config.ts": CONFIG, "src/math.ts": MATH, ...tests, ...extra }, { linkModules: true });
const COMMENT_FAULT = { kind: "explicit", file: "src/math.ts", find: "// helper: add two numbers", replace: "// helper: add 2 numbers" } as const;
const MINUS_FAULT = { kind: "explicit", file: "src/math.ts", find: "return a + b;", replace: "return a - b;" } as const;

/** A test that passes once and fails on every later run, through a marker at `markerExpr`. */
const secondRunFails = (markerExpr: string) => [
	'import { existsSync, writeFileSync } from "node:fs";',
	'import { tmpdir } from "node:os";',
	'import { join } from "node:path";',
	'import { expect, it } from "vitest";',
	'import { add } from "../src/math";',
	'it("adds once", () => {',
	`\tconst marker = ${markerExpr};`,
	"\tconst first = !existsSync(marker);",
	'\twriteFileSync(marker, "x");',
	"\texpect(add(1, 2)).toBe(3);",
	"\texpect(first).toBe(true);",
	"});",
	"",
].join("\n");

const IMPORT_CHECK = [
	'import { expect, it } from "vitest";',
	'it("module is importable", async () => {',
	"\tlet loaded = true;",
	'\ttry { await import("../src/math"); await import("../src/plain.js"); } catch { loaded = false; }',
	"\texpect(loaded).toBe(true);",
	"});",
	"",
].join("\n");
const PLAIN_JS = "export function add(a, b) {\n\tconst s = a + b;\n\treturn s;\n}\n";

// ---- scripted-runner fixtures for the Stop / nudge certification paths ----

type Case = VitestRun["cases"][number];
const okRun = (cases: Case[]): VitestRun => ({ cases, timedOut: false, exitCode: 0, durationMs: 10 });
const pass = (file: string, name: string): Case => ({ file, name, title: name, status: "passed" });
const fail = (file: string, name: string): Case => ({ file, name, title: name, status: "failed", message: "AssertionError: expected 5 to be 3" });
/** Answers by what the copy holds: unmutated → baseline (also the repeat baseline after a kill), mutated → mutated,
 *  the reachability canary → every case fails (the tests DID load the file). */
function scripted(baseline: VitestRun, mutated: VitestRun) {
	const loaded: VitestRun = okRun(baseline.cases.map(row => ({ ...row, status: "failed", message: "Error: interlinked kill-proof canary" })));
	return async (dir: string): Promise<VitestRun> => {
		const source = readFileSync(join(dir, "src/clamp.ts"), "utf8");
		if (source.includes("kill-proof canary")) return loaded;
		return source === UNIT_SOURCE ? baseline : mutated;
	};
}

const UNIT_SOURCE = "export function clamp(n: number, max: number): number {\n\treturn n > max ? max : n;\n}\n";
const UNIT_SPEC = { kind: "explicit", file: "src/clamp.ts", find: "n > max", replace: "n >= max" } as const;
const MK = "src/clamp.mutation-kill.test.ts";
const OLD_CASE = "// test-contract: bug — caps at max\nit('caps at max', () => { expect(clamp(5, 3)).toBe(3); });\n";

/**
 * Baseline bytes `before`, current bytes `after`; the scripted run reports `outcomes`
 * (name → killed?) under the mutant. Returns the Stop hit and the nudge for MK.
 */
async function stopAndNudge(before: string, after: string, outcomes: Record<string, boolean>) {
	const root = makeRepo({ "src/clamp.ts": UNIT_SOURCE, [MK]: after });
	const names = Object.keys(outcomes);
	const runner = scripted(okRun(names.map(name => pass(MK, name))), okRun(names.map(name => (outcomes[name] ? fail(MK, name) : pass(MK, name)))));
	const result = await proveKill({ root, spec: UNIT_SPEC, tests: [MK], budgetMs: 1000, runner });
	if (!result.ok || result.receipt.verdict !== "killed") throw new Error("fixture: expected a killed receipt");
	const abs = join(root, MK);
	const hits = detectMutationKillEvidenceGaps({
		filesWritten: new Set([abs]),
		fileWriteTimes: new Map([[abs, new Date().toISOString()]]),
		gitHeadSha: "deadbeef",
		cwd: root,
		gitShow: () => before,
		readFile: file => readFileSync(file, "utf8"),
		loadMutationManifest: () => null,
	});
	return { hit: hits[0], nudge: killProofNudge({ root, relPath: MK }) };
}
const weak = (title: string) => `// test-contract: bug — ${title}\nit(${JSON.stringify(title)}, () => { expect(typeof clamp).toBe('function'); });\n`;

describe("kill proof round 3 — negative (must not report a kill / must not discharge)", () => {
	it("N1: state a run leaves under the SHARED node_modules link does not turn a comment-only mutant into a kill", async () => {
		// review L1 (K1 bypass) — both copies symlink the live node_modules, so a baseline marker reaches the mutant run
		const name = `.kp-r3-${process.pid}-${Date.now()}`;
		strays.push(join(NODE_MODULES, name));
		const root = realRepo({ "test/state.test.ts": secondRunFails(`join(process.cwd(), "node_modules", ${JSON.stringify(name)})`) });
		const result = await proveKill({ root, spec: COMMENT_FAULT, tests: ["test/state.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).not.toBe("killed");
	}, REAL_RUN_MS);

	it("N2: state a run leaves in os.tmpdir() does not turn a comment-only mutant into a kill", async () => {
		// review L1 (K1 bypass) — the two copies share the host temp directory
		const name = `kp-r3-${process.pid}-${Date.now()}`;
		strays.push(join(tmpdir(), name));
		const root = realRepo({ "test/state.test.ts": secondRunFails(`join(tmpdir(), ${JSON.stringify(name)})`) });
		const result = await proveKill({ root, spec: COMMENT_FAULT, tests: ["test/state.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).not.toBe("killed");
	}, REAL_RUN_MS);

	// POLICY (review L2): receipts are tamper-evident, not tamper-proof; writes under kill-proofs/ are refused at the
	// edit-tool boundary (protected_files) and the guide says so. A byte-level rewrite is not detectable; kept as a todo.
	it.todo("N3 (policy): a SURVIVED receipt rewritten with a recomputed digest is not fresh evidence", async () => {
		// review L2 (K3 wider) — the digest is unkeyed and no surface binds a receipt to an observed run
		const root = makeRepo({ "src/clamp.ts": UNIT_SOURCE, [MK]: weak("weak") });
		const runner = scripted(okRun([pass(MK, "weak")]), okRun([pass(MK, "weak")]));
		const result = await proveKill({ root, spec: UNIT_SPEC, tests: [MK], budgetMs: 1000, runner });
		if (!result.ok || result.receipt.verdict !== "survived") throw new Error("fixture: expected a survived receipt");
		const path = join(killProofsDir(root), `${result.receipt.id}.json`);
		const forged = { ...result.receipt, verdict: "killed" as const, killedTests: [MK], underMutant: { ...result.receipt.underMutant, cases: [{ test: `${MK} › weak`, verdict: "killed" as const }] } };
		writeFileSync(path, JSON.stringify(sealReceipt(forged)));
		writeFileSync(join(killProofsDir(root), "index.json"), JSON.stringify(rebuildKillProofIndex(root)));
		const read = readKillProof(root, result.receipt.id);
		expect(read).not.toBeNull();
		if (read === null) return;
		expect(verifyKillProof(root, read).fresh).toBe(false);
		expect(freshKillsForTest(root, MK)).toHaveLength(0);
	});

	it("N4: a new it.each case that kills nothing is not discharged by an old case's kill", async () => {
		// review L3 — newCaseTitles finds no literal title for it.each, so requireCases is empty and any kill certifies
		const added = "// test-contract: bug — boundary\nit.each([5, 6])('kills boundary %i', (n) => { expect(typeof clamp).toBe('function'); });\n";
		const { hit } = await stopAndNudge(OLD_CASE, OLD_CASE + added, { "caps at max": true, "kills boundary 5": false, "kills boundary 6": false });
		expect(hit?.staleMeasurement).toBe(true);
	});

	it("N5: a new case whose title is a substring of an old killing case's title is not discharged", async () => {
		// review L3 — the title match is `includes`, so "caps" matches the old "caps at max"
		const { hit } = await stopAndNudge(OLD_CASE, OLD_CASE + weak("caps"), { "caps at max": true, caps: false });
		expect(hit?.staleMeasurement).toBe(true);
	});

	it("N6: one strong new case does not discharge a second new case that kills nothing", async () => {
		// review L3 — `requireCases.some(...)`: one killing new case certifies every new case in the file
		const strong = "// test-contract: bug — strong\nit('kills boundary (strong)', () => { expect(clamp(3, 3)).toBe(3); });\n";
		const { hit } = await stopAndNudge(OLD_CASE, OLD_CASE + strong + weak("kills boundary (weak)"), { "caps at max": false, "kills boundary (strong)": true, "kills boundary (weak)": false });
		expect(hit?.staleMeasurement).toBe(true);
	});

	it("N7: renaming an old killing case does not discharge a new case that kills nothing", async () => {
		// review L3 — a renamed case's title is "new", so the old assertion certifies the new weak case
		const renamed = OLD_CASE.replace("it('caps at max'", "it('kills the boundary mutant'");
		const { hit } = await stopAndNudge(OLD_CASE, renamed + weak("kills boundary"), { "kills the boundary mutant": true, "kills boundary": false });
		expect(hit?.staleMeasurement).toBe(true);
	});

	it("N8: wrapping the old killing case in a describe named like the new case does not discharge it", async () => {
		// review L3 — vitest's full name carries the describe title, and `includes` matches it
		const wrapped = `describe('kills boundary', () => {\n${OLD_CASE}});\n`;
		const { hit } = await stopAndNudge(OLD_CASE, wrapped + weak("kills boundary"), { "kills boundary caps at max": true, "kills boundary": false });
		expect(hit?.staleMeasurement).toBe(true);
	});

	it("N9: a new case whose title sits on the line after `it(` is still a new case", async () => {
		// review L4 — countTestCaseOpeners is line-based and does not see a multi-line opener, so the Stop check is silent
		const multi = "// test-contract: bug — boundary\nit(\n\t'kills boundary',\n\t() => { expect(typeof clamp).toBe('function'); },\n);\n";
		const { hit } = await stopAndNudge(OLD_CASE, OLD_CASE + multi, { "caps at max": true, "kills boundary": false });
		expect(hit?.newCaseCount).toBe(1);
	});

	it("N10: the PostToolUse nudge is not silenced for a file whose only killing case is an OLD one", async () => {
		// review L5 (K4 on the nudge) — killProofNudge certifies without the new-case requirement
		const { hit, nudge } = await stopAndNudge(OLD_CASE, OLD_CASE + weak("kills boundary"), { "caps at max": true, "kills boundary": false });
		expect(hit?.staleMeasurement).toBe(true); // precondition: the Stop check (K4 fix) refuses this receipt
		expect(nudge).not.toBeNull();
	});

	// POLICY (review L6): a binder-level early error needs a program; vitest's transpiler runs such code too, so the
	// runtime failure is what the tests observe. Documented, kept as a todo.
	it.todo("N11 (policy): a replacement with an early error the transpiler accepts (`let` redeclared) is not a kill", async () => {
		// review L6 (K5 bypass) — transpileModule reports no syntax error; esbuild refuses the module at load
		const root = realRepo({ "test/catch.test.ts": IMPORT_CHECK, "src/plain.js": PLAIN_JS });
		const spec = { kind: "explicit", file: "src/math.ts", find: "return a + b;", replace: "let q = 1; let q = 2; return a + b;" } as const;
		const result = await proveKill({ root, spec, tests: ["test/catch.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).not.toBe("killed");
	}, REAL_RUN_MS);

	it("N12: JSX written into a .js file is not a kill", async () => {
		// review L6 (K5 bypass) — the TypeScript parser reads .js as JSX-capable; vite's .js loader does not
		const root = realRepo({ "test/catch.test.ts": IMPORT_CHECK, "src/plain.js": PLAIN_JS });
		const spec = { kind: "explicit", file: "src/plain.js", find: "return s;", replace: "return <b>{s}</b>;" } as const;
		const result = await proveKill({ root, spec, tests: ["test/catch.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).not.toBe("killed");
	}, REAL_RUN_MS);

	// POLICY (review L7): neither prove-kill nor vitest type-checks; a mutant that type-fails but runs is judged by the
	// tests like any other. Documented, kept as a todo.
	it.todo("N13 (policy): a replacement that parses but fails the type check is not a kill", async () => {
		// review L7 — `return String(a + b)` in a `: number` function is a compile error (TS2322), not a reachable mutant
		const root = realRepo({ "test/val.test.ts": 'import { expect, it } from "vitest";\nimport { add } from "../src/math";\nit("adds", () => { expect(add(1, 2)).toBe(3); });\n' });
		const spec = { kind: "explicit", file: "src/math.ts", find: "return a + b;", replace: "return String(a + b);" } as const;
		const result = await proveKill({ root, spec, tests: ["test/val.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).not.toBe("killed");
	}, REAL_RUN_MS);

	it("N14: a baseline failure re-checked on the live tree does not write into the live tree", async () => {
		// review L8 (K6) — the "read only" live re-run executes the tests in the live tree; their writes land there
		const test = [
			'import { existsSync, writeFileSync } from "node:fs";',
			'import { join } from "node:path";',
			'import { expect, it } from "vitest";',
			'it("needs a warm cache", () => {',
			'\tconst cache = join(__dirname, "..", ".cache-add.json");',
			"\tconst warm = existsSync(cache);",
			'\twriteFileSync(cache, "{}");',
			"\texpect(warm).toBe(true);",
			"});",
			"",
		].join("\n");
		const root = realRepo({ "test/warm.test.ts": test }, { ".gitignore": "node_modules\n.interlinked\n.cache-add.json\n" });
		await proveKill({ root, spec: MINUS_FAULT, tests: ["test/warm.test.ts"], budgetMs: 60_000, persist: false });
		expect(existsSync(join(root, ".cache-add.json"))).toBe(false);
	}, REAL_RUN_MS);
});

describe("kill proof round 3 — positive (a real situation must not be misreported)", () => {
	const ADDS = (from: string) => `import { expect, it } from "vitest";\nimport { add } from ${JSON.stringify(from)};\nit("adds", () => { expect(add(1, 2)).toBe(3); });\n`;

	it("P1: an in-repo test that imports the source by ABSOLUTE path is not reported SURVIVED", async () => {
		// review L9 (K8b) — the absolute path names the live, unmutated file from inside the copy
		const root = realRepo({});
		mkdirSync(join(root, "test"), { recursive: true });
		writeFileSync(join(root, "test/abs.test.ts"), ADDS(join(root, "src/math")));
		execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
		const result = await proveKill({ root, spec: MINUS_FAULT, tests: ["test/abs.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).not.toBe("survived");
	}, REAL_RUN_MS);

	it("P2: an in-repo test that imports through an absolute symlinked directory is not reported SURVIVED", async () => {
		// review L9 (K8b) — `lib -> <root>/src` is copied as the same absolute link, back into the live tree
		const root = realRepo({ "test/viadir.test.ts": ADDS("../lib/math") });
		symlinkSync(join(root, "src"), join(root, "lib"));
		execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
		const result = await proveKill({ root, spec: MINUS_FAULT, tests: ["test/viadir.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).not.toBe("survived");
	}, REAL_RUN_MS);

	it("P3: a named test that is an absolute symlink to an in-repo test is not reported SURVIVED", async () => {
		// review L9 (K8b/K14) — testFileProblem accepts it (realpath is inside the root); the copy's link runs the live file
		const root = realRepo({ "test/real.test.ts": ADDS("../src/math") });
		symlinkSync(join(root, "test/real.test.ts"), join(root, "test/alias.test.ts"));
		execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
		const result = await proveKill({ root, spec: MINUS_FAULT, tests: ["test/alias.test.ts"], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).not.toBe("survived");
	}, REAL_RUN_MS);
});
