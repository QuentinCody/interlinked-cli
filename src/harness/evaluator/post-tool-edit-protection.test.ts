// PostToolUse edit-protection nudge: an edited test that kill proofs recorded as killing a mutant.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VitestRun } from "../fail-before-fix/index.js";
import { proveKill } from "../kill-proof/run.js";
import type { HarnessEvent } from "../types.js";
import { collectEditProtectionWriteWarning, editProtectionNudge } from "./post-tool-edit-protection.js";
import { killProofNudge } from "./post-tool-kill-proof.js";

const FILE = "src/clamp.ts";
const TEST_FILE = "src/clamp.test.ts";
const KILL_FILE = "src/clamp.mutation-kill.test.ts";
const SOURCE = "export function clamp(n: number, max: number): number {\n\tif (n > max) return max;\n\treturn n;\n}\n";
const TEST = "import { clamp } from './clamp.js';\nit('caps', () => { expect(clamp(5, 3)).toBe(3); });\n";
const FAULT = { find: "if (n > max) return max;", replace: "if (n > max) return n;" };

let root: string;
const write = (path: string, text: string): void => {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), text);
};

function runner(dir: string, files: readonly string[]): Promise<VitestRun> {
	const source = readFileSync(join(dir, FILE), "utf8");
	const failed = source.includes("kill-proof canary") || source.includes(FAULT.replace);
	const cases = files.map(file => ({ file, name: "caps", title: "caps", status: failed ? "failed" as const : "passed" as const, ...(failed ? { message: "AssertionError: x" } : {}) }));
	return Promise.resolve({ cases, timedOut: false, exitCode: 0, durationMs: 1 });
}

async function seed(test: string): Promise<void> {
	write(test, TEST);
	execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
	const result = await proveKill({ root, spec: { kind: "explicit", file: FILE, ...FAULT }, tests: [test], budgetMs: 1000, runner });
	if (!result.ok || result.receipt.verdict !== "killed") throw new Error("seed proof did not kill");
}

const event = (path: string): HarnessEvent => ({ hook_event: "PostToolUse", session_id: "s", agent_source: "claude", tool_name: "Edit", tool_input: { file_path: join(root, path) }, timestamp: "2026-11-06T12:00:00.000Z", cwd: root }) as unknown as HarnessEvent;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "edit-protection-nudge-")));
	execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
	mkdirSync(join(root, ".interlinked"), { recursive: true });
	write(".gitignore", ".interlinked\n");
	write(FILE, SOURCE);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("editProtectionNudge — positive (must nudge)", () => {
	it("P1: an edited test with a killed receipt for its old bytes names the edit-protection command", async () => {
		await seed(TEST_FILE);
		write(TEST_FILE, `${TEST}// edited\n`);
		const text = editProtectionNudge(root, TEST_FILE);
		expect(text).toContain("[interlinked:edit-protection]");
		expect(text).toContain("1 kill proof(s)");
		expect(text).toContain(`interlinked tests edit-protection ${TEST_FILE}`);
	});

	it("P2: the PostToolUse entry returns the nudge for an Edit of that test", async () => {
		await seed(TEST_FILE);
		write(TEST_FILE, `${TEST}// edited\n`);
		expect(collectEditProtectionWriteWarning(event(TEST_FILE))).toHaveLength(1);
	});
});

describe("editProtectionNudge — negative (must stay silent)", () => {
	it("N1: an unedited test is silent", async () => {
		await seed(TEST_FILE);
		expect(editProtectionNudge(root, TEST_FILE)).toBeNull();
	});

	it("N2: a source file and a test without receipts are silent", async () => {
		await seed(TEST_FILE);
		expect(collectEditProtectionWriteWarning(event(FILE))).toEqual([]);
		write("src/other.test.ts", TEST);
		expect(collectEditProtectionWriteWarning(event("src/other.test.ts"))).toEqual([]);
	});

	it("N3: a mutation-directed test is left to the kill-proof nudge, which names the same command", async () => {
		await seed(KILL_FILE);
		write(KILL_FILE, `${TEST}// edited\n`);
		expect(collectEditProtectionWriteWarning(event(KILL_FILE))).toEqual([]);
		const stale = killProofNudge({ root, relPath: KILL_FILE, newCases: [], knownSurvivors: () => null });
		expect(stale).toContain("went stale");
		expect(stale).toContain(`interlinked tests edit-protection ${KILL_FILE}`);
	});
});
