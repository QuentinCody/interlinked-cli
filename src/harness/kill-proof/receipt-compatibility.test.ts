import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listKillProofs } from "../../commands/tests-prove-kill.js";
import { killProofNudge } from "../evaluator/post-tool-kill-proof.js";
import type { VitestRun } from "../fail-before-fix/index.js";
import { certifyCases, freshKillsForTest, verifyKillProof } from "./receipt-freshness.js";
import { parseKillProof, readKillProof, receiptId, sealReceipt, writeKillProof } from "./receipt.js";
import { proveKill } from "./run.js";
import type { CaseRequirement } from "./source-cases.js";
import type { KillProofReceipt } from "./types.js";

const FILE = "src/clamp.js", TEST = "src/clamp.mutation-kill.test.js", HELPER = "src/bounds.js";
const SOURCE = "import { LO, HI } from './bounds.js';\nexport function clamp(n, lo = LO, hi = HI) { if (n < lo) return lo; if (n > hi) return hi; return n; }\n";
const FAMILY: CaseRequirement = { kind: "prefix", prefix: "bounds ", source: "bounds %i" };
let root: string;
let cases: Array<{ name: string; input: number; expected: number }>;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-compat-")));
	execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, FILE), SOURCE);
	writeFileSync(join(root, HELPER), "export const LO = 0, HI = 9;\n");
	writeFileSync(join(root, TEST), "import { clamp } from './clamp.js';\nit.each([[-1, 0], [10, 9]])('bounds %i', (n, result) => { expect(clamp(n)).toBe(result); });\n");
	cases = [{ name: "bounds -1", input: -1, expected: 0 }, { name: "bounds 10", input: 10, expected: 9 }];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Run the copied implementation on the table inputs; report its actual comparisons through the runner seam. */
async function runner(dir: string): Promise<VitestRun> {
	const helper = readFileSync(join(dir, HELPER), "utf8").replace("export const", "const");
	const source = readFileSync(join(dir, FILE), "utf8").replace("import { LO, HI } from './bounds.js';", helper).replace("export function", "function");
	const clamp = new Function(`${source}\nreturn clamp;`)() as (n: number) => number;
	const rows: VitestRun["cases"] = cases.map(({ name, input, expected }) => {
		const actual = clamp(input);
		return actual === expected ? { file: TEST, name, title: name, status: "passed" } : {
			file: TEST, name, title: name, status: "failed", message: `AssertionError: expected ${actual} to be ${expected}`,
		};
	});
	return { cases: rows, timedOut: false, exitCode: rows.some(row => row.status === "failed") ? 1 : 0, durationMs: 1 };
}

async function prove(find: string, persist = true): Promise<KillProofReceipt> {
	const result = await proveKill({ root, spec: { kind: "explicit", file: FILE, find, replace: "false" }, tests: [TEST], budgetMs: 1000, runner, persist });
	if (!result.ok) throw new Error(result.reasons.join("; "));
	expect(result.receipt.verdict).toBe("killed");
	return result.receipt;
}

function oldReceipt(current: KillProofReceipt): KillProofReceipt {
	const legacy = { ...current, version: 1 as const, boundImports: [], provedAt: "2020-01-01T00:00:00.000Z" };
	return sealReceipt({ ...legacy, id: receiptId(legacy) });
}

describe("proof protocol compatibility", () => {
	it("keeps legacy receipts readable but refuses their incomplete provenance until a fresh proof supersedes them", async () => {
		const current = await prove("n < lo", false);
		const legacy = oldReceipt(current);
		writeKillProof(root, legacy);
		expect(readKillProof(root, legacy.id)).toEqual(legacy);
		expect(verifyKillProof(root, { ...legacy, version: 2 })).toMatchObject({ fresh: false, reasons: expect.arrayContaining(["receipt id does not re-derive from its contents (edited or copied receipt)"]) });
		writeFileSync(join(root, HELPER), "export const LO = 0, HI = 9; // new generation\n");
		const checked = verifyKillProof(root, legacy);
		expect(checked).toMatchObject({ fresh: false, reasons: [expect.stringContaining("Re-run prove-kill")] });
		expect(freshKillsForTest(root, TEST)).toEqual([]);
		expect(killProofNudge({ root, relPath: TEST, newCases: [] })).toContain("went stale");
		expect(listKillProofs(root, true)).toContainEqual(expect.objectContaining({ id: legacy.id, freshness: "stale" }));
		const renewed = await prove("n < lo");
		expect(renewed.version).toBe(2);
		expect(renewed.id).not.toBe(legacy.id);
		expect(verifyKillProof(root, renewed)).toEqual({ fresh: true });
		expect(listKillProofs(root, true)).toContainEqual(expect.objectContaining({ id: legacy.id, supersededBy: renewed.id }));
		expect(freshKillsForTest(root, TEST).map(receipt => receipt.id)).toEqual([renewed.id]);
	});
	it("binds the protocol to the receipt identity and rejects unsupported protocol values", async () => {
		const current = await prove("n < lo", false);
		expect(current.version).toBe(2);
		const legacy = { ...current, version: 1 as const };
		expect(receiptId(current)).not.toBe(receiptId(legacy));
		expect(parseKillProof(current)).toEqual(current);
		for (const version of [0, 3, "2", null]) expect(parseKillProof({ ...current, version })).toBeNull();
	});
});

describe("parameterized proof composition", () => {
	it("combines distinct expanded case names across fresh receipts", async () => {
		const a = await prove("n < lo"), b = await prove("n > hi");
		const cert = certifyCases({ root, testPath: TEST, requireCases: [FAMILY] });
		expect(cert.certified).toBe(true);
		expect(cert.uncovered).toEqual([]);
		expect(freshKillsForTest(root, TEST, [FAMILY]).map(receipt => receipt.id).sort()).toEqual([a.id, b.id].sort());
		expect(killProofNudge({ root, relPath: TEST, newCases: [FAMILY] })).toBeNull();
	});
	it("keeps a family uncovered when an expanded case survives every fault", async () => {
		cases.push({ name: "bounds 5", input: 5, expected: 5 });
		await prove("n < lo");
		await prove("n > hi");
		expect(certifyCases({ root, testPath: TEST, requireCases: [FAMILY] }).certified).toBe(false);
		expect(freshKillsForTest(root, TEST, [FAMILY])).toEqual([]);
	});
	it("never uses an obsolete receipt to fill the missing part of a family", async () => {
		await prove("n < lo");
		writeKillProof(root, oldReceipt(await prove("n > hi", false)));
		const cert = certifyCases({ root, testPath: TEST, requireCases: [FAMILY] });
		expect(cert.fresh).toHaveLength(1);
		expect(cert.certified).toBe(false);
	});
	it.each<CaseRequirement>([{ kind: "exact", name: "bounds same" }, FAMILY])("does not combine partial kills of indistinguishable duplicate names ($kind)", async (requirement) => {
		cases = cases.map(row => ({ ...row, name: "bounds same" }));
		await prove("n < lo");
		await prove("n > hi");
		expect(certifyCases({ root, testPath: TEST, requireCases: [requirement] }).certified).toBe(false);
	});
	it("accepts duplicate names when one fresh receipt killed every duplicate", async () => {
		cases = [{ name: "bounds same", input: -1, expected: 0 }, { name: "bounds same", input: -2, expected: 0 }];
		await prove("n < lo");
		expect(certifyCases({ root, testPath: TEST, requireCases: [FAMILY] }).certified).toBe(true);
	});
});
