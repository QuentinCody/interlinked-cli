import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileMutationLockPath, withFileMutationLock } from "../../lib/file-mutation-lock.js";
import type { VitestRun } from "../fail-before-fix/index.js";
import { boundImportClosure, MAX_BOUND_IMPORTS } from "./bound-imports.js";
import { freshKillsForTest, killProofsDir, parseKillProof, readKillProofIndex, receiptCertifies, receiptFreshCheap, verifyKillProof, writeKillProof } from "./receipt.js";
import { proveKill } from "./run.js";
import type { KillProofReceipt } from "./types.js";

const SOURCE = "export function clamp(n: number, max: number): number {\n\treturn n > max ? max : n;\n}\n";
const A = "src/a.test.ts", B = "src/b.test.ts";
const SPEC = { kind: "explicit", file: "src/clamp.ts", find: "n > max", replace: "n >= max" } as const;

let root: string;
const git = (...args: string[]): void => void execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
function write(path: string, text: string): void {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), text);
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-bind-")));
	git("init", "-q");
	write("src/clamp.ts", SOURCE);
	// helper.ts → deep.ts (transitive) and → clamp.ts (the mutated source: never listed).
	write("src/helper.ts", "import { clamp } from './clamp.js';\nimport { limit } from './deep.js';\nexport const capped = (n: number) => clamp(n, limit);\n");
	write("src/deep.ts", "export const limit = 3;\n");
	write("src/only-b.ts", "export const extra = 1;\n");
	write("src/types.ts", "export interface Shape { n: number }\n");
	write(A, "import type { Shape } from './types.js';\nimport { capped } from './helper.js';\nit('caps', () => { const s: Shape = { n: 5 }; expect(capped(s.n)).toBe(3); });\n");
	write(B, "import { clamp } from './clamp.js';\nimport { extra } from './only-b.js';\nit('caps b', () => { expect(clamp(5, 3 + extra - 1)).toBe(3); });\n");
	git("add", ".");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Case = VitestRun["cases"][number];
const run = (cases: Case[]): VitestRun => ({ cases, timedOut: false, exitCode: 0, durationMs: 10 });
const pass = (file: string, name: string): Case => ({ file, name, title: name, status: "passed" });
const fail = (file: string, name: string): Case => ({ file, name, title: name, status: "failed", message: "AssertionError: expected 5 to be 3" });

/** Baseline: both pass. Mutant: both fail by assertion. Canary: everything fails (the tests load the copy's file). */
async function provenKill(): Promise<KillProofReceipt> {
	const baseline = run([pass(A, "caps"), pass(B, "caps b")]);
	const runner = async (dir: string): Promise<VitestRun> => {
		const source = readFileSync(join(dir, "src/clamp.ts"), "utf8");
		return source === SOURCE ? baseline : run([fail(A, "caps"), fail(B, "caps b")]);
	};
	const result = await proveKill({ root, spec: SPEC, tests: [A, B], budgetMs: 1000, runner });
	if (!result.ok) throw new Error(`expected a receipt: ${result.reasons.join("; ")}`);
	return result.receipt;
}

