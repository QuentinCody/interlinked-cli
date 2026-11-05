// Receipt store behaviour fixed by kill-proof review round 4 (M8 retirement, M9 committed-bytes
// comparison, M10 cost, M11 copied receipts / ordering / listing cap). Real git repos under the OS
// temp dir; the proof runner is scripted, so no vitest child process runs.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KILL_PROOFS_LIST_CAP, listKillProofs, renderKillProofs } from "../../commands/tests-prove-kill.js";
import type { VitestRun } from "../fail-before-fix/index.js";
import { killProofNudge } from "../evaluator/post-tool-kill-proof.js";
import { freshKillsForTest, killProofsDir, listKillProofIds, proofKey, readKillProof, readKillProofIndex, rebuildKillProofIndex, sealReceipt, uncommittedPaths, writeKillProof } from "./receipt.js";
import { proveKill } from "./run.js";
import type { KillProofReceipt } from "./types.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

const SRC = "export function clamp(n: number, max: number): number {\n\treturn n > max ? max : n;\n}\n";
const SPEC = { kind: "explicit", file: "src/clamp.ts", find: "? max : n", replace: "? n : n" } as const;
const MK = "test/clamp.mutation-kill.test.ts";
const HEADER = 'import { expect, it } from "vitest";\nimport { clamp } from "../src/clamp";\n';
const strong = (title: string) => `it(${JSON.stringify(title)}, () => { expect(clamp(5, 3)).toBe(3); });\n`;

function committedRepo(files: Record<string, string>): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-store-")));
	roots.push(root);
	git(root, "init", "-q");
	git(root, "config", "user.email", "store@example.invalid");
	git(root, "config", "user.name", "store");
	for (const [path, text] of Object.entries({ ".gitignore": "node_modules\n.interlinked\n", ...files })) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	git(root, "add", "-A");
	git(root, "commit", "-qm", "base");
	return root;
}

type Case = VitestRun["cases"][number];
const okRun = (cases: Case[]): VitestRun => ({ cases, timedOut: false, exitCode: 0, durationMs: 10 });
/** Every named case kills (fails by its own check under the mutant, passes otherwise). */
function killer(names: readonly string[], file = MK) {
	return async (dir: string): Promise<VitestRun> => {
		const source = readFileSync(join(dir, "src/clamp.ts"), "utf8");
		const row = (name: string, failed: boolean): Case => (failed ? { file, name, title: name, status: "failed", message: "AssertionError: expected 5 to be 3" } : { file, name, title: name, status: "passed" });
		if (source.includes("kill-proof canary")) return okRun(names.map(name => ({ ...row(name, true), message: "Error: canary" })));
		return okRun(names.map(name => row(name, source !== SRC)));
	};
}

async function prove(root: string, names: readonly string[], at: string): Promise<KillProofReceipt> {
	const result = await proveKill({ root, spec: SPEC, tests: [MK], budgetMs: 1000, runner: killer(names), now: () => new Date(at) });
	if (!result.ok) throw new Error(`fixture: ${result.reasons.join("; ")}`);
	return result.receipt;
}

