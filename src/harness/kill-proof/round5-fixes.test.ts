// Kill proof — pins for the round-5 fixes (docs/reviews/kill-proof-review-round5.md, Resolution table).
// The review's own red cases live in review-regressions-round5.test.ts; these pin the MECHANISM each fix
// relies on so a later refactor cannot remove it silently. Receipt and closure cases use a scripted runner
// (no vitest, fast); the two CLI cases run the real command through tsx in a throwaway git repo whose
// node_modules links to this checkout's.

import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { INTERRUPTED_NOTICE, PROVE_KILL_EXIT } from "../../commands/tests-prove-kill.js";
import type { VitestRun } from "../fail-before-fix/index.js";
import { allocatedBytes, createProjectCopy } from "../fail-before-fix/snapshot.js";
import { boundImportClosure, boundImportClosureDetailed, factorylessMockSpecifiers, MAX_BOUND_IMPORTS } from "./bound-imports.js";
import { parseKillProof, receiptId, sealReceipt } from "./receipt.js";
import { CLOSURE_TRUNCATED_REASON, integrityReasons, receiptCertifies, verifyKillProof } from "./receipt-freshness.js";
import { COPY_BUDGET_BYTES, copySizeWarning, proveKill } from "./run.js";
import type { KillProofReceipt } from "./types.js";

const CHECKOUT = fileURLToPath(new URL("../../..", import.meta.url));
const NODE_MODULES = join(CHECKOUT, "node_modules");
const TSX = join(NODE_MODULES, "tsx", "dist", "cli.mjs");
const REAL_RUN_MS = 120_000;
const roots: string[] = [];
const strays: string[] = [];
const uniq = (): string => `${process.pid}${Date.now()}${Math.floor(Math.random() * 1e6)}`;

const SOURCE = "// helper: add two numbers\nexport function add(a: number, b: number): number {\n\treturn a + b;\n}\n";
const MINUS_FAULT = { kind: "explicit", file: "src/math.ts", find: "return a + b;", replace: "return a - b;" } as const;
const DEFAULT_CONFIG = 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["test/**/*.test.ts"] } });\n';
const TEST = "test/k.test.ts";

function makeRepo(files: Record<string, string>, config = DEFAULT_CONFIG): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-r5fix-")));
	roots.push(root);
	execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
	const all: Record<string, string> = { ".gitignore": "node_modules\n.interlinked\n", "package.json": '{"name":"fx","type":"module"}\n', "vitest.config.ts": config, "src/math.ts": SOURCE, ...files };
	for (const [path, text] of Object.entries(all)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), text.replaceAll("<ROOT>", root));
	}
	symlinkSync(NODE_MODULES, join(root, "node_modules"));
	execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	for (const path of strays.splice(0)) rmSync(path, { force: true });
});

const tempDirs = (prefix: string): number => readdirSync(tmpdir()).filter(name => name.startsWith(prefix)).length;
const CLI_EXITS = new Set<number | null>(Object.values(PROVE_KILL_EXIT));

/** `tests prove-kill` through the tsx source entry (the built CLI needs a build this container cannot always afford). */
function proveKillCli(root: string, args: string[], timeout = 90_000) {
	return spawnSync(process.execPath, [TSX, join(CHECKOUT, "src", "index.ts"), "tests", "prove-kill", "--cwd", root, ...args], { encoding: "utf8", timeout });
}

