// Kill proof — pruning orphaned receipts (decision record UX F1 residue).
// A receipt whose source or test file is gone can never be re-proved, so before `--prune` it kept
// `tests kill-proofs --verify` at exit 1 forever and the receipt directory refuses edit tools.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VitestRun } from "../fail-before-fix/index.js";
import { orphanedKillProofs, pruneKillProofs } from "./prune.js";
import { killProofsDir, listKillProofIds, readKillProofIndex } from "./receipt.js";
import { proveKill } from "./run.js";
import type { KillProofReceipt, MutantSpec } from "./types.js";

const SOURCE = "export function clamp(n: number, lo: number): number {\n\tif (n < lo) return lo;\n\treturn n;\n}\n";
const TEST_FILE = "src/clamp.mutation-kill.test.ts";
const CASE = "keeps the lower bound";
const FAULT: MutantSpec = { kind: "explicit", file: "src/clamp.ts", find: "n < lo", replace: "n <= lo - 1" };

let root: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-prune-")));
	execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src/clamp.ts"), SOURCE);
	writeFileSync(join(root, TEST_FILE), `import { clamp } from './clamp.js';\nit('${CASE}', () => { expect(clamp(-1, 0)).toBe(0); });\n`);
	execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Case = VitestRun["cases"][number];
const row = (status: Case["status"], message?: string): Case => ({ file: TEST_FILE, name: CASE, title: CASE, status, ...(message !== undefined ? { message } : {}) });
const run = (cases: Case[]): VitestRun => ({ cases, timedOut: false, exitCode: cases.some(c => c.status === "failed") ? 1 : 0, durationMs: 10 });

async function runner(dir: string): Promise<VitestRun> {
	const source = readFileSync(join(dir, "src/clamp.ts"), "utf8");
	if (source.includes("kill-proof canary")) return run([row("failed", "Error: canary")]);
	if (source.includes("n <= lo - 1")) return run([row("failed", "AssertionError: expected -1 to be 0")]);
	return run([row("passed")]);
}

async function prove(): Promise<KillProofReceipt> {
	const result = await proveKill({ root, spec: FAULT, tests: [TEST_FILE], budgetMs: 1000, runner });
	if (!result.ok) throw new Error(result.reasons.join("; "));
	expect(result.receipt.verdict).toBe("killed");
	return result.receipt;
}

describe("prune — positive (an orphaned receipt is found and removed)", () => {
	it("P1: a receipt whose test file was deleted is orphaned, with the missing path as its reason", async () => {
		const receipt = await prove();
		rmSync(join(root, TEST_FILE));
		expect(orphanedKillProofs(root)).toEqual([{ id: receipt.id, reasons: [`test ${TEST_FILE} no longer exists`] }]);
	});
	it("P2: a receipt whose source was deleted is orphaned", async () => {
		const receipt = await prove();
		rmSync(join(root, "src/clamp.ts"));
		expect(orphanedKillProofs(root)).toEqual([{ id: receipt.id, reasons: ["source src/clamp.ts no longer exists"] }]);
	});
	it("P3: pruning removes the receipt file and its index row", async () => {
		const receipt = await prove();
		rmSync(join(root, TEST_FILE));
		const result = pruneKillProofs(root, { dryRun: false });
		expect(result.removed.map(r => r.id)).toEqual([receipt.id]);
		expect(listKillProofIds(root)).toEqual([]);
		expect(readKillProofIndex(root).receipts).toEqual([]);
	});
});

describe("prune — negative (everything else stays)", () => {
	it("N1: a receipt whose files exist is not orphaned, even when its bytes changed (stale: re-prove it)", async () => {
		await prove();
		writeFileSync(join(root, "src/clamp.ts"), `${SOURCE}// edited\n`);
		expect(orphanedKillProofs(root)).toEqual([]);
		expect(pruneKillProofs(root, { dryRun: false }).removed).toEqual([]);
		expect(listKillProofIds(root)).toHaveLength(1);
	});
	it("N2: a dry run lists the orphan and deletes nothing", async () => {
		const receipt = await prove();
		rmSync(join(root, TEST_FILE));
		const result = pruneKillProofs(root, { dryRun: true });
		expect(result).toMatchObject({ dryRun: true, removed: [{ id: receipt.id }] });
		expect(listKillProofIds(root)).toEqual([receipt.id]);
	});
	it("N3: an unreadable receipt is never pruned (it may be evidence of an edit)", async () => {
		const receipt = await prove();
		writeFileSync(join(killProofsDir(root), `${receipt.id}.json`), "{ not json");
		rmSync(join(root, TEST_FILE));
		expect(orphanedKillProofs(root)).toEqual([]);
		expect(pruneKillProofs(root, { dryRun: false }).removed).toEqual([]);
		expect(existsSync(join(killProofsDir(root), `${receipt.id}.json`))).toBe(true);
	});
	it("N4: no receipt directory prunes nothing and creates nothing", () => {
		expect(pruneKillProofs(root, { dryRun: false }).removed).toEqual([]);
		expect(existsSync(killProofsDir(root))).toBe(false);
	});
});