describe("receipt supersession (review M8) — positive (the newest proof per key is the one that counts)", () => {
	it("P1: a re-proof after a test edit marks the older receipt superseded in the index, --verify passes, the listing says so", async () => {
		const root = committedRepo({ "src/clamp.ts": SRC, [MK]: HEADER + strong("caps at max") });
		const first = await prove(root, ["caps at max"], "2026-11-05T00:00:00.000Z");
		writeFileSync(join(root, MK), HEADER + strong("caps at max") + strong("caps again"));
		const second = await prove(root, ["caps at max", "caps again"], "2026-11-05T00:01:00.000Z");
		expect(proofKey(first)).toBe(proofKey(second));
		expect(listKillProofIds(root).sort()).toEqual([first.id, second.id].sort()); // history is kept on disk
		expect(readKillProofIndex(root).receipts.map(row => [row.id, row.supersededBy]).sort()).toEqual([[first.id, second.id], [second.id, undefined]].sort());
		git(root, "add", "-A");
		git(root, "commit", "-qm", "second");
		const rows = listKillProofs(root, true);
		expect(rows.map(row => [row.id, row.freshness, row.supersededBy])).toEqual([[second.id, "fresh", undefined], [first.id, "stale", second.id]]);
		expect(renderKillProofs(rows)).toContain(`SUPERSEDED by ${second.id}`);
	});

	it("P2: the superseded receipt is never evidence for the Stop check or the nudge, even when its bytes come back", async () => {
		const root = committedRepo({ "src/clamp.ts": SRC, [MK]: HEADER + strong("caps at max") });
		const first = await prove(root, ["caps at max"], "2026-11-05T00:00:00.000Z");
		writeFileSync(join(root, MK), HEADER + strong("caps at max") + strong("caps again"));
		const second = await prove(root, ["caps at max", "caps again"], "2026-11-05T00:01:00.000Z");
		expect(freshKillsForTest(root, MK).map(row => row.id)).toEqual([second.id]);
		writeFileSync(join(root, MK), HEADER + strong("caps at max")); // the first receipt's bytes again, but it is history
		expect(freshKillsForTest(root, MK)).toEqual([]);
		expect(killProofNudge({ root, relPath: MK })).toContain("went stale"); // the current (second) receipt, not the first
		// Proving those bytes again rewrites the same id with a newer provedAt: it is the current receipt once more.
		const again = await prove(root, ["caps at max"], "2026-11-05T00:02:00.000Z");
		expect(again.id).toBe(first.id);
		expect(readKillProofIndex(root).receipts.find(row => row.id === first.id)?.supersededBy).toBeUndefined();
		expect(readKillProofIndex(root).receipts.find(row => row.id === second.id)?.supersededBy).toBe(first.id);
		expect(freshKillsForTest(root, MK).map(row => row.id)).toEqual([first.id]);
	});
});

describe("receipt supersession — negative (a different proof is never superseded)", () => {
	it("N1: a proof of the same source with another test set, or another fault, stays current", async () => {
		const other = "test/other.mutation-kill.test.ts";
		const root = committedRepo({ "src/clamp.ts": SRC, [MK]: HEADER + strong("caps at max"), [other]: HEADER + strong("caps at max") });
		const a = await prove(root, ["caps at max"], "2026-11-05T00:00:00.000Z");
		const b = await proveKill({ root, spec: SPEC, tests: [other], budgetMs: 1000, runner: killer(["caps at max"], other), now: () => new Date("2026-11-05T00:01:00.000Z") });
		const c = await proveKill({ root, spec: { kind: "explicit", file: "src/clamp.ts", find: "n > max", replace: "n >= max" }, tests: [MK], budgetMs: 1000, runner: killer(["caps at max"]), now: () => new Date("2026-11-05T00:02:00.000Z") });
		if (!b.ok || !c.ok) throw new Error(`fixture: ${[b, c].flatMap(r => (r.ok ? [] : r.reasons)).join("; ")}`);
		expect(readKillProofIndex(root).receipts.map(row => row.supersededBy)).toEqual([undefined, undefined, undefined]);
		expect(listKillProofs(root, false).map(row => row.supersededBy)).toEqual([undefined, undefined, undefined]);
		expect(new Set([a.id, b.receipt.id, c.receipt.id]).size).toBe(3);
	});
});

describe("uncommittedPaths (review M9) — compares the proven bytes with HEAD and the index, never git status", () => {
	it("P1: committed bytes are not uncommitted; staged-only, modified-only and untracked bytes are", () => {
		const root = committedRepo({ "src/clamp.ts": SRC, [MK]: HEADER + strong("caps at max") });
		const hashed = (path: string) => ({ path, sha256: execFileSync("sha256sum", [join(root, path)], { encoding: "utf8" }).slice(0, 64) });
		expect(uncommittedPaths(root, [hashed("src/clamp.ts"), hashed(MK)])).toEqual([]);
		writeFileSync(join(root, MK), HEADER + strong("caps at max") + strong("more"));
		const modified = hashed(MK);
		expect(uncommittedPaths(root, [modified])).toEqual([MK]);
		git(root, "add", MK);
		expect(uncommittedPaths(root, [modified])).toEqual([MK]); // staged but not in HEAD
		writeFileSync(join(root, "test/new.ts"), "export {};\n");
		expect(uncommittedPaths(root, [hashed("test/new.ts")])).toEqual(["test/new.ts"]);
	});

	it("N1: a recorded hash that is neither HEAD's nor the index's is uncommitted even when the path is hidden by --assume-unchanged", () => {
		const root = committedRepo({ "src/clamp.ts": SRC, [MK]: HEADER + strong("caps at max") });
		git(root, "update-index", "--assume-unchanged", MK);
		writeFileSync(join(root, MK), HEADER + strong("caps at max") + strong("hidden"));
		const sha256 = execFileSync("sha256sum", [join(root, MK)], { encoding: "utf8" }).slice(0, 64);
		expect(git(root, "status", "--porcelain")).toBe("");
		expect(uncommittedPaths(root, [{ path: MK, sha256 }])).toEqual([MK]);
	});
});