// ---- R5-1: a timed-out run ends in a verdict, leaves nothing behind, and exits inside the documented set -----------
describe("R5-1 — a timed-out vitest run settles the proof instead of draining the event loop", () => {
	it("P1: `--run-timeout` below the test's duration gives a JSON verdict, exit 2, and leaves no copy and no report directory", () => {
		const root = makeRepo({ "test/slow.test.ts": 'import { expect, it } from "vitest";\nimport { add } from "../src/math";\nit("slow", async () => { await new Promise(r => setTimeout(r, 6000)); expect(add(1, 2)).toBe(3); }, 30000);\n' });
		const copiesBefore = tempDirs("interlinked-fail-before-fix-"), reportsBefore = tempDirs("interlinked-fbf-report-");
		const run = proveKillCli(root, ["--test", "test/slow.test.ts", "--file", MINUS_FAULT.file, "--find", MINUS_FAULT.find, "--replace", MINUS_FAULT.replace, "--run-timeout", "2000", "--json"]);
		expect(run.stderr).not.toContain("unsettled top-level await");
		expect(CLI_EXITS.has(run.status)).toBe(true);
		expect(run.status).toBe(PROVE_KILL_EXIT.undecided);
		expect(run.stdout).toMatch(/"verdict": "(unavailable|inconclusive)"/);
		expect(run.stdout).toMatch(/timed out after \d+ ms/);
		expect(tempDirs("interlinked-fail-before-fix-")).toBe(copiesBefore);
		expect(tempDirs("interlinked-fbf-report-")).toBe(reportsBefore);
	}, REAL_RUN_MS);
});

// ---- R5-7: the supervisor's --timeout SIGTERM lets the proof clean up, then exits 75 --------------------------------
describe("R5-7 — SIGTERM from the supervisor's --timeout is handled: copies removed, exit 75, no verdict", () => {
	it("P1: `--timeout` below the baseline: the child reports the interruption, the test's marker never appears, nothing leaks, exit 75", () => {
		const marker = join(tmpdir(), `kp-r5-marker-${uniq()}`);
		strays.push(marker);
		const root = makeRepo({ "test/slow.test.ts": `import { writeFileSync } from "node:fs";\nimport { expect, it } from "vitest";\nimport { add } from "../src/math";\nit("slow", async () => { await new Promise(r => setTimeout(r, 6000)); writeFileSync(${JSON.stringify(marker)}, "escaped"); expect(add(1, 2)).toBe(3); }, 30000);\n` });
		const copiesBefore = tempDirs("interlinked-fail-before-fix-"), reportsBefore = tempDirs("interlinked-fbf-report-");
		const run = proveKillCli(root, ["--test", "test/slow.test.ts", "--file", MINUS_FAULT.file, "--find", MINUS_FAULT.find, "--replace", MINUS_FAULT.replace, "--timeout", "3000", "--json"]);
		expect(run.status).toBe(PROVE_KILL_EXIT.interrupted);
		expect(run.stderr).toContain(INTERRUPTED_NOTICE);
		expect(run.stderr).not.toContain("unsettled top-level await");
		expect(run.stdout).not.toMatch(/"verdict"/);
		expect(existsSync(marker)).toBe(false);
		expect(tempDirs("interlinked-fail-before-fix-")).toBe(copiesBefore);
		expect(tempDirs("interlinked-fbf-report-")).toBe(reportsBefore);
		expect(existsSync(join(root, ".interlinked", "test-runs", "kill-proofs"))).toBe(false);
	}, REAL_RUN_MS);
});

// ---- R5-3: a cut closure is visible on the receipt and never certifies ----------------------------------------------
const scriptedKill = async (dir: string): Promise<VitestRun> => {
	const unmutated = readFileSync(join(dir, "src/math.ts"), "utf8") === SOURCE;
	return { cases: [{ file: TEST, name: "adds", title: "adds", status: unmutated ? "passed" : "failed", ...(unmutated ? {} : { message: "AssertionError: expected -1 to be 3" }) }], timedOut: false, exitCode: unmutated ? 0 : 1, durationMs: 1 };
};
async function killedReceipt(root: string): Promise<KillProofReceipt> {
	const result = await proveKill({ root, spec: MINUS_FAULT, tests: [TEST], budgetMs: 1_000, runner: scriptedKill });
	if (!result.ok || result.receipt.verdict !== "killed") throw new Error(`precondition: expected a killed receipt, got ${JSON.stringify(result)}`);
	return result.receipt;
}
function chainRepo(depth: number): string {
	const files: Record<string, string> = { [TEST]: 'import { expect, it } from "vitest";\nimport { add } from "../src/math";\nimport { DEEP } from "../chain/c0";\nit("adds", () => { expect(add(1, 2)).toBe(DEEP); });\n' };
	for (let i = 0; i < depth - 1; i++) files[`chain/c${i}.ts`] = `export * from "./c${i + 1}";\n`;
	files[`chain/c${depth - 1}.ts`] = "export const DEEP = 3;\n";
	return makeRepo(files);
}

