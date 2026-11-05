// Kill proof — adversarial review round 4, receipts / Stop / nudge / CLI
// (docs/reviews/kill-proof-review-round4-receipts.md). Every case here was REPRODUCED
// against this branch and is expected to FAIL until the product code is fixed: a red
// test is the deliverable. N<n> = the system must NOT discharge a gap / must NOT accept
// a write; P<n> = a real situation must NOT be misreported. Repos are throwaway git
// repos with a COMMITTED HEAD, so the Stop check and the nudge read real `git show`.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { listKillProofs, testsKillProofsCommand } from "../../commands/tests-prove-kill.js";
import { CohortManager } from "../cohort.js";
import { evaluatePreToolUse } from "../evaluator.js";
import { killProofNudge } from "../evaluator/post-tool-kill-proof.js";
import { evaluateProtectedFilesGuard } from "../evaluator/pre-tool-guards.js";
import type { VitestRun } from "../fail-before-fix/index.js";
import { detectMutationKillEvidenceGaps } from "../mutation-kill-evidence-stop-check.js";
import { ReservationManager } from "../reservations.js";
import { DEFAULT_CONFIG } from "../rules/default-config.js";
import { getDefaultConfig } from "../rules-loader.js";
import { killProofsDir } from "./receipt.js";
import { proveKill } from "./run.js";

const NODE_MODULES = fileURLToPath(new URL("../../../node_modules", import.meta.url));
const REAL_RUN_MS = 120_000;
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
function writeAll(root: string, files: Record<string, string>): void {
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), text);
	}
}
/** A git repo whose HEAD holds `files`; `.interlinked` and node_modules are ignored. */
function committedRepo(files: Record<string, string>, opts: { linkModules?: boolean } = {}): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kill-proof-r4-")));
	roots.push(root);
	git(root, "init", "-q");
	git(root, "config", "user.email", "r4@example.invalid");
	git(root, "config", "user.name", "r4");
	writeAll(root, { ".gitignore": "node_modules\n.interlinked\n", ...files });
	if (opts.linkModules) symlinkSync(NODE_MODULES, join(root, "node_modules"));
	git(root, "add", "-A");
	git(root, "commit", "-qm", "base");
	return root;
}

const SRC = "export function clamp(n: number, max: number): number {\n\treturn n > max ? max : n;\n}\n";
const SPEC = { kind: "explicit", file: "src/clamp.ts", find: "? max : n", replace: "? n : n" } as const;
const MK = "test/clamp.mutation-kill.test.ts";
const HEADER = 'import { describe, expect, it } from "vitest";\nimport { clamp } from "../src/clamp";\n';
const strong = (title: string) => `// test-contract: bug — caps\nit(${JSON.stringify(title)}, () => { expect(clamp(5, 3)).toBe(3); });\n`;
const weak = (title: string) => `// test-contract: bug — weak\nit(${JSON.stringify(title)}, () => { expect(typeof clamp).toBe("function"); });\n`;

type Case = VitestRun["cases"][number];
const okRun = (cases: Case[]): VitestRun => ({ cases, timedOut: false, exitCode: 0, durationMs: 10 });
const pass = (name: string): Case => ({ file: MK, name, title: name, status: "passed" });
const fail = (name: string): Case => ({ file: MK, name, title: name, status: "failed", message: "AssertionError: expected 5 to be 3" });
/** Unmutated → every case passes; mutated → `outcomes` in order (true = fails by its own check); canary → all fail. */
function scripted(outcomes: ReadonlyArray<readonly [string, boolean]>) {
	return async (dir: string): Promise<VitestRun> => {
		const source = readFileSync(join(dir, "src/clamp.ts"), "utf8");
		if (source.includes("kill-proof canary")) return okRun(outcomes.map(([name]) => ({ ...fail(name), message: "Error: canary" })));
		return okRun(outcomes.map(([name, killed]) => (source === SRC || !killed ? pass(name) : fail(name))));
	};
}

