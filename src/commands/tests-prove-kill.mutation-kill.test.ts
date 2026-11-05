// Mutation-kill tests for `interlinked tests prove-kill` / `kill-proofs` — 2026-11-05 dogfood
// campaign (docs/reviews/kill-proof-dogfood.md): option validation, freshness rows, exit codes
// and rendering observables the companion unit test left to the story test.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VitestRun } from "../harness/fail-before-fix/index.js";
import { KILL_PROOFS_DIR, writeKillProof } from "../harness/kill-proof/receipt.js";
import { proveKill } from "../harness/kill-proof/run.js";
import type { KillProofReceipt } from "../harness/kill-proof/types.js";
import { type KillProofRow, listKillProofs, PROVE_KILL_EXIT, renderKillProofs, specFromOptions, testsKillProofsCommand, testsProveKillCommand } from "./tests-prove-kill.js";

const SOURCE = "export function clamp(n: number, max: number): number {\n\treturn n > max ? max : n;\n}\n";
const TEST = "import { clamp } from './clamp.js';\nit('caps', () => { expect(clamp(5, 3)).toBe(3); });\n";
const TEST_FILE = "src/clamp.test.ts";
const SPEC = { kind: "explicit", file: "src/clamp.ts", find: "n > max", replace: "n >= max" } as const;

let root: string;
const git = (...args: string[]): void => { execFileSync("git", ["-C", root, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { stdio: "ignore" }); };
function write(path: string, text: string): void {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), text);
}
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "prove-kill-cli-mk-")));
	git("init", "-q");
	write("src/clamp.ts", SOURCE);
	write(TEST_FILE, TEST);
	git("add", ".");
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	process.exitCode = 0;
	vi.restoreAllMocks();
});

type Case = VitestRun["cases"][number];
const okRun = (cases: Case[]): VitestRun => ({ cases, timedOut: false, exitCode: 0, durationMs: 10 });
const runner = async (dir: string): Promise<VitestRun> => {
	const source = readFileSync(join(dir, "src/clamp.ts"), "utf8");
	const row: Case = { file: TEST_FILE, name: "caps", title: "caps", status: "passed" };
	if (source.includes("kill-proof canary")) return okRun([{ ...row, status: "failed", message: "Error: canary" }]);
	return source === SOURCE ? okRun([row]) : okRun([{ ...row, status: "failed", message: "AssertionError: expected 5 to be 3" }]);
};
async function provenKill(): Promise<KillProofReceipt> {
	const result = await proveKill({ root, spec: SPEC, tests: [TEST_FILE], budgetMs: 1000, runner });
	if (!result.ok) throw new Error(`expected a receipt: ${result.reasons.join("; ")}`);
	return result.receipt;
}
const ROW: KillProofRow = { id: "7113042096864a76", verdict: "survived", provedAt: "2026-11-04T00:00:00.000Z", mutant: "explicit fault @ src/math.ts:3", tests: ["test/clamp.test.ts"], killedTests: [] };

describe("specFromOptions — the mutant id shape", () => {
	// test-contract: boundary - a mutant id is EXACTLY 16 hex characters; trailing characters are refused, not silently truncated
	it("a 16-hex id with trailing characters is refused", () => {
		expect(specFromOptions({ mutant: "0123456789abcdef" })).toEqual({ kind: "manifest", mutantId: "0123456789abcdef" });
		expect(typeof specFromOptions({ mutant: "0123456789abcdef0" })).toBe("string");
		expect(specFromOptions({ mutant: "0123456789abcdefZZ" })).toContain("16-character hex mutant id");
	});
});

describe("listKillProofs --verify — freshness classes", () => {
	// test-contract: public-api - a proof over bytes that are not committed is `uncommitted` (reported, exit 0), and becomes `fresh` once they are committed
	it("added-but-uncommitted bytes read UNCOMMITTED, committed bytes read FRESH", async () => {
		const receipt = await provenKill();
		const before = listKillProofs(root, true);
		expect(before.map(row => [row.id, row.freshness])).toEqual([[receipt.id, "uncommitted"]]);
		expect(before[0]?.reasons?.[0]).toContain("work tree differs from HEAD or the index");
		git("commit", "-qm", "init");
		expect(listKillProofs(root, true).map(row => row.freshness)).toEqual(["fresh"]);
	});
	// test-contract: public-api - an edit to the proven source after the proof reads STALE with the byte reason, never `uncommitted`
	it("a source edit after the proof reads STALE with its reason", async () => {
		await provenKill();
		git("commit", "-qm", "init");
		write("src/clamp.ts", `${SOURCE}// edited after the proof\n`);
		const rows = listKillProofs(root, true);
		expect(rows[0]?.freshness).toBe("stale");
		expect(rows[0]?.reasons).toContain("source src/clamp.ts changed since the proof");
	});
});

describe("tests kill-proofs --verify — exit code", () => {
	// test-contract: public-api - a KILLED receipt whose file is unreadable is lost evidence: --verify exits 1, the same as stale
	it("an unreadable killed receipt fails --verify", async () => {
		const receipt = await provenKill();
		writeKillProof(root, receipt);
		writeFileSync(join(root, KILL_PROOFS_DIR, `${receipt.id}.json`), "{ not json");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		testsKillProofsCommand({ cwd: root, verify: true, json: true });
		expect(process.exitCode).toBe(1);
		const printed = JSON.parse(log.mock.calls[0]?.[0] as string) as { receipts: KillProofRow[] };
		expect(printed.receipts[0]?.freshness).toBe("unreadable");
	});
});

describe("tests prove-kill — --run-timeout validation", () => {
	// test-contract: boundary - a zero budget cannot run anything; it is refused up front (exit 2) and named, never passed to the runner
	it("--run-timeout 0 is refused before any run", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		await testsProveKillCommand({ cwd: root, file: "src/clamp.ts", find: "n > max", replace: "n < max", test: [TEST_FILE], runTimeout: "0" });
		expect(process.exitCode).toBe(PROVE_KILL_EXIT.undecided);
		expect(error.mock.calls.map(call => String(call[0])).join("\n")).toContain("--run-timeout must be a positive number of milliseconds");
	});
});

describe("renderKillProofs — the killed-through line", () => {
	// test-contract: public-api - a single-file receipt never prints a "killed through" line; it appears only when a multi-file receipt killed through a strict subset
	it("a single-file survived row carries no killed-through line; a partial multi-file row does", () => {
		expect(renderKillProofs([ROW])).not.toContain("killed through");
		const partial: KillProofRow = { ...ROW, verdict: "killed", tests: ["a.test.ts", "b.test.ts"], killedTests: ["a.test.ts"] };
		expect(renderKillProofs([partial])).toContain("killed through: a.test.ts");
	});
});