describe("R5-3 — the bound-import cap is recorded, and a truncated closure certifies nothing", () => {
	it("P1: a closure cut at the cap reports `truncated: true`; one inside the cap reports false", () => {
		const root = chainRepo(8);
		expect(boundImportClosureDetailed(root, [TEST], "src/math.ts", { cap: 3 })).toMatchObject({ truncated: true });
		expect(boundImportClosureDetailed(root, [TEST], "src/math.ts", { cap: 3 }).files).toHaveLength(3);
		expect(boundImportClosureDetailed(root, [TEST], "src/math.ts")).toMatchObject({ truncated: false });
		expect(boundImportClosure(root, [TEST], "src/math.ts")).toHaveLength(8);
	});
	it("P2: the receipt of a cut closure carries `boundImportsTruncated: true`, is STALE to --verify and uncertified to the Stop check, with the reason naming the cap — before any edit", async () => {
		const root = chainRepo(MAX_BOUND_IMPORTS + 5);
		const receipt = await killedReceipt(root);
		expect(receipt.boundImports).toHaveLength(MAX_BOUND_IMPORTS);
		expect(receipt.boundImportsTruncated).toBe(true);
		expect(JSON.parse(readFileSync(join(root, ".interlinked/test-runs/kill-proofs", `${receipt.id}.json`), "utf8"))).toMatchObject({ boundImportsTruncated: true });
		expect(integrityReasons(root, receipt)).toEqual([CLOSURE_TRUNCATED_REASON]);
		expect(CLOSURE_TRUNCATED_REASON).toMatch(/^bound-import closure truncated at 200 files/);
		expect(verifyKillProof(root, receipt)).toEqual({ fresh: false, reasons: [CLOSURE_TRUNCATED_REASON] });
		const certification = receiptCertifies(root, receipt.id, TEST);
		expect(certification.certified).toBe(false);
		expect(!certification.certified && certification.reasons).toEqual([CLOSURE_TRUNCATED_REASON]);
	});
	it("P3: a complete closure carries no flag, and the flag is part of the receipt id", async () => {
		const root = chainRepo(3);
		const receipt = await killedReceipt(root);
		expect("boundImportsTruncated" in receipt).toBe(false);
		expect(integrityReasons(root, receipt)).toEqual([]);
		const { source, mutant, tests, boundImports, environment } = receipt;
		expect(receiptId({ source, mutant, tests, boundImports, environment })).toBe(receipt.id);
		expect(receiptId({ source, mutant, tests, boundImports, boundImportsTruncated: true, environment })).not.toBe(receipt.id);
	});
	it("N1: the flag is either absent or exactly `true` — any other value is not a receipt", async () => {
		const root = chainRepo(3);
		const receipt = await killedReceipt(root);
		const sealed = (extra: Record<string, unknown>) => JSON.parse(JSON.stringify(sealReceipt({ ...receipt, ...extra } as KillProofReceipt)));
		expect(parseKillProof(sealed({ boundImportsTruncated: false }))).toBeNull();
		expect(parseKillProof(sealed({ boundImportsTruncated: "yes" }))).toBeNull();
		expect(parseKillProof(sealed({ boundImportsTruncated: 1 }))).toBeNull();
		expect(parseKillProof(sealed({}))).not.toBeNull();
	});
});

