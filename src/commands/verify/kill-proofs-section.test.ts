// `interlinked verify` kill_proofs section: the receipts `tests prove-kill` wrote, judged
// by the SAME freshness `tests kill-proofs --verify` reports. Receipts here are built by
// hand from real bytes (hashes, environment, explicit mutant) so every freshness state
// is reachable without running vitest inside the fixture. No receipt on disk ⇒ no
// section, one directory probe, no git — pinned through counted fs / child_process calls.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnvironment, hashFile, killProofsDir, receiptId, sealReceipt, writeKillProof } from "../../harness/kill-proof/receipt.js";
import { lineTextAt, resolveMutant } from "../../harness/kill-proof/resolve.js";
import type { HashedFile, KillProofReceipt } from "../../harness/kill-proof/types.js";
import { listKillProofs } from "../tests-prove-kill.js";
import { KILL_PROOF_STALE_CHECK, killProofsSection, staleKillFindings, streamKillProofsSection } from "./kill-proofs-section.js";

const counters = vi.hoisted(() => ({ readdir: 0, exists: 0, git: 0 }));
vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	return {
		...real,
		existsSync: (path: Parameters<typeof real.existsSync>[0]) => { if (String(path).includes("kill-proofs")) counters.exists++; return real.existsSync(path); },
		readdirSync: ((path: string, options?: unknown) => { if (String(path).includes("kill-proofs")) counters.readdir++; return (real.readdirSync as (p: string, o?: unknown) => unknown)(path, options); }) as typeof real.readdirSync,
	};
});
vi.mock("node:child_process", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:child_process")>();
	return {
		...real,
		execFileSync: ((file: string, ...rest: unknown[]) => { if (file === "git") counters.git++; return (real.execFileSync as (f: string, ...r: unknown[]) => unknown)(file, ...rest); }) as typeof real.execFileSync,
	};
});

const SOURCE = "export function clamp(n: number, max: number): number {\n\treturn n > max ? max : n;\n}\n";
const TEST = "import { clamp } from './clamp.js';\nit('caps', () => { expect(clamp(5, 3)).toBe(3); });\n";
const SOURCE_FILE = "src/clamp.ts";
const TEST_FILE = "src/clamp.test.ts";

let root: string;
function git(...args: string[]): void {
	execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}
function write(path: string, text: string): void {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), text);
}
function commitAll(): void {
	git("add", ".");
	git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "fixture");
}
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "verify-kill-proofs-")));
	git("init", "-q");
	write(SOURCE_FILE, SOURCE);
	write(TEST_FILE, TEST);
	counters.readdir = 0; counters.exists = 0; counters.git = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A sealed receipt over the fixture's CURRENT bytes: fresh by construction until something changes. */
function receiptFor(verdict: KillProofReceipt["verdict"], replace = "n >= max", provedAt = "2026-11-05T00:00:00.000Z"): KillProofReceipt {
	const resolved = resolveMutant(root, { kind: "explicit", file: SOURCE_FILE, find: "n > max", replace });
	if (!resolved.ok) throw new Error(resolved.reason);
	const mutant = { ...resolved.mutant, lineText: lineTextAt(readFileSync(join(root, SOURCE_FILE), "utf8"), resolved.mutant.offset) };
	const source = hashFile(root, SOURCE_FILE) as HashedFile, tests = [hashFile(root, TEST_FILE) as HashedFile];
	const environment = captureEnvironment(root);
	const cases = [{ test: `${TEST_FILE} › caps`, verdict, ...(verdict === "inconclusive" ? { reason: "Error: crashed" } : {}) }];
	const unsealed: KillProofReceipt = {
		version: 1, id: receiptId({ source, mutant, tests, boundImports: [], environment }), digest: "", verdict, reasons: [], provedAt, root,
		source, mutant, tests, boundImports: [], killedTests: verdict === "killed" ? [TEST_FILE] : [],
		baseline: { cases: 1, durationMs: 5 }, underMutant: { durationMs: 5, timedOut: false, cases }, environment,
	};
	return sealReceipt(unsealed);
}
function record(verdict: KillProofReceipt["verdict"], replace?: string, provedAt?: string): KillProofReceipt {
	const receipt = receiptFor(verdict, replace, provedAt);
	writeKillProof(root, receipt);
	return receipt;
}