/** HEAD holds `before`; the work tree holds `after`; a scripted kill proof over `after`; then the real Stop + nudge. */
async function stopAndNudge(before: string, after: string, outcomes: ReadonlyArray<readonly [string, boolean]>) {
	const root = committedRepo({ "src/clamp.ts": SRC, [MK]: HEADER + before });
	writeFileSync(join(root, MK), HEADER + after);
	const result = await proveKill({ root, spec: SPEC, tests: [MK], budgetMs: 1000, runner: scripted(outcomes) });
	if (!result.ok) throw new Error(`fixture: ${result.reasons.join("; ")}`);
	const abs = join(root, MK);
	const hits = detectMutationKillEvidenceGaps({
		filesWritten: new Set([abs]),
		fileWriteTimes: new Map([[abs, new Date().toISOString()]]),
		gitHeadSha: git(root, "rev-parse", "HEAD").trim(),
		cwd: root,
		loadMutationManifest: () => null,
	});
	return { root, receipt: result.receipt, hit: hits[0], nudge: killProofNudge({ root, relPath: MK }) };
}
/** The kill-evidence gap is open: the Stop hit is stale AND the model-visible nudge fires. */
const gapOpen = (r: Awaited<ReturnType<typeof stopAndNudge>>) => ({ stale: r.hit?.staleMeasurement ?? "no-hit", nudged: r.nudge !== null });
/** A genuine kill of the new case closes the gap on both surfaces. */
const gapClosed = (r: Awaited<ReturnType<typeof stopAndNudge>>) => ({ stale: r.hit?.staleMeasurement ?? false, nudged: r.nudge !== null });

describe("round 4 — protected_files does not refuse writes to receipts — negative (must block)", () => {
	const receiptAt = (root: string) => join(root, ".interlinked/test-runs/kill-proofs/0123456789abcdef.json");

	it("N1: a Write tool call to a receipt file is blocked by protected_files", () => {
		// review M1 — `**/.interlinked/test-runs/kill-proofs/**` reaches globMatch's `**/` branch, which compares
		// `endsWith("/.interlinked/test-runs/kill-proofs/**")` literally: the rule matches no real path
		const decision = evaluateProtectedFilesGuard("Write", { file_path: receiptAt("/repo"), content: "{}" }, DEFAULT_CONFIG, []);
		expect(decision?.decision).toBe("block");
	});

	it("N2: Edit and MultiEdit tool calls to a receipt file are blocked by protected_files", () => {
		// review M1 — same glob; the edit-tool boundary the round-3 L2 fix relies on is inert
		const edit = evaluateProtectedFilesGuard("Edit", { file_path: receiptAt("/repo"), old_string: "a", new_string: "b" }, DEFAULT_CONFIG, []);
		const multi = evaluateProtectedFilesGuard("MultiEdit", { file_path: ".interlinked/test-runs/kill-proofs/0123456789abcdef.json", edits: [] }, DEFAULT_CONFIG, []);
		expect([edit?.decision, multi?.decision]).toEqual(["block", "block"]);
	});

	it("N3: the full PreToolUse evaluator blocks a Write of a receipt in a real project", () => {
		// review M1 — end to end through evaluatePreToolUse: the call is ALLOWED today (a `.pem` control blocks)
		const root = committedRepo({ "README.md": "x\n" });
		const event = { hook_event: "PreToolUse", session_id: "r4", agent_source: "claude", tool_name: "Write", tool_input: { file_path: receiptAt(root), content: '{"version":1}' }, cwd: root, timestamp: new Date().toISOString() };
		const decision = evaluatePreToolUse(event as never, getDefaultConfig(), undefined, new ReservationManager(), new CohortManager());
		expect(decision.decision).toBe("block");
	});
});

