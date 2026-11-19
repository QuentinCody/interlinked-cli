// `assessEditProtection`: did a test edit keep the kills its old bytes proved?
// Fake vitest runner (the verdict path itself is pinned by run.ts's own suites);
// the "before" receipts are produced by a real `proveKill` over the old test bytes,
// never hand-written.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VitestRun } from "../fail-before-fix/index.js";
import { assessEditProtection, changedTestsWithKills, type EditProtectionResult, editProtectionExitCode, priorKills } from "./edit-protection.js";
import { proveKill } from "./run.js";

const FILE = "src/clamp.ts";
const SOURCE = ["export function clamp(n: number, max: number): number {", "\tif (n > max) return max;", "\tif (n < 0) return 0;", "\treturn n;", "}", ""].join("\n");
const TEST_FILE = "src/clamp.test.ts";
const OTHER_TEST = "src/clamp.extra.test.ts";
const CAPS = "it('caps', () => { expect(clamp(5, 3)).toBe(3); });\n";
const FLOORS = "it('floors', () => { expect(clamp(-1, 3)).toBe(0); });\n";
const HEAD = "import { clamp } from './clamp.js';\n";
const TEST = HEAD + CAPS + FLOORS;
const NOW = () => new Date("2026-11-06T12:00:00Z");
const CAP_FAULT = { find: "if (n > max) return max;", replace: "if (n >= max + 1) return n;" };
const FLOOR_FAULT = { find: "if (n < 0) return 0;", replace: "if (n < 0) return n;" };

let root: string;
function git(...args: string[]): void {
	execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}
function write(path: string, text: string): void {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), text);
}

type Case = VitestRun["cases"][number];
const okRun = (cases: Case[]): VitestRun => ({ cases, timedOut: false, exitCode: 0, durationMs: 10 });

/** Answers from the COPY's bytes: a case named in a test file fails exactly when its fault is applied. */
function runner(dir: string, files: readonly string[]): Promise<VitestRun> {
	const source = readFileSync(join(dir, FILE), "utf8");
	const cases: Case[] = [];
	for (const file of files) {
		const text = readFileSync(join(dir, file), "utf8");
		for (const name of ["caps", "floors"]) {
			if (text.includes(`it.skip('${name}'`)) {
				cases.push({ file, name, title: name, status: "skipped" });
				continue;
			}
			if (!text.includes(`it('${name}'`)) continue;
			const canary = source.includes("kill-proof canary");
			const capBroken = name === "caps" && source.includes(CAP_FAULT.replace) && text.includes("toBe(3)");
			const floorBroken = name === "floors" && source.includes(FLOOR_FAULT.replace) && text.includes("toBe(0)");
			const failed = canary || capBroken || floorBroken;
			cases.push({ file, name, title: name, status: failed ? "failed" : "passed", ...(failed ? { message: canary ? "Error: canary" : "AssertionError: expected 5 to be 3" } : {}) });
		}
	}
	return Promise.resolve(okRun(cases));
}

async function prove(tests: string[], fault: { find: string; replace: string }): Promise<void> {
	const result = await proveKill({ root, spec: { kind: "explicit", file: FILE, ...fault }, tests, budgetMs: 1000, runner, now: NOW });
	if (!result.ok || result.receipt.verdict !== "killed") throw new Error(`seed proof did not kill: ${JSON.stringify(result)}`);
}

const assess = (changedSources: string[] = [], tests: string[] = [TEST_FILE]): Promise<EditProtectionResult> =>
	assessEditProtection({ root, tests, changedSources: new Set(changedSources), budgetMs: 1000, runner, now: NOW });

