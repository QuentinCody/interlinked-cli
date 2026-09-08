import { parseWire, wireArray, wireBoolean, wireObject, wireString } from "../lib/value-validation.js";
// ===========================================
// `interlinked harness clean` — wave-39 mutation-kill suite
// ===========================================
// Targets survivors from scratch/fleet-r3/w39-briefs/src_commands_harness-clean.ts.json.
// Mocks `isHarnessRunning` directly (rather than the real pid/kill dance the
// companion test uses) so each guard branch can be forced into states the
// real implementation's own return-value contract would never produce —
// necessary to distinguish several ConditionalExpression/LogicalOperator
// mutants that are otherwise unreachable through the real liveness probe.

import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { c } from "../lib/formatter.js";

const { isHarnessRunningMock } = vi.hoisted(() => ({ isHarnessRunningMock: vi.fn() }));

vi.mock("./harness.js", () => ({
	isHarnessRunning: (...args: unknown[]) => isHarnessRunningMock(...args),
}));

// Imported AFTER the mock is registered (vi.mock is hoisted by vitest, so
// static import order doesn't actually matter, but keep it explicit).
import { harnessCleanCommand } from "./harness-clean.js";

let workDir: string;
let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
	workDir = join(
		tmpdir(),
		`harness-clean-w39-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
	);
	mkdirSync(join(workDir, ".interlinked"), { recursive: true });
	cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(workDir);
	isHarnessRunningMock.mockReset();
	isHarnessRunningMock.mockReturnValue({ running: false });
});

afterEach(() => {
	cwdSpy?.mockRestore();
	rmSync(workDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function pidPath(): string {
	return join(workDir, ".interlinked", "harness.pid");
}

function sockPath(): string {
	return join(workDir, ".interlinked", "harness.sock");
}

interface CapturedStdio {
	stdout: string;
}

async function captureStdout(fn: () => Promise<void> | void): Promise<CapturedStdio> {
	const chunks: string[] = [];
	const realLog = console.log;
	const realErrorLog = console.error;
	console.log = (...args: unknown[]): void => {
		chunks.push(`${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
	};
	console.error = (): void => {
		/* swallow — not under test here */
	};
	try {
		await fn();
	} finally {
		console.log = realLog;
		console.error = realErrorLog;
	}
	return { stdout: chunks.join("") };
}

describe("harnessCleanCommand — running/pid guard (LogicalOperator / ConditionalExpression)", () => {
	// test-contract: invariant — status.running and status.pid !== undefined
	// must both gate the refusal; a real isHarnessRunning() return value never
	// splits them, so we force the split via the mock to pin the && semantics.
	it("does NOT refuse when running is true but pid is undefined (kills ca93e6b97e14edab, f7604d333d3dc8fe)", async () => {
		isHarnessRunningMock.mockReturnValue({ running: true, pid: undefined });
		const previousExitCode = process.exitCode;
		const captured = await captureStdout(() => harnessCleanCommand({ json: true }));
		const exitCode = process.exitCode;
		process.exitCode = previousExitCode;

		// Original: running(true) AND pid-defined(false) evaluates false, so the
		// refusal path is skipped and the command proceeds normally. Either the
		// LogicalOperator mutant or the ConditionalExpression mutant flips that
		// evaluation to true, triggering a refusal that must not happen here.
		expect(exitCode).toBe(previousExitCode);
		// SAFETY: harnessCleanCommand({ json: true }) always emits this shape; asserted structurally below
		const parsed = parseWire(JSON.parse(captured.stdout), wireObject({ "ok": wireBoolean, "removed": wireArray(wireString) }), "test JSON value");
		expect(parsed.ok).toBe(true);
	});
});