describe("verify kill_proofs section — positive (must fire)", () => {
	it("P1: a STALE killed receipt is a [proven] kill_proof_stale finding carrying the receipt's reasons, its test file and the renew command", () => {
		commitAll();
		const receipt = record("killed");
		write(SOURCE_FILE, `${SOURCE}// later\n`);
		const section = killProofsSection(root);
		expect(section.present).toBe(true);
		expect(section.failed).toBe(true);
		expect(section.findings).toEqual([{
			check: KILL_PROOF_STALE_CHECK, id: receipt.id, freshness: "stale", files: [TEST_FILE],
			reasons: [`source ${SOURCE_FILE} changed since the proof`],
			message: `kill proof ${receipt.id} is STALE: source ${SOURCE_FILE} changed since the proof`,
			fix: `interlinked tests prove-kill --mutant <id> --test ${TEST_FILE}`,
		}]);
		expect(section.json).toMatchObject({ issues: 1, files: [TEST_FILE], skipped: false });
		expect(section.lines).toContain(`[proven] kill_proof_stale: kill proof ${receipt.id} is STALE: source ${SOURCE_FILE} changed since the proof`);
		expect(section.lines).toContain(`  fix: interlinked tests prove-kill --mutant <id> --test ${TEST_FILE}`);
		expect(section.lines.at(-1)).toBe("1 KILLED proof(s): 0 fresh, 0 uncommitted, 1 stale. Re-run the prove-kill command of each stale proof to renew it.");
	});
	it("P2: an UNREADABLE killed receipt (the file no longer parses; the index still names it) is a finding", () => {
		commitAll();
		const receipt = record("killed");
		writeFileSync(join(killProofsDir(root), `${receipt.id}.json`), "{not json");
		const section = killProofsSection(root);
		expect(section.failed).toBe(true);
		expect(section.findings).toHaveLength(1);
		expect(section.findings[0]).toMatchObject({ id: receipt.id, freshness: "unreadable", files: [TEST_FILE], fix: `interlinked tests prove-kill --mutant <id> --test ${TEST_FILE}` });
		expect(section.findings[0]?.reasons[0]).toMatch(/unreadable/);
		expect(section.lines.at(-1)).toBe("1 KILLED proof(s): 0 fresh, 0 uncommitted, 1 stale. Re-run the prove-kill command of each stale proof to renew it.");
	});
	it("P3: the streaming section writes a red kill_proofs label, every row and the finding, and reports failure for verify's exit convention", () => {
		commitAll();
		const receipt = record("killed");
		write(TEST_FILE, `${TEST}\n`);
		const chunks: string[] = [];
		const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { chunks.push(String(chunk)); return true; });
		try {
			expect(streamKillProofsSection(root, new Set())).toBe(true);
		} finally {
			spy.mockRestore();
		}
		const text = chunks.join("");
		expect(text).toContain("\x1b[31mkill_proofs\x1b[0m (executed kill-proof receipts; same freshness as interlinked tests kill-proofs --verify)");
		expect(text).toContain(`    ${receipt.id}  KILLED       STALE       explicit fault @ ${SOURCE_FILE}:2`);
		expect(text).toContain(`[proven] kill_proof_stale: kill proof ${receipt.id} is STALE: test ${TEST_FILE} changed since the proof`);
	});
});