describe("round 4 — the new-case rule (Stop + nudge) — negative (must not discharge a weak new case)", () => {
	it("N4: a new title that is a SUFFIX of an old killing case's full name is not certified by it", async () => {
		// review M2 — caseNameMatches: "caps at max".endsWith(" max"); the new case `max` itself survived
		const old = `describe("caps", () => { ${strong("at max")} });\n`;
		const r = await stopAndNudge(old, old + weak("max"), [["caps at max", true], ["max", false]]);
		expect(gapOpen(r)).toEqual({ stale: true, nudged: true });
	});

	it("N5: a weak case that DUPLICATES an old killing case's title is not certified", async () => {
		// review M3 — the title is in the baseline set, so requireCases is empty; judgeCases keys by full name, so the
		// later strong row's failure is copied onto the weak row and both read `killed`
		const r = await stopAndNudge(strong("caps at max"), weak("caps at max") + strong("caps at max"), [["caps at max", false], ["caps at max", true]]);
		expect(gapOpen(r)).toEqual({ stale: true, nudged: true });
	});

	it("N6: a receipt never records a case as killed that passed under the mutant (duplicate full names)", async () => {
		// review M3 — judgeCases' Map keeps the LAST row per name; the weak first row inherits the strong row's failure
		const r = await stopAndNudge(strong("caps at max"), weak("caps at max") + strong("caps at max"), [["caps at max", false], ["caps at max", true]]);
		expect(r.receipt.underMutant.cases.filter(row => row.verdict === "killed")).toHaveLength(1);
	});

	it("N7: a new case titled by an identifier (`it(T, …)`) opens the gap", async () => {
		// review M4 — no literal title and no counted opener: newCaseCount 0, the Stop check returns no hit at all
		const r = await stopAndNudge(strong("caps at max"), `${strong("caps at max")}const T = "boundary";\nit(T, () => { expect(typeof clamp).toBe("function"); });\n`, [["caps at max", true], ["boundary", false]]);
		expect(gapOpen(r)).toEqual({ stale: true, nudged: true });
	});

	it("N8: a new `it.each` tagged-template table case opens the gap", async () => {
		// review M4 — `it.each\`…\`("…")` matches neither CASE_TITLE_RE nor the opener counter
		const added = 'it.each`\n n\n ${5}\n`("weak $n", ({ n }) => { expect(typeof clamp).toBe("function"); });\n';
		const r = await stopAndNudge(strong("caps at max"), strong("caps at max") + added, [["caps at max", true], ["weak 5", false]]);
		expect(gapOpen(r)).toEqual({ stale: true, nudged: true });
	});

	it("N9: a new `it.each` case whose table contains a call `)` opens the gap", async () => {
		// review M4 — `(?:\([^)]*\))?` stops at the first `)` inside the table, so the title is never captured
		const added = 'it.each([[String(5)]])("weak %s", (n) => { expect(typeof clamp).toBe("function"); });\n';
		const r = await stopAndNudge(strong("caps at max"), strong("caps at max") + added, [["caps at max", true], ["weak 5", false]]);
		expect(gapOpen(r)).toEqual({ stale: true, nudged: true });
	});

	it("N10: a `/re/.test(\"…\")` call in HEAD does not mask a new case with that title", async () => {
		// review M5 — `\btest\s*(` also matches `.test(`: "weak boundary" is a baseline "title", so the new case is not new
		const before = `${strong("caps at max")}it("uses re", () => { expect(/w/.test("weak boundary")).toBe(true); });\n`;
		const after = `${strong("caps at max")}it("uses re", () => { expect(true).toBe(true); });\n${weak("weak boundary")}`;
		const r = await stopAndNudge(before, after, [["caps at max", true], ["uses re", false], ["weak boundary", false]]);
		expect(gapOpen(r)).toEqual({ stale: true, nudged: true });
	});

	it("N11 (policy): replacing an old case with a new weak case (count unchanged) opens the Stop gap the nudge opens", async () => {
		// review M6 — the growth rule reads a same-count swap as a rename and returns NO hit, while the nudge (no growth
		// rule) names the new case: the two surfaces disagree on the same bytes
		const r = await stopAndNudge(strong("caps at max") + strong("old"), strong("caps at max") + weak("new weak"), [["caps at max", true], ["new weak", false]]);
		expect(r.nudge).not.toBeNull();
		expect(r.hit?.staleMeasurement).toBe(true);
	});
});