describe("harnessCleanCommand — removed[] accumulation (ArrayDeclaration / outer guards)", () => {
	// test-contract: invariant — removed starts empty; only files that were
	// actually snapshotted as present get pushed.
	it("reports removed: [] when neither file exists (kills 09d6349202b82fd8)", async () => {
		const captured = await captureStdout(() => harnessCleanCommand({ json: true }));
		// SAFETY: harnessCleanCommand({ json: true }) always emits this shape; asserted structurally below
		const parsed = parseWire(JSON.parse(captured.stdout), wireObject({ "ok": wireBoolean, "removed": wireArray(wireString) }), "test JSON value");
		expect(parsed.removed).toEqual([]);
	});

	// test-contract: invariant — only the pid entry is reported when only the
	// pid file was present at snapshot time (sock outer guard must not fire).
	it("reports removed: [pidPath] only, and physically deletes it, when only the pid file exists (kills a92a0fd2eb6b6bce, 9836d40d8088f7e4)", async () => {
		writeFileSync(pidPath(), "123");
		const captured = await captureStdout(() => harnessCleanCommand({ json: true }));
		// SAFETY: harnessCleanCommand({ json: true }) always emits this shape; asserted structurally below
		const parsed = parseWire(JSON.parse(captured.stdout), wireObject({ "ok": wireBoolean, "removed": wireArray(wireString) }), "test JSON value");
		expect(parsed.removed).toEqual([pidPath()]);
		// existsSync(pidPath) mutated to `false` would skip the real unlinkSync
		// call entirely while still reporting it removed — catch that here.
		expect(existsSync(pidPath())).toBe(false);
	});

	// test-contract: invariant — only the sock entry is reported when only the
	// sock file was present at snapshot time (pid outer guard must not fire).
	it("reports removed: [sockPath] only when only the sock file exists (kills d2f23ea4025e387e)", async () => {
		writeFileSync(sockPath(), "");
		const captured = await captureStdout(() => harnessCleanCommand({ json: true }));
		// SAFETY: harnessCleanCommand({ json: true }) always emits this shape; asserted structurally below
		const parsed = parseWire(JSON.parse(captured.stdout), wireObject({ "ok": wireBoolean, "removed": wireArray(wireString) }), "test JSON value");
		expect(parsed.removed).toEqual([sockPath()]);
	});

	// Forces the sock file to vanish (via a side effect on the mocked liveness
	// probe) between the pre-snapshot and the removal pass, so
	// existsSync(sockPath) is really false when the removal code reaches it.
	// Original code still reports it removed (best-effort semantics); the
	// ConditionalExpression mutant that pins existsSync(sockPath) to `true`
	// instead calls unlinkSync on an already-missing file, throws ENOENT, and
	// the catch swallows the push, so the mutant's removed[] omits it.
	// test-contract: bug — best-effort removal reporting under a fs race
	it("still reports the sock path as removed even if it vanishes mid-run (kills df8511085b0f63b1)", async () => {
		writeFileSync(sockPath(), "");
		isHarnessRunningMock.mockImplementation(() => {
			unlinkSync(sockPath());
			return { running: false };
		});
		const captured = await captureStdout(() => harnessCleanCommand({ json: true }));
		// SAFETY: harnessCleanCommand({ json: true }) always emits this shape; asserted structurally below
		const parsed = parseWire(JSON.parse(captured.stdout), wireObject({ "ok": wireBoolean, "removed": wireArray(wireString) }), "test JSON value");
		expect(parsed.removed).toContain(sockPath());
	});
});

describe("harnessCleanCommand — formatHumanOutput exact text (BlockStatement / literals / arithmetic)", () => {
	// test-contract: public-api — the exact human-readable message shown when
	// nothing was removed; pins the "0 files" branch, its literal string, the
	// early-return block body, and the join separator against every mutant
	// that could alter or blank any of them.
	it("prints the exact dim 'no stale files' message when removed is empty (kills 7ebd1c963c02509e, 17e0a2674c83440b (n/a here), 1f5ef40fff473f89, 7d82a6908f69e782, 6a1a26d90c5dc5e2, aa064e8e7fe71be1)", async () => {
		const captured = await captureStdout(() => harnessCleanCommand({}));
		expect(captured.stdout).toBe(`${c.dim("No stale harness state files found.")}\n`);
	});

	// test-contract: public-api — exact singular-form message with exactly one
	// removed file; pins the lines[] initial value, the header template
	// (including the "0/1 → no 's'" ternary and its branches), and the
	// per-path loop body / template / join separator.
	it("prints the exact singular message with one removed file (kills 09d6349202b82fd8/f3009b9a86e53b0d overlap, 3cd08dfa7524597c, 541636895025ff78, f8320219c9d4383e (n/a here), 57533e88ddbe1ac0, 075bbc36d6e9a912, f791cd541c9300bd, 70b01558827a4569, f49edd30c80eb4bd)", async () => {
		writeFileSync(pidPath(), "123");
		const captured = await captureStdout(() => harnessCleanCommand({}));
		const expected = [
			c.green(`Removed 1 stale file:`),
			`  ${c.dim(pidPath())}`,
		].join("\n");
		expect(captured.stdout).toBe(`${expected}\n`);
	});

	// test-contract: public-api — exact plural-form message with two removed
	// files; pins the "===1" comparison's `true` branch away from a >1 count,
	// and the "s" suffix literal.
	it("prints the exact plural message with two removed files (kills 17e0a2674c83440b, f8320219c9d4383e, 51a28eeed7431e43)", async () => {
		writeFileSync(pidPath(), "123");
		writeFileSync(sockPath(), "");
		const captured = await captureStdout(() => harnessCleanCommand({}));
		const expected = [
			c.green(`Removed 2 stale files:`),
			`  ${c.dim(pidPath())}`,
			`  ${c.dim(sockPath())}`,
		].join("\n");
		expect(captured.stdout).toBe(`${expected}\n`);
	});
});

describe("harnessCleanCommand — normal-renderer wiring (ArrowFunction)", () => {
	// test-contract: public-api — the `normal` renderer passed to output()
	// must actually call formatHumanOutput; if replaced with a no-op returning
	// undefined, console.log would print the literal string "undefined".
	it("never prints the literal string 'undefined' in normal mode (kills 572d4818dc02d00a)", async () => {
		const captured = await captureStdout(() => harnessCleanCommand({}));
		expect(captured.stdout).not.toBe("undefined\n");
		expect(captured.stdout.trim()).not.toBe("undefined");
	});
});