// ---- R5-4: the `__mocks__` twin of a factory-less vi.mock is bound ---------------------------------------------------
describe("R5-4 — factory-less vi.mock / vi.doMock targets bind their `__mocks__` twin", () => {
	it("P1: `vi.mock('./helpers/check')` binds `helpers/__mocks__/check.ts` (and walks its imports); a bare specifier binds `<root>/__mocks__/<name>`", () => {
		const root = makeRepo({
			[TEST]: 'import { expect, it, vi } from "vitest";\nimport { add } from "../src/math";\nimport { check } from "./helpers/check";\nimport { p } from "pkg";\nvi.mock("./helpers/check");\nvi.doMock("pkg");\nit("adds", () => { expect(check(add(1, 2))).toBe(p); });\n',
			"test/helpers/check.ts": "export function check(v: number): boolean { return v === 3; }\n",
			"test/helpers/__mocks__/check.ts": 'import { THREE } from "../three";\nexport function check(v: number): boolean { return v === THREE; }\n',
			"test/helpers/three.ts": "export const THREE = 3;\n",
			"__mocks__/pkg.ts": "export const p = true;\n",
		});
		const bound = boundImportClosureDetailed(root, [TEST], "src/math.ts");
		expect(bound.truncated).toBe(false);
		expect(bound.files.map(file => [file.path, file.importedBy])).toEqual([
			["__mocks__/pkg.ts", [TEST]],
			["test/helpers/__mocks__/check.ts", [TEST]],
			["test/helpers/check.ts", [TEST]],
			["test/helpers/three.ts", [TEST]],
		]);
	});
	it("P2: the specifier parser takes only factory-less calls", () => {
		expect(factorylessMockSpecifiers('vi.mock("./a");\nvi.doMock(\'./b\')\nvi.mock("./c", () => ({}));\nvi.mock("./d", { spy: true });\nvi.unmock("./e");')).toEqual(["./a", "./b"]);
	});
	it("N1: a mock with a factory, or one whose twin does not exist, binds no twin", () => {
		const root = makeRepo({
			[TEST]: 'import { expect, it, vi } from "vitest";\nimport { add } from "../src/math";\nimport { check } from "./helpers/check";\nvi.mock("./helpers/check", () => ({ check: () => true }));\nvi.mock("./helpers/other");\nit("adds", () => { expect(check(add(1, 2))).toBe(true); });\n',
			"test/helpers/check.ts": "export function check(v: number): boolean { return v === 3; }\n",
			"test/helpers/__mocks__/check.ts": "export function check(): boolean { return false; }\n",
		});
		expect(boundImportClosure(root, [TEST], "src/math.ts").map(file => file.path)).toEqual(["test/helpers/check.ts"]);
	});
});

// ---- R5-5: setup-file closures are bound for every named test --------------------------------------------------------
describe("R5-5 — the import closure of setupFiles / globalSetup is bound, credited to every named test", () => {
	it("P1: a helper reached only through a global root carries every test in `importedBy`; the root itself is never listed", () => {
		const A = "test/a.test.ts", B = "test/b.test.ts";
		const root = makeRepo({
			[A]: 'import { expect, it } from "vitest";\nimport { add } from "../src/math";\nimport { THREE } from "./helpers/three";\nit("a", () => { expect(add(1, 2)).toBe(THREE); });\n',
			[B]: 'import { expect, it } from "vitest";\nimport { add } from "../src/math";\nit("b", () => { expect(add(1, 2)).toBeThree(); });\n',
			"test/setup.ts": 'import "./helpers/matchers";\nimport { THREE } from "./helpers/three";\nexport const seen = THREE;\n',
			"test/helpers/matchers.ts": 'import { expect } from "vitest";\nexpect.extend({ toBeThree(v: number) { return { pass: v === 3, message: () => "" }; } });\n',
			"test/helpers/three.ts": "export const THREE = 3;\n",
		});
		const bound = boundImportClosureDetailed(root, [A, B], "src/math.ts", { globalRoots: ["test/setup.ts"] });
		expect(bound.files.map(file => [file.path, file.importedBy])).toEqual([
			["test/helpers/matchers.ts", [A, B]],
			["test/helpers/three.ts", [A, B]],
		]);
		expect(bound.files.map(file => file.path)).not.toContain("test/setup.ts");
	});
	it("P2: a real proof binds the setup file's helper so editing it stales the receipt through both readers", async () => {
		const config = 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] } });\n';
		const root = makeRepo({
			[TEST]: 'import { expect, it } from "vitest";\nimport { add } from "../src/math";\nit("adds", () => { expect(add(1, 2)).toBeThree(); });\n',
			"test/setup.ts": 'import "./helpers/matchers";\n',
			"test/helpers/matchers.ts": 'import { expect } from "vitest";\nexpect.extend({ toBeThree(v: number) { return { pass: v === 3, message: () => "not three" }; } });\n',
		}, config);
		const receipt = await killedReceipt(root);
		expect(receipt.environment.setupFiles.map(file => file.path)).toEqual(["test/setup.ts"]);
		expect(receipt.boundImports.map(file => [file.path, file.importedBy])).toEqual([["test/helpers/matchers.ts", [TEST]]]);
		writeFileSync(join(root, "test/helpers/matchers.ts"), 'import { expect } from "vitest";\nexpect.extend({ toBeThree() { return { pass: true, message: () => "" }; } });\n');
		expect(verifyKillProof(root, receipt)).toEqual({ fresh: false, reasons: ["helper test/helpers/matchers.ts changed since the proof"] });
		expect(receiptCertifies(root, receipt.id, TEST).certified).toBe(false);
	});
});