describe("verify kill_proofs section — negative (must not fire)", () => {
	it("N1: no receipts directory ⇒ no section, one existence probe, no directory read, no git", () => {
		commitAll();
		counters.readdir = 0; counters.exists = 0; counters.git = 0;
		const section = killProofsSection(root);
		expect(section).toEqual({ present: false, failed: false, rows: [], findings: [], lines: [], json: undefined });
		expect(counters).toEqual({ readdir: 0, exists: 2, git: 0 }); // the index probe and the directory probe, both `existsSync` inside listKillProofs
		const chunks: string[] = [];
		const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { chunks.push(String(chunk)); return true; });
		try {
			expect(streamKillProofsSection(root, new Set())).toBe(false);
		} finally {
			spy.mockRestore();
		}
		expect(chunks).toEqual([]);
	});
	it("N1b: with receipts present the directory is read exactly once (no second listing for presence)", () => {
		commitAll();
		record("killed");
		counters.readdir = 0;
		killProofsSection(root);
		expect(counters.readdir).toBe(1);
	});
	it("N2: a FRESH committed killed receipt is listed green with the same tally the CLI prints and is not a finding", () => {
		commitAll();
		const receipt = record("killed");
		const section = killProofsSection(root);
		expect(section.present).toBe(true);
		expect(section.failed).toBe(false);
		expect(section.findings).toEqual([]);
		expect(section.rows).toHaveLength(1);
		expect(section.rows[0]).toMatchObject({ id: receipt.id, verdict: "killed", freshness: "fresh", tests: [TEST_FILE] });
		expect(section.json).toMatchObject({ issues: 0, files: [], details: [], skipped: false });
		expect(section.lines).toEqual([
			`${receipt.id}  KILLED       FRESH       explicit fault @ ${SOURCE_FILE}:2 "n > max" → "n >= max"  tests: ${TEST_FILE}`,
			"1 KILLED proof(s): 1 fresh, 0 uncommitted, 0 stale. Only KILLED proofs count as evidence.",
		]);
	});
	it("N3: an UNCOMMITTED killed receipt (fresh bytes that are not the committed ones) is reported with its reason, never a finding", () => {
		const receipt = record("killed"); // nothing committed yet: the bytes are staged, not HEAD's
		const section = killProofsSection(root);
		expect(section.failed).toBe(false);
		expect(section.findings).toEqual([]);
		expect(section.rows[0]).toMatchObject({ id: receipt.id, freshness: "uncommitted" });
		expect([...(section.rows[0]?.reasons ?? [])].sort()).toEqual([
			`${TEST_FILE} differs from HEAD or the index; commit it so the proof covers committed bytes`,
			`${SOURCE_FILE} differs from HEAD or the index; commit it so the proof covers committed bytes`,
		].sort());
		expect(section.lines.at(-1)).toBe("1 KILLED proof(s): 0 fresh, 1 uncommitted, 0 stale. Only KILLED proofs count as evidence.");
	});
	it("N4: stale SURVIVED and INCONCLUSIVE receipts are listed and never findings (only a KILLED receipt carries evidence)", () => {
		commitAll();
		const survived = record("survived");
		const inconclusive = record("inconclusive", "n > max + 1");
		write(SOURCE_FILE, `${SOURCE}// later\n`);
		const section = killProofsSection(root);
		expect(section.rows.map(row => [row.id, row.verdict, row.freshness]).sort()).toEqual([[inconclusive.id, "inconclusive", "stale"], [survived.id, "survived", "stale"]].sort());
		expect(section.findings).toEqual([]);
		expect(section.failed).toBe(false);
		expect(section.lines.at(-1)).toBe("0 KILLED proof(s): 0 fresh, 0 uncommitted, 0 stale. Only KILLED proofs count as evidence.");
		expect(staleKillFindings(section.rows)).toEqual([]);
	});
	it("N5: `--skip kill_proof_stale` keeps the listing but raises no finding and does not fail", () => {
		commitAll();
		record("killed");
		write(SOURCE_FILE, `${SOURCE}// later\n`);
		const section = killProofsSection(root, new Set([KILL_PROOF_STALE_CHECK]));
		expect(section.present).toBe(true);
		expect(section.failed).toBe(false);
		expect(section.findings).toEqual([]);
		expect(section.rows[0]?.freshness).toBe("stale");
		expect(section.json).toMatchObject({ issues: 0, skipped: true });
	});
	it("N7: after a re-proof the SUPERSEDED stale receipt is history — no finding, verify does not fail, the tally counts it as superseded (verification af8b93d3 §6)", () => {
		commitAll();
		const older = record("killed");
		write(SOURCE_FILE, `${SOURCE}// later\n`);
		commitAll();
		const newer = record("killed", undefined, "2026-11-06T00:00:00.000Z"); // same proof key, newer provedAt ⇒ `older` is superseded
		const section = killProofsSection(root);
		expect(section.rows.map(row => [row.id, row.freshness, row.supersededBy])).toEqual(expect.arrayContaining([[older.id, "stale", newer.id], [newer.id, "fresh", undefined]]));
		expect(section.findings).toEqual([]);
		expect(section.failed).toBe(false);
		expect(section.json).toMatchObject({ issues: 0, files: [] });
		expect(section.lines.at(-1)).toBe("2 KILLED proof(s): 1 fresh, 0 uncommitted, 0 stale, 1 superseded. Only KILLED proofs count as evidence.");
		expect(staleKillFindings(section.rows)).toEqual([]);
		// The same rule `tests kill-proofs --verify` applies: only a CURRENT stale killed receipt fails.
		expect(listKillProofs(root, true).some(row => row.verdict === "killed" && row.supersededBy === undefined && row.freshness === "stale")).toBe(false);
	});
	it("N6: the rows ARE `listKillProofs(root, true)` — one implementation of freshness, not a second one", () => {
		commitAll();
		record("killed");
		record("survived", "n > max + 1");
		write(TEST_FILE, `${TEST}\n`);
		const section = killProofsSection(root);
		expect(section.rows).toEqual(listKillProofs(root, true));
		expect(section.json?.receipts).toEqual(listKillProofs(root, true));
	});
});
