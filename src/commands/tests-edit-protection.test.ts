// `interlinked tests edit-protection`: change-set discovery from git, rendering and exit codes.
// The verdict logic is pinned by harness/kill-proof/edit-protection.test.ts.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EditProtectionResult, ProtectionRow } from "../harness/kill-proof/edit-protection.js";
import { gitChangeSet, renderEditProtection, splitChangeSet, testsEditProtectionCommand } from "./tests-edit-protection.js";

let root: string;
const git = (...args: string[]): void => {
	execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
};

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "edit-protection-cmd-")));
	git("init", "-q");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
	writeFileSync(join(root, "a.test.ts"), "it('a', () => {});\n");
	writeFileSync(join(root, "b.ts"), "export const b = 1;\n");
	git("add", ".");
	git("commit", "-q", "-m", "init");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("gitChangeSet", () => {
	it("lists modified, deleted and untracked paths against the base", () => {
		writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
		unlinkSync(join(root, "a.test.ts"));
		writeFileSync(join(root, "c.ts"), "export const c = 1;\n");
		expect(gitChangeSet(root, "HEAD").sort()).toEqual(["a.test.ts", "a.ts", "c.ts"]);
	});

	it("is empty for a clean tree", () => {
		expect(gitChangeSet(root, "HEAD")).toEqual([]);
	});
});

describe("splitChangeSet", () => {
	it("separates test files from sources", () => {
		expect(splitChangeSet(["src/a.ts", "src/a.test.ts", "src/b.spec.ts"])).toEqual({ tests: ["src/a.test.ts", "src/b.spec.ts"], sources: ["src/a.ts"] });
	});
});

const row = (over: Partial<ProtectionRow>): ProtectionRow => ({
	test: "src/a.test.ts", receiptId: "0123456789abcdef", label: "explicit fault @ src/a.ts:2 `x` → `y`", verdict: "lost", collateral: true, otherKillers: [], reasons: [],
	mutant: { file: "src/a.ts", offset: 0, originalLexeme: "x", replacement: "y", line: 2, source: "explicit" }, ...over,
});

describe("renderEditProtection", () => {
	it("marks a collateral loss with no other killer as a FINDING and prints the summary", () => {
		const findingRow = row({});
		const result: EditProtectionResult = { rows: [findingRow, row({ verdict: "kept" })], findings: [findingRow], skipped: 2, summary: { kept: 1, lost: 1, collateralLost: 1, retired: 0, undecided: 0 } };
		const text = renderEditProtection(result);
		expect(text).toMatch(/FINDING/);
		expect(text).toMatch(/1 kept · 1 lost \(1 collateral\) · 0 retired · 0 undecided · 1 finding/);
		expect(text).toMatch(/2 prior kill\(s\) not judged/);
	});

	it("says so when no edited test holds a prior kill", () => {
		expect(renderEditProtection({ rows: [], findings: [], skipped: 0, summary: { kept: 0, lost: 0, collateralLost: 0, retired: 0, undecided: 0 } })).toMatch(/no edited test file holds a stale killed receipt/);
	});
});

describe("testsEditProtectionCommand", () => {
	it("exits 0 with an empty result when no test changed", async () => {
		process.exitCode = undefined;
		await testsEditProtectionCommand({ cwd: root, json: true });
		expect(process.exitCode).toBe(0);
		process.exitCode = undefined;
	});

	it("rejects a bad --max as a usage error (exit 2)", async () => {
		process.exitCode = undefined;
		await testsEditProtectionCommand({ cwd: root, max: "zero", json: true });
		expect(process.exitCode).toBe(2);
		process.exitCode = undefined;
	});
});