// ---- R5-10: a control stand-in that never ran is named as such, not blamed on a setup file ---------------------------
describe("R5-10 — a stand-in case filtered out of the control run yields a reason that names the filter", () => {
	it("P1: when the control copy reports the stand-in as skipped (testNamePattern), the reason says it did not run and never mentions a setup file", async () => {
		const CANARY = "kill-proof canary";
		const runner = async (dir: string): Promise<VitestRun> => {
			const source = readFileSync(join(dir, "src/math.ts"), "utf8");
			const test = readFileSync(join(dir, TEST), "utf8");
			if (test.includes("kill-proof control")) return { cases: [{ file: TEST, name: "kill-proof control (prove-kill): the environment alone must not fail this case", title: "control", status: "skipped" }], timedOut: false, exitCode: 0, durationMs: 1 };
			if (source.includes(CANARY)) return { cases: [{ file: TEST, name: "adds", title: "adds", status: "failed", message: "Error: kill-proof canary" }], timedOut: false, exitCode: 1, durationMs: 1 };
			return { cases: [{ file: TEST, name: "adds", title: "adds", status: "passed" }], timedOut: false, exitCode: 0, durationMs: 1 };
		};
		// The test reaches the source through an alias only, so the control copy decides attribution.
		const root = makeRepo({ [TEST]: 'import { expect, it } from "vitest";\nimport { add } from "@src/math";\nit("adds", () => { expect(add(1, 2)).toBe(3); });\n' });
		const result = await proveKill({ root, spec: MINUS_FAULT, tests: [TEST], budgetMs: 1_000, runner, persist: false });
		expect(result.ok).toBe(false);
		expect(!result.ok && result.verdict).toBe("unavailable");
		const reasons = !result.ok ? result.reasons : [];
		expect(reasons[0]).toMatch(/^the control copy's stand-in case for test\/k\.test\.ts did not run \(a test-name filter — vitest's testNamePattern/);
		expect(reasons.join("\n")).not.toMatch(/setup file/);
	});
});

// ---- R5-12: the copy budget reads allocated size -------------------------------------------------------------------
describe("R5-12 — the copy-size budget counts allocated blocks, not apparent size", () => {
	it("P1: a sparse file truncated past the budget occupies nothing and does not warn", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-r5-sparse-")));
		roots.push(root);
		const fd = openSync(join(root, "blob.bin"), "w");
		ftruncateSync(fd, COPY_BUDGET_BYTES + 1024 * 1024);
		closeSync(fd);
		writeFileSync(join(root, "real.txt"), "x".repeat(4096));
		const copy = createProjectCopy(root, ["blob.bin", "real.txt"], new Map());
		try {
			expect(copy.bytes).toBeLessThan(1024 * 1024);
			expect(copy.bytes).toBeGreaterThanOrEqual(4096);
			expect(copySizeWarning(copy.bytes)).toBeNull();
		} finally {
			copy.cleanup();
		}
	});
	it("P2: allocatedBytes falls back to the apparent size where no block count exists (Windows)", () => {
		expect(allocatedBytes({ size: 10, blocks: 8 })).toBe(4096);
		expect(allocatedBytes({ size: 10 })).toBe(10);
		expect(allocatedBytes({ size: 10, blocks: Number.NaN })).toBe(10);
	});
});