describe("bound imports — positive (must fire)", () => {
	it("P1: the receipt binds the transitive local closure with the tests that reach each file", async () => {
		const receipt = await provenKill();
		expect(receipt.boundImports.map(file => [file.path, file.importedBy])).toEqual([
			["src/deep.ts", [A]], ["src/helper.ts", [A]], ["src/only-b.ts", [B]],
		]);
		expect(receipt.boundImports.every(file => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
	});

	it("P2: a helper edit stales the certification of the test that imports it, the cheap check and --verify", async () => {
		const receipt = await provenKill();
		expect(receiptCertifies(root, receipt.id, A).certified).toBe(true);
		write("src/deep.ts", "export const limit = 99;\n");
		const cert = receiptCertifies(root, receipt.id, A);
		expect(cert.certified).toBe(false);
		expect(!cert.certified && cert.reasons).toContain("helper src/deep.ts changed since the proof");
		expect(freshKillsForTest(root, A)).toEqual([]);
		expect(receiptFreshCheap(root, receipt.id)?.reasons).toEqual(["helper src/deep.ts changed since the proof"]);
		expect(verifyKillProof(root, receipt)).toEqual({ fresh: false, reasons: ["helper src/deep.ts changed since the proof"] });
	});

	it("P3: a helper edit stales ONLY the tests that import it (per-file certification, K13)", async () => {
		const receipt = await provenKill();
		write("src/only-b.ts", "export const extra = 2;\n");
		expect(receiptCertifies(root, receipt.id, B).certified).toBe(false);
		expect(receiptCertifies(root, receipt.id, A).certified).toBe(true);
	});

	it("P4: a deleted helper is named as missing", async () => {
		const receipt = await provenKill();
		rmSync(join(root, "src/helper.ts"));
		expect(verifyKillProof(root, receipt)).toEqual({ fresh: false, reasons: ["helper src/helper.ts no longer exists"] });
	});

	it("P5: re-exports are followed (`export … from`)", () => {
		write("src/barrel.ts", "export { limit } from './deep.js';\nexport * from './only-b.js';\n");
		write("src/c.test.ts", "import { limit } from './barrel.js';\nit('x', () => expect(limit).toBe(3));\n");
		expect(boundImportClosure(root, ["src/c.test.ts"], "src/clamp.ts").map(file => file.path)).toEqual(["src/barrel.ts", "src/deep.ts", "src/only-b.ts"]);
	});
});

describe("bound imports — negative (must not fire)", () => {
	it("N1: a type-only import is not bound, and editing it does not stale the proof", async () => {
		const receipt = await provenKill();
		expect(receipt.boundImports.map(file => file.path)).not.toContain("src/types.ts");
		write("src/types.ts", "export interface Shape { n: number; m?: string }\n");
		expect(verifyKillProof(root, receipt)).toEqual({ fresh: true });
	});

	it("N2: the mutated source is never listed as a helper, even when a helper imports it", async () => {
		const receipt = await provenKill();
		expect(receipt.boundImports.map(file => file.path)).not.toContain("src/clamp.ts");
		expect(boundImportClosure(root, [A, B], "src/clamp.ts").map(file => file.path)).not.toContain("src/clamp.ts");
	});

	it("N3: the cap holds — a 250-file import chain binds exactly MAX_BOUND_IMPORTS files", () => {
		for (let i = 0; i < 250; i++) write(`src/chain/m${i}.ts`, `import { v as w } from './m${i + 1}.js';\nexport const v = ${i} + w;\n`);
		write("src/chain/m250.ts", "export const v = 0;\n");
		write("src/chain.test.ts", "import { v } from './chain/m0.js';\nit('x', () => expect(v).toBeGreaterThan(0));\n");
		const bound = boundImportClosure(root, ["src/chain.test.ts"], "src/clamp.ts");
		expect(MAX_BOUND_IMPORTS).toBe(200);
		expect(bound).toHaveLength(MAX_BOUND_IMPORTS);
		expect(boundImportClosure(root, ["src/chain.test.ts"], "src/clamp.ts", 5)).toHaveLength(5);
	});

	it("N4: dynamic import(), require(), vi.mock targets, bare specifiers and node_modules are not followed", () => {
		write("src/dyn.ts", "export const d = 1;\n");
		write("src/req.ts", "module.exports = 1;\n");
		write("src/mocked.ts", "export const m = 1;\n");
		write("node_modules/pkg/index.js", "export const p = 1;\n");
		write("src/d.test.ts", [
			"import { p } from 'pkg';",
			"import { q } from '../node_modules/pkg/index.js';",
			"vi.mock('./mocked.js', () => ({ m: 2 }));",
			"const r = require('./req.js');",
			"it('x', async () => { const { d } = await import('./dyn.js'); expect(d + p + q + r).toBe(4); });",
		].join("\n"));
		expect(boundImportClosure(root, ["src/d.test.ts"], "src/clamp.ts")).toEqual([]);
	});

	it("N5: an older receipt without `boundImports` is invalid, not defaulted to empty", async () => {
		const { boundImports: _dropped, ...older } = await provenKill();
		expect(parseKillProof(JSON.parse(JSON.stringify(older)))).toBeNull();
		expect(parseKillProof({ ...older, boundImports: [{ path: "src/deep.ts", sha256: "x" }] })).toBeNull();
	});

	it("N6: another named test is not listed as a helper of the test that imports it", () => {
		write(A, `import { capped } from './helper.js';\nimport './b.test.js';\nit('caps', () => expect(capped(5)).toBe(3));\n`);
		expect(boundImportClosure(root, [A, B], "src/clamp.ts").map(file => file.path)).not.toContain(B);
	});
});

/** A sealed-shape receipt with a distinct id; the index only parses receipts, it does not check integrity. */
const withId = (base: KillProofReceipt, n: number): KillProofReceipt => ({ ...base, id: n.toString(16).padStart(16, "0") });

describe("index rebuild under a lock (K12) — positive (must fire)", () => {
	it("P6: 20 concurrent writeKillProof calls leave an index with 20 rows", async () => {
		const base = await provenKill();
		rmSync(killProofsDir(root), { recursive: true, force: true });
		await Promise.all(Array.from({ length: 20 }, async (_, i) => writeKillProof(root, withId(base, i + 1))));
		expect(readKillProofIndex(root).receipts.map(row => row.id)).toHaveLength(20);
	});

	it("P7: 4 writer PROCESSES × 5 receipts each leave an index with 20 rows", async () => {
		const base = await provenKill();
		rmSync(killProofsDir(root), { recursive: true, force: true });
		const template = join(root, "template.json");
		writeFileSync(template, JSON.stringify(base));
		const receiptModule = resolve(import.meta.dirname, "receipt.ts");
		const script = `const { writeKillProof } = await import(${JSON.stringify(receiptModule)});
const base = JSON.parse((await import("node:fs")).readFileSync(process.argv[1], "utf8"));
const w = Number(process.argv[2]);
for (let i = 0; i < 5; i++) writeKillProof(process.argv[3], { ...base, id: (w * 5 + i + 1).toString(16).padStart(16, "0") });`;
		const exec = promisify(execFile);
		await Promise.all([0, 1, 2, 3].map(w => exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, template, String(w), root], { cwd: resolve(import.meta.dirname, "../../..") })));
		expect(readKillProofIndex(root).receipts).toHaveLength(20);
	}, 60_000);
});

describe("index rebuild under a lock (K12) — negative (must not fire)", () => {
	it("N7: a held index lock does not throw or lose the receipt; the next writer's rebuild lists it", async () => {
		const base = await provenKill();
		const indexPath = join(killProofsDir(root), "index.json");
		const before = readFileSync(indexPath, "utf8");
		const held = withId(base, 0xabc);
		withFileMutationLock(indexPath, () => {
			expect(() => writeKillProof(root, held)).not.toThrow();
		});
		expect(readFileSync(join(killProofsDir(root), `${held.id}.json`), "utf8")).toContain(held.id);
		expect(readFileSync(indexPath, "utf8")).toBe(before);
		writeKillProof(root, withId(base, 0xabd));
		expect(readKillProofIndex(root).receipts.map(row => row.id)).toEqual(expect.arrayContaining([held.id, base.id, withId(base, 0xabd).id]));
		expect(existsSync(fileMutationLockPath(indexPath))).toBe(false);
	});
});