describe("readKillProof (review M11) — a copied receipt is not a second receipt", () => {
	it("N1: a receipt file whose contents carry another id is invalid, counted once and listed as unreadable", async () => {
		const root = committedRepo({ "src/clamp.ts": SRC, [MK]: HEADER + strong("caps at max") });
		const receipt = await prove(root, ["caps at max"], "2026-11-05T00:00:00.000Z");
		writeFileSync(join(killProofsDir(root), "aaaaaaaaaaaaaaaa.json"), readFileSync(join(killProofsDir(root), `${receipt.id}.json`)));
		expect(readKillProof(root, "aaaaaaaaaaaaaaaa")).toBeNull();
		expect(rebuildKillProofIndex(root).receipts.map(row => row.id)).toEqual([receipt.id]);
		expect(freshKillsForTest(root, MK).map(row => row.id)).toEqual([receipt.id]);
		expect(listKillProofs(root, true).find(row => row.id === "aaaaaaaaaaaaaaaa")?.freshness).toBe("unreadable");
	});
});

/** A sealed receipt with the given id-independent fields; `tests` names the file it claims. */
function syntheticReceipt(root: string, n: number, testPath: string): KillProofReceipt {
	const hex = n.toString(16).padStart(16, "0");
	return sealReceipt({
		version: 1, id: hex, digest: "", verdict: "killed", reasons: [], provedAt: new Date(1_700_000_000_000 + n * 1000).toISOString(), root,
		source: { path: "src/clamp.ts", sha256: "0".repeat(64) }, mutant: { file: "src/clamp.ts", offset: n, originalLexeme: "a", replacement: "b", line: 1, source: "explicit" },
		tests: [{ path: testPath, sha256: "1".repeat(64) }], boundImports: [], killedTests: [testPath],
		baseline: { cases: 1, durationMs: 1 }, underMutant: { durationMs: 1, timedOut: false, cases: [{ test: `${testPath} › caps`, verdict: "killed" }] },
		environment: { node: process.version, vitest: null, platform: `${process.platform}-${process.arch}`, config: null, setupFiles: [] },
	});
}

describe("listing order and cost (review M10, M11)", () => {
	it("P1: receipts list newest provedAt first; the human listing is capped and says how many more", async () => {
		const root = committedRepo({ "src/clamp.ts": SRC, [MK]: HEADER + strong("caps at max") });
		const dir = killProofsDir(root);
		mkdirSync(dir, { recursive: true });
		const total = KILL_PROOFS_LIST_CAP + 5;
		for (let n = 1; n <= total; n++) writeFileSync(join(dir, `${n.toString(16).padStart(16, "0")}.json`), JSON.stringify(syntheticReceipt(root, n, `test/t${n}.mutation-kill.test.ts`)));
		const rows = listKillProofs(root, false);
		expect(rows).toHaveLength(total);
		expect((rows[0]?.provedAt ?? "") > (rows[total - 1]?.provedAt ?? "")).toBe(true);
		const text = renderKillProofs(rows);
		expect(text).toContain(`… and 5 more`);
		expect(text.match(/^[0-9a-f]{16} KILLED/gm)).toHaveLength(KILL_PROOFS_LIST_CAP);
	});

	it("P2: freshKillsForTest reads no receipt for a file no index row names (2,000 receipts, < 300 ms)", async () => {
		const root = committedRepo({ "src/clamp.ts": SRC, [MK]: HEADER + strong("caps at max") });
		const dir = killProofsDir(root);
		mkdirSync(dir, { recursive: true });
		const receipts: KillProofReceipt[] = [];
		for (let n = 1; n <= 2000; n++) {
			const receipt = syntheticReceipt(root, n, `test/t${n % 50}.mutation-kill.test.ts`);
			receipts.push(receipt);
			writeFileSync(join(dir, `${receipt.id}.json`), JSON.stringify(receipt));
		}
		writeKillProof(root, syntheticReceipt(root, 2001, "test/last.mutation-kill.test.ts")); // rebuilds the index over every file
		expect(readKillProofIndex(root).receipts).toHaveLength(2001);
		const started = performance.now();
		expect(freshKillsForTest(root, "test/none.mutation-kill.test.ts")).toEqual([]);
		expect(performance.now() - started).toBeLessThan(300);
	});
});