beforeEach(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "edit-protection-")));
	git("init", "-q");
	write(FILE, SOURCE);
	write(TEST_FILE, TEST);
	write(".gitignore", ".interlinked\n");
	git("add", ".");
	await prove([TEST_FILE], CAP_FAULT);
	await prove([TEST_FILE], FLOOR_FAULT);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("assessEditProtection — positive (must report lost protection)", () => {
	it("P1: a loosened assertion loses the kill; the source is outside the change-set, so the loss is collateral and a finding", async () => {
		write(TEST_FILE, HEAD + "it('caps', () => { expect(clamp(5, 3)).toBeLessThan(9); });\n" + FLOORS);
		const result = await assess();
		const caps = result.rows.find(row => row.mutant.replacement === CAP_FAULT.replace);
		expect(caps?.verdict).toBe("lost");
		expect(caps?.collateral).toBe(true);
		expect(result.findings.map(row => row.mutant.replacement)).toEqual([CAP_FAULT.replace]);
		expect(result.rows.find(row => row.mutant.replacement === FLOOR_FAULT.replace)?.verdict).toBe("kept");
		expect(editProtectionExitCode(result)).toBe(1);
	});

	it("P2: a deleted test file loses every kill it proved, without a run", async () => {
		unlinkSync(join(root, TEST_FILE));
		const result = await assess();
		expect(result.rows.map(row => row.verdict)).toEqual(["lost", "lost"]);
		expect(result.rows[0]?.reasons.join(" ")).toMatch(/deleted/);
		expect(result.findings).toHaveLength(2);
	});

	it("P2b: a file whose every case is skipped loses every kill: the run reports the cases, none executes", async () => {
		write(TEST_FILE, (HEAD + CAPS + FLOORS).replaceAll("it('", "it.skip('"));
		const result = await assess();
		expect(result.rows.map(row => row.verdict)).toEqual(["lost", "lost"]);
		expect(result.rows[0]?.reasons.join(" ")).toMatch(/skipped or todo/);
	});

	it("P2c: re-proving the weakened test (a survived receipt now supersedes the killed one) does not erase the loss", async () => {
		write(TEST_FILE, HEAD + FLOORS);
		const reproof = await proveKill({ root, spec: { kind: "explicit", file: FILE, ...CAP_FAULT }, tests: [TEST_FILE], budgetMs: 1000, runner, now: () => new Date("2026-11-06T13:00:00Z") });
		expect(reproof.ok && reproof.receipt.verdict).toBe("survived");
		const result = await assess();
		expect(result.findings.map(row => row.mutant.replacement)).toEqual([CAP_FAULT.replace]);
	});

	it("P3: a removed case loses only its own kill", async () => {
		write(TEST_FILE, HEAD + CAPS);
		const result = await assess();
		expect(result.findings.map(row => row.mutant.replacement)).toEqual([FLOOR_FAULT.replace]);
		expect(result.summary).toMatchObject({ kept: 1, lost: 1, collateralLost: 1 });
	});
});

describe("assessEditProtection — negative (must not report a finding)", () => {
	it("N1: a harmless edit (a new case, a comment) keeps both kills", async () => {
		write(TEST_FILE, `${TEST}// note\nit('passes through', () => { expect(clamp(1, 3)).toBe(1); });\n`);
		const result = await assess();
		expect(result.rows.map(row => row.verdict)).toEqual(["kept", "kept"]);
		expect(result.findings).toEqual([]);
		expect(editProtectionExitCode(result)).toBe(0);
	});

	it("N2: a loss in a source the change-set touched is requirement-linked: reported, not a finding", async () => {
		write(TEST_FILE, HEAD + FLOORS);
		const result = await assess([FILE]);
		expect(result.rows.find(row => row.verdict === "lost")?.collateral).toBe(false);
		expect(result.findings).toEqual([]);
		expect(result.summary.lost).toBe(1);
	});

	it("N3: another test file with a fresh kill of the same mutant still protects it: lost here, not a finding", async () => {
		write(OTHER_TEST, HEAD + CAPS);
		git("add", ".");
		await prove([OTHER_TEST], CAP_FAULT);
		write(TEST_FILE, HEAD + FLOORS);
		const result = await assess();
		const caps = result.rows.find(row => row.mutant.replacement === CAP_FAULT.replace);
		expect(caps?.verdict).toBe("lost");
		expect(caps?.otherKillers).toEqual([OTHER_TEST]);
		expect(result.findings).toEqual([]);
	});

	it("N4: a fault whose anchor the source no longer holds is retired, never re-run and never a finding", async () => {
		write(FILE, SOURCE.replace(CAP_FAULT.find, "if (n > max) { return max; }"));
		write(TEST_FILE, HEAD + FLOORS);
		const result = await assess([FILE]);
		expect(result.rows.find(row => row.mutant.replacement === CAP_FAULT.replace)?.verdict).toBe("retired");
		expect(result.findings).toEqual([]);
	});

	it("N5: an unedited test has no prior kills to judge", async () => {
		expect(priorKills(root, TEST_FILE)).toEqual([]);
		const result = await assess();
		expect(result.rows).toEqual([]);
		expect(editProtectionExitCode(result)).toBe(0);
	});
});

describe("changedTestsWithKills", () => {
	it("lists only test paths that hold a killed receipt", async () => {
		expect(changedTestsWithKills(root, [TEST_FILE, FILE, "src/none.test.ts"])).toEqual([TEST_FILE]);
	});
});

describe("editProtectionExitCode", () => {
	it("is 2 when nothing was decided and no finding exists", () => {
		const undecided = { mutant: {}, verdict: "undecided", collateral: true, otherKillers: [], reasons: ["x"] } as unknown as EditProtectionResult["rows"][number];
		expect(editProtectionExitCode({ rows: [undecided], findings: [], skipped: 0, summary: { kept: 0, lost: 0, collateralLost: 0, retired: 0, undecided: 1 } })).toBe(2);
	});
});
