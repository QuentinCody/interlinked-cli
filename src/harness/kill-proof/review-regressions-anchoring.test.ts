// ===========================================
// Kill proof — survivor anchoring (review round 3 §d.11, "the explicit fault is free")
// ===========================================
// A `*.mutation-kill.*` file claims to kill the companion source's manifest survivors. Before this fix any
// explicit `--find/--replace` fault certified it, so a trivially killable fault (`a + b → a - b`) discharged
// the nudge and the Stop check for a file whose real survivors were never run. Now: when the survivors sidecar
// knows survivors for the companion source, only a receipt for a MANIFEST mutant of that source certifies.
// With no known survivors, an explicit fault still certifies (nothing else exists to tie it to).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { killProofNudge } from "../evaluator/post-tool-kill-proof.js";
import type { VitestRun } from "../fail-before-fix/index.js";
import { type Certification, certifyCases, freshKillsForTest } from "./receipt-freshness.js";
import { proveKill } from "./run.js";
import type { KillProofReceipt, MutantSpec } from "./types.js";

const SOURCE = "export function clamp(n: number, lo: number, hi: number): number {\n\tif (n < lo) return lo;\n\treturn n;\n}\n";
const TEST_FILE = "src/clamp.mutation-kill.test.ts";
const TEST = "import { clamp } from './clamp.js';\nit('keeps the lower bound', () => { expect(clamp(-1, 0, 9)).toBe(0); });\n";
const CASE = "keeps the lower bound";
const FAULT: MutantSpec = { kind: "explicit", file: "src/clamp.ts", find: "n < lo", replace: "n <= lo - 1" };

let root: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-anchor-")));
	execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src/clamp.ts"), SOURCE);
	writeFileSync(join(root, TEST_FILE), TEST);
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

async function proveExplicit(): Promise<KillProofReceipt> {
	const result = await proveKill({ root, spec: FAULT, tests: [TEST_FILE], budgetMs: 1000, runner });
	if (!result.ok) throw new Error(result.reasons.join("; "));
	expect(result.receipt.verdict).toBe("killed");
	return result.receipt;
}

function writeSidecar(survivors: string[]): void {
	mkdirSync(join(root, ".interlinked"), { recursive: true });
	const now = "2026-11-05T00:00:00.000Z";
	writeFileSync(join(root, ".interlinked/mutation-survivors-index.json"), JSON.stringify({
		version: 1, generatedAt: now, generation: 1, authoritativeAt: now,
		files: { "src/clamp.ts": { survivors, mutantCount: survivors.length + 1, killed: 1 } },
	}));
}

describe("survivor anchoring — positive (a known survivor makes an explicit fault insufficient)", () => {
	it("P1: with a known survivor of the companion source, an explicit-fault kill does not certify the file", async () => {
		const receipt = await proveExplicit();
		writeSidecar(["src/clamp.ts#survivor-1"]);
		const cert = certifyCases({ root, testPath: TEST_FILE, requireCases: [CASE] });
		expect(cert.certified).toBe(false);
		expect(cert.unanchored.map(r => r.id)).toEqual([receipt.id]);
		expect(freshKillsForTest(root, TEST_FILE, [CASE])).toEqual([]);
	});
	it("P2: the nudge names the anchoring rule and the manifest command", async () => {
		await proveExplicit();
		writeSidecar(["src/clamp.ts#survivor-1"]);
		const nudge = killProofNudge({ root, relPath: TEST_FILE, newCases: [CASE] });
		expect(nudge).toContain("explicit --find/--replace fault");
		expect(nudge).toContain("src/clamp.ts has 1 known manifest survivor(s)");
		expect(nudge).toContain("interlinked tests prove-kill --mutant <id> --test src/clamp.mutation-kill.test.ts");
	});
	it("P3: a fresh kill of a MANIFEST mutant of the companion source certifies", async () => {
		const explicit = await proveExplicit();
		writeSidecar(["src/clamp.ts#survivor-1"]);
		const manifest: KillProofReceipt = { ...explicit, id: "0123456789abcdef", mutant: { ...explicit.mutant, source: "manifest", mutantId: "src/clamp.ts#survivor-1" } };
		const certify = (): Certification => ({ certified: true, receipt: manifest });
		const cert = certifyCases({ root, testPath: TEST_FILE, requireCases: [CASE], ids: [manifest.id], certify });
		expect(cert.certified).toBe(true);
		expect(cert.unanchored).toEqual([]);
	});
});

describe("survivor anchoring — negative (no known survivor keeps the explicit fault valid)", () => {
	it("N1: without a survivors sidecar an explicit-fault kill certifies, as before", async () => {
		await proveExplicit();
		const cert = certifyCases({ root, testPath: TEST_FILE, requireCases: [CASE] });
		expect(cert.certified).toBe(true);
		expect(cert.unanchored).toEqual([]);
		expect(killProofNudge({ root, relPath: TEST_FILE, newCases: [CASE] })).toBeNull();
	});
	it("N2: a sidecar entry with no survivors (measured, nothing survived) does not anchor", async () => {
		await proveExplicit();
		writeSidecar([]);
		expect(certifyCases({ root, testPath: TEST_FILE, requireCases: [CASE] }).certified).toBe(true);
	});
	it("N3: a manifest mutant of ANOTHER source does not anchor this file's claim", async () => {
		const explicit = await proveExplicit();
		writeSidecar(["src/clamp.ts#survivor-1"]);
		const other: KillProofReceipt = { ...explicit, id: "fedcba9876543210", mutant: { ...explicit.mutant, file: "src/other.ts", source: "manifest", mutantId: "src/other.ts#m" } };
		const certify = (): Certification => ({ certified: true, receipt: other });
		expect(certifyCases({ root, testPath: TEST_FILE, requireCases: [CASE], ids: [other.id], certify }).certified).toBe(false);
	});
});