describe("round 4 — the new-case rule — positive (a genuine kill of the new case must certify)", () => {
	it("P1: a new title containing an escaped quote, killed under the mutant, is certified", async () => {
		// review M7 — CASE_TITLE_RE keeps the source escapes (`says \"max\"`); vitest reports `says "max"`
		const r = await stopAndNudge(strong("caps at max"), strong("caps at max") + strong('says "max"'), [["caps at max", true], ['says "max"', true]]);
		expect(gapClosed(r)).toEqual({ stale: false, nudged: false });
	});

	it("P2: a new `it.each` case with a `%i` title, every row killed, is certified", async () => {
		// review M7 — the required title is the raw `caps %i`; vitest reports `caps 5`, `caps 6`: never matchable
		const added = 'it.each([5, 6])("caps %i", (n) => { expect(clamp(n, 3)).toBe(3); });\n';
		const r = await stopAndNudge(strong("caps at max"), strong("caps at max") + added, [["caps at max", true], ["caps 5", true], ["caps 6", true]]);
		expect(gapClosed(r)).toEqual({ stale: false, nudged: false });
	});

	it("P3: an assertion `/a/.test(\"abc\")` added inside an existing case is not a new case", async () => {
		// review M5 — the nudge demands a case named "abc" that does not exist; no proof can ever satisfy it
		const after = strong("caps at max").replace("});\n", 'expect(/a/.test("abc")).toBe(true); });\n');
		const r = await stopAndNudge(strong("caps at max"), after, [["caps at max", true]]);
		expect(gapClosed(r)).toEqual({ stale: false, nudged: false });
	});

	it("P4: a real vitest run where a strong case kills does not report SURVIVED because a later case shares its name", async () => {
		// review M3 — real vitest: `it("caps at max", strong)` then `it("caps at max", weak)`; the Map keeps the weak row
		const root = committedRepo({
			"package.json": '{"name":"fx","type":"module"}\n',
			"vitest.config.ts": 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["test/**/*.test.ts"] } });\n',
			"src/clamp.ts": SRC,
			[MK]: HEADER + strong("caps at max") + weak("caps at max"),
		}, { linkModules: true });
		const result = await proveKill({ root, spec: SPEC, tests: [MK], budgetMs: 60_000, persist: false });
		expect(result.ok && result.receipt.verdict).not.toBe("survived");
	}, REAL_RUN_MS);
});

describe("round 4 — kill-proofs --verify — positive (a current, committed proof must pass the check)", () => {
	async function provenTwice(): Promise<string> {
		const root = committedRepo({ "src/clamp.ts": SRC, [MK]: HEADER + strong("caps at max") });
		await proveKill({ root, spec: SPEC, tests: [MK], budgetMs: 1000, runner: scripted([["caps at max", true]]) });
		writeFileSync(join(root, MK), HEADER + strong("caps at max") + strong("caps again"));
		await proveKill({ root, spec: SPEC, tests: [MK], budgetMs: 1000, runner: scripted([["caps at max", true], ["caps again", true]]) });
		git(root, "add", "-A");
		git(root, "commit", "-qm", "second");
		return root;
	}

	it("P5: a superseded receipt for older test bytes does not fail --verify when a fresh committed proof exists", async () => {
		// review M8 — receipts are never retired; any old killed receipt is STALE forever and pins the exit at 1
		const root = await provenTwice();
		expect(listKillProofs(root, true).map(row => row.freshness).sort()).toEqual(["fresh", "stale"]);
		const prior = process.exitCode, write = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
		try {
			testsKillProofsCommand({ cwd: root, verify: true, json: true });
			expect(process.exitCode).toBe(0);
		} finally {
			process.stdout.write = write;
			process.exitCode = prior;
		}
	});
});

describe("round 4 — uncommittedPaths — negative (must not report FRESH for bytes it did not commit)", () => {
	it("N12: a proven test file hidden by `--skip-worktree` is UNCOMMITTED, not FRESH", async () => {
		// review M9 — `git status` does not list skip-worktree/assume-unchanged paths; the proven bytes differ from HEAD
		const root = committedRepo({ "src/clamp.ts": SRC, [MK]: HEADER + strong("caps at max") });
		git(root, "update-index", "--skip-worktree", MK);
		writeFileSync(join(root, MK), HEADER + strong("caps at max") + strong("caps again"));
		const result = await proveKill({ root, spec: SPEC, tests: [MK], budgetMs: 1000, runner: scripted([["caps at max", true], ["caps again", true]]) });
		expect(result.ok && result.receipt.verdict).toBe("killed");
		expect(git(root, "show", `HEAD:${MK}`)).not.toBe(readFileSync(join(root, MK), "utf8"));
		expect(listKillProofs(root, true).map(row => row.freshness)).toEqual(["uncommitted"]);
		expect(killProofsDir(root)).toContain(root);
	});
});
