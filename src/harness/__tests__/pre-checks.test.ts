import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process BEFORE importing the module under test — getProtectedPids()
// calls execSync the first time checkSelfKill runs, and that result is cached for
// the process lifetime, so the mock must be installed at import time. This mock
// has no effect on the checkLargeFileLineCountWrite tests below (they never call
// execSync), so it is safe to install file-wide.
vi.mock("node:child_process", () => ({
	execSync: vi.fn(() => ""),
}));

import { execSync as mockedExecSync } from "node:child_process";

import { DEFAULT_MAX_LINES, resetLargeFileBaselineCache } from "../large-file-policy.js";
import {
	checkConcurrentEdit,
	checkDirtyWorkingTree,
	checkEnvLeakToGit,
	checkLargeFileLineCountWrite,
	checkLargeFileWrite,
	checkSelfKill,
	checkStaleBranch,
} from "../pre-checks.js";
import type { SessionTrajectory } from "../types.js";

const execSyncMock = vi.mocked(mockedExecSync);

/** Build a string of exactly `n` lines of code. */
function lines(n: number): string {
	return Array.from({ length: n }, () => "const x = 1;").join("\n");
}

/**
 * Minimal SessionTrajectory fixture. checkConcurrentEdit only reads
 * session_id / files_written / file_write_times / agent_name, so the cast keeps
 * the fixture readable without wiring the full (~50-field) interface.
 */
function makeSession(over: {
	id: string;
	agentName?: string;
	written?: string[];
	writeTimes?: Array<[string, string]>;
}): SessionTrajectory {
	const base = {
		session_id: over.id,
		agent_name: over.agentName ?? "",
		files_written: new Set<string>(over.written ?? []),
		file_write_times: new Map<string, string>(over.writeTimes ?? []),
	};
	return { ...completeSessionFixture(), ...base };
}

describe("checkLargeFileLineCountWrite", () => {
	let dir: string;
	// Fixtures are relative to THE canonical cap so the suite tests the real
	// number (not a hardcoded 1500) and survives future ratcheting unchanged.
	const CAP = DEFAULT_MAX_LINES;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pre-checks-cap-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const file = (name: string): string => join(dir, name);

	// --- Blocks (the write would grow a cappable file past the cap) ---

	it("blocks a brand-new code file written over the cap", () => {
		const result = checkLargeFileLineCountWrite(
			{ file_path: file("big.ts"), content: lines(CAP + 600) },
			dir,
		);
		expect(result?.block).toContain(`${CAP}-line cap`);
	});

	it("allows an over-cap file OUTSIDE the guarded root — session scratchpad artifact", () => {
		// Live incident 2026-07-15: a 586-line self-contained HTML artifact in
		// the host session scratchpad was blocked by the repo's 500-line cap —
		// and the block steered the agent toward compressing formatting to duck
		// under it. The cap is repo policy; out-of-root files are not governed.
		const scratchpad = mkdtempSync(join(tmpdir(), "claude-501-scratch-"));
		try {
			for (const name of ["pcos-monograph.html", "probe.ts"]) {
				const result = checkLargeFileLineCountWrite(
					{ file_path: join(scratchpad, name), content: lines(CAP + 600) },
					dir,
				);
				expect(result).toBeNull();
			}
		} finally {
			rmSync(scratchpad, { recursive: true, force: true });
		}
	});

	it("blocks a Write that grows an existing under-cap file past the cap", () => {
		const path = file("grow.ts");
		writeFileSync(path, lines(CAP));
		const result = checkLargeFileLineCountWrite({ file_path: path, content: lines(CAP + 700) }, dir);
		expect(result?.block).toBeDefined();
	});

	it("blocks an Edit that grows a near-cap file past the cap", () => {
		const path = file("edit.ts");
		writeFileSync(path, lines(CAP - 10));
		const result = checkLargeFileLineCountWrite(
			{ file_path: path, old_string: "const x = 1;", new_string: lines(21) },
			dir,
		);
		expect(result?.block).toBeDefined();
	});

	it("blocks a MultiEdit whose net growth crosses the cap", () => {
		const path = file("multi.ts");
		writeFileSync(path, lines(CAP - 5));
		const result = checkLargeFileLineCountWrite(
			{ file_path: path, edits: [{ old_string: "const x = 1;", new_string: lines(20) }] },
			dir,
		);
		expect(result?.block).toBeDefined();
	});

	it("blocks an Edit that grows an already-over-cap file", () => {
		const path = file("already-big.ts");
		const before = CAP + 800;
		writeFileSync(path, lines(before));
		const result = checkLargeFileLineCountWrite(
			{ file_path: path, old_string: "const x = 1;", new_string: lines(10) },
			dir,
		);
		expect(result?.block).toContain(`already ${before} lines`);
	});

	// --- Allows (within cap, shrinking, or exempt) ---

	it("allows a new code file under the cap", () => {
		expect(
			checkLargeFileLineCountWrite({ file_path: file("ok.ts"), content: lines(CAP - 100) }, dir),
		).toBeNull();
	});

	it("allows an Edit that shrinks an over-cap file (refactor-down)", () => {
		const path = file("shrink.ts");
		writeFileSync(path, lines(CAP + 800));
		const result = checkLargeFileLineCountWrite(
			{ file_path: path, old_string: lines(200), new_string: lines(50) },
			dir,
		);
		expect(result).toBeNull();
	});

	it("allows a Write that holds an over-cap file at its current size", () => {
		const path = file("hold.ts");
		writeFileSync(path, lines(CAP + 600));
		expect(
			checkLargeFileLineCountWrite({ file_path: path, content: lines(CAP + 600) }, dir),
		).toBeNull();
	});

	it("does not cap test files", () => {
		expect(
			checkLargeFileLineCountWrite(
				{ file_path: file("huge.test.ts"), content: lines(CAP + 1200) },
				dir,
			),
		).toBeNull();
	});

	it("does not cap non-code files", () => {
		expect(
			checkLargeFileLineCountWrite({ file_path: file("notes.md"), content: lines(CAP + 1200) }, dir),
		).toBeNull();
	});

	it("does not cap generated files", () => {
		const content = `// @generated\n${lines(CAP + 600)}`;
		expect(
			checkLargeFileLineCountWrite({ file_path: file("schema.ts"), content }, dir),
		).toBeNull();
	});

	it("honors a custom max_lines from the baseline (cap value is read, not hardcoded)", () => {
		// A stricter baseline must lower the cap: a file fine under the default
		// must block under the baseline's smaller max_lines.
		const customCap = CAP - 200;
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(dir, ".interlinked", "large-files-baseline.json"),
			JSON.stringify({ version: 1, max_lines: customCap, files: {} }),
		);
		resetLargeFileBaselineCache();
		const path = file("cfg.ts");
		writeFileSync(path, lines(customCap + 50)); // under default CAP, over customCap
		const result = checkLargeFileLineCountWrite(
			{ file_path: path, old_string: "const x = 1;", new_string: lines(5) },
			dir,
		);
		expect(result?.block).toContain(`${customCap}-line cap`);
	});

	it("fails open on tool shapes it cannot project (apply_patch)", () => {
		expect(
			checkLargeFileLineCountWrite({ file_path: file("x.ts"), patch: "@@ -1 +1 @@" }, dir),
		).toBeNull();
	});

	// --- Comment-only growth (field report 2026-07-06): raw lines may grow
	// --- past the cap when the net added lines are entirely comments/blank.

	it("allows an Edit that adds only // comment lines to an over-cap file", () => {
		const path = file("comment-grow.ts");
		writeFileSync(path, lines(CAP + 100));
		const result = checkLargeFileLineCountWrite(
			{
				file_path: path,
				old_string: "const x = 1;",
				new_string: "const x = 1;\n// why: field-report clarification\n// see docs/design",
			},
			dir,
		);
		expect(result).toBeNull();
	});

	it("allows an Edit that adds a multi-line /* */ block comment to an over-cap file", () => {
		const path = file("block-comment-grow.ts");
		writeFileSync(path, lines(CAP + 100));
		const result = checkLargeFileLineCountWrite(
			{
				file_path: path,
				old_string: "const x = 1;",
				new_string: "const x = 1;\n/*\n * rationale paragraph\n */",
			},
			dir,
		);
		expect(result).toBeNull();
	});

	it("allows a Write that grows an over-cap file by blank + comment lines only", () => {
		const path = file("write-comments.ts");
		writeFileSync(path, lines(CAP + 100));
		const result = checkLargeFileLineCountWrite(
			{ file_path: path, content: `${lines(CAP + 100)}\n\n// trailing note\n// second note` },
			dir,
		);
		expect(result).toBeNull();
	});

	it("allows a comment line to carry an at-cap file over the raw cap", () => {
		const path = file("at-cap.ts");
		writeFileSync(path, lines(CAP));
		const result = checkLargeFileLineCountWrite(
			{ file_path: path, old_string: "const x = 1;", new_string: "const x = 1;\n// clarifier" },
			dir,
		);
		expect(result).toBeNull();
	});

	// Pins the grandfather interaction: comment-only growth is allowed WITHOUT
	// raising the recorded ceiling — the gate never touches the baseline file
	// (ceilings only shrink; the verify-side large_files check still judges
	// raw lines against the recorded ceiling).
	it("comment-only growth on a grandfathered file is allowed and leaves the baseline untouched", () => {
		const path = file("grandfathered.ts");
		const recorded = CAP + 300;
		writeFileSync(path, lines(recorded));
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const baselinePath = join(dir, ".interlinked", "large-files-baseline.json");
		const baselineJson = JSON.stringify({
			version: 1,
			max_lines: CAP,
			files: { "grandfathered.ts": recorded },
		});
		writeFileSync(baselinePath, baselineJson);
		resetLargeFileBaselineCache();
		const result = checkLargeFileLineCountWrite(
			{
				file_path: path,
				old_string: "const x = 1;",
				new_string: "const x = 1;\n// note past ceiling",
			},
			dir,
		);
		expect(result).toBeNull();
		expect(readFileSync(baselinePath, "utf-8")).toBe(baselineJson); // ceiling not raised
	});

	it("still blocks an Edit that adds a single CODE line to an over-cap file", () => {
		const path = file("code-grow.ts");
		writeFileSync(path, lines(CAP + 100));
		const result = checkLargeFileLineCountWrite(
			{ file_path: path, old_string: "const x = 1;", new_string: "const x = 1;\nconst y = 2;" },
			dir,
		);
		expect(result?.block).toBeDefined();
	});

	it("still blocks a MIXED edit (comments + code) whose code line count grows", () => {
		const path = file("mixed-grow.ts");
		writeFileSync(path, lines(CAP + 100));
		const result = checkLargeFileLineCountWrite(
			{
				file_path: path,
				old_string: "const x = 1;",
				new_string: "const x = 1;\n// explains y\nconst y = 2;",
			},
			dir,
		);
		expect(result?.block).toBeDefined();
	});

	it("still blocks comment-laundered code: template-literal data lines count as code", () => {
		const path = file("tpl-grow.ts");
		writeFileSync(path, lines(CAP + 100));
		const result = checkLargeFileLineCountWrite(
			{
				file_path: path,
				old_string: "const x = 1;",
				new_string: "const x = 1;\nconst tpl = `\n  data row 1\n  data row 2\n`;",
			},
			dir,
		);
		expect(result?.block).toBeDefined();
	});

	// --- Survivor-elimination additions (docs/plans/15-survivor-elimination-campaign.md) ---
	// Each test below targets a SPECIFIC surviving mutant identified by
	// `npx tsx scratch/measure-file.mts src/harness/pre-checks.ts` — the line/
	// mutator noted in each name is the mutant it kills.

	it("falls back to `path` when `file_path` is present but not a string (L377)", () => {
		const path = file("frompath-fallback.ts");
		// file_path is a NUMBER (malformed tool input) — the typeof guard must
		// reject it and fall through to the valid `path` field instead of using
		// the number as-is.
		const result = checkLargeFileLineCountWrite(
			{ file_path: 123, path, content: lines(CAP + 600) },
			dir,
		);
		expect(result?.block).toContain(path);
	});

	it("uses `path` when `file_path` is absent (L378)", () => {
		const path = file("viapath-only.ts");
		const result = checkLargeFileLineCountWrite({ path, content: lines(CAP + 600) }, dir);
		expect(result?.block).toContain(path);
	});

	it("ignores a non-string `path` when `file_path` is also absent (L378)", () => {
		const result = checkLargeFileLineCountWrite({ path: 123, content: lines(CAP + 600) }, dir);
		expect(result).toBeNull();
	});

	it("returns null when neither file_path nor path is present (L379/L380)", () => {
		expect(checkLargeFileLineCountWrite({ content: lines(CAP + 600) }, dir)).toBeNull();
	});

	it("allows a brand-new file at EXACTLY the cap — boundary of after <= cap (L389)", () => {
		expect(
			checkLargeFileLineCountWrite(
				{ file_path: file("exact-cap-new.ts"), content: lines(CAP) },
				dir,
			),
		).toBeNull();
	});

	it("allows a hold that swaps comment lines for code lines — raw count is the only signal (L390)", () => {
		// Line 390's "not growing" bypass looks ONLY at the raw line count, by
		// design (its own comment: "refactoring down is always allowed"). This
		// holds even when the swap converts comments into code — the total line
		// count does not change, so the bypass fires before the code-line check
		// at line 401 is ever reached.
		const path = file("hold-swap.ts");
		const commentBlock = Array.from({ length: 10 }, (_, i) => `// note ${i}`).join("\n");
		writeFileSync(path, `${lines(CAP)}\n${commentBlock}`);
		const result = checkLargeFileLineCountWrite(
			{ file_path: path, old_string: commentBlock, new_string: lines(10) },
			dir,
		);
		expect(result).toBeNull();
	});

	it("still allows a genuine shrink whose CODE lines increase — 390 fires before the code-line check (L390)", () => {
		const path = file("shrink-more-code.ts");
		// CAP code lines + 200 comment lines = CAP+200 total.
		const commentBlock = Array.from({ length: 200 }, (_, i) => `// c${i}`).join("\n");
		writeFileSync(path, `${lines(CAP)}\n${commentBlock}`);
		// Replace the 200 comment lines with 5 new code lines: -195 net lines.
		const newCode = Array.from({ length: 5 }, (_, i) => `const nc${i} = 1;`).join("\n");
		const result = checkLargeFileLineCountWrite(
			{ file_path: path, old_string: commentBlock, new_string: newCode },
			dir,
		);
		// before = CAP+200, after = CAP+5: a real shrink (after < before), even
		// though code lines rose from CAP to CAP+5 — still always-allowed.
		expect(result).toBeNull();
	});

	it("says 'grow' (not 'create') when extending an EXISTING file past the cap (L408: before!==0 branch)", () => {
		// Complements the brand-new-file (before===0) exact-message test below:
		// that one alone doesn't discriminate a mutant that forces the ternary's
		// condition to always take the `before === 0` arm, because before
		// really IS 0 there. This test's before is nonzero (an existing file),
		// so "always create" and "always grow" mutants disagree with reality.
		const path = file("grow-wording.ts");
		writeFileSync(path, lines(10));
		const result = checkLargeFileLineCountWrite(
			{ file_path: path, content: lines(CAP + 50) },
			dir,
		);
		expect(result?.block).toContain(`grow ${path} to`);
		expect(result?.block).not.toContain(`create ${path} at`);
	});

	it("emits the exact BLOCKED message for a brand-new over-cap file — pins every literal + the delta arithmetic (L408/L410/L412/L415-L420)", () => {
		const path = file("exact-message.ts");
		const after = CAP + 600;
		const result = checkLargeFileLineCountWrite({ file_path: path, content: lines(after) }, dir);
		expect(result?.block).toBe(
			`[interlinked:file-size] BLOCKED: this would create ${path} at ${after} lines — ` +
				`${after - CAP} over the ${CAP}-line cap for hand-written code files. ` +
				"Extract a cohesive section into its own module first. This line cap is per-repo " +
				"configurable: `interlinked caps set lines <n>` (`caps explain lines` for why); " +
				"generated, test, .d.ts, and non-code files (docs/markdown/HTML/data) are exempt. " +
				"List: large-files-baseline.json.",
		);
	});

	it("does not say 'already' when a growing edit crosses the cap from EXACTLY at it (L410)", () => {
		const path = file("cross-from-exact-cap.ts");
		writeFileSync(path, lines(CAP)); // before === cap exactly — not YET over
		const result = checkLargeFileLineCountWrite(
			{ file_path: path, old_string: "const x = 1;", new_string: lines(11) },
			dir,
		);
		expect(result?.block).toBeDefined();
		expect(result?.block).not.toContain("already");
	});
});

// =====================================================================
// checkSelfKill + getProtectedPids()
// =====================================================================
// getProtectedPids caches at module scope, populated by the first checkSelfKill
// call. This block runs first so the very first invocation exercises the ps
// ancestor-walk and the harness-pid-file read; later cases reuse the cache.
//
// NOTE on why this duplicates part of pre-checks.coverage.integration.test.ts:
// the per-edit mutation runner resolves a file's companion test by EXACT STEM
// match (`pre-checks.ts` -> a `pre-checks.test.ts`-named file), so a
// differently-named sibling test file — however thorough — is invisible to it
// (recorded gap: mutation runner test-file scoping, tracked separately). The
// tests below give this module's OTHER exported checks real reachability
// under the file the runner actually measures.

describe("checkSelfKill + getProtectedPids", () => {
	// A pid we plant as an ancestor of process.ppid so the protected set is
	// non-trivial and the ancestor-walk loop body executes.
	const PLANTED_ANCESTOR = 424242;
	let pidDir: string;
	// SPY, not process.chdir(): chdir THROWS in a worker thread
	// ("process.chdir() is not supported in workers"), and Stryker's vitest
	// runner pins its own pool, so a real chdir here fails the mutation dry run
	// for any file whose graph-selected test scope includes this one.
	// getProtectedPids resolves the pid file via `join(process.cwd(), ...)`, so
	// the spy exercises the same path.
	let cwdSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		execSyncMock.mockReset();
		execSyncMock.mockReturnValue("");
		pidDir = mkdtempSync(join(tmpdir(), "pre-checks-pid-"));
		mkdirSync(join(pidDir, ".interlinked"), { recursive: true });
		// A readable, numeric harness.pid → exercises the parse + add branch.
		writeFileSync(join(pidDir, ".interlinked", "harness.pid"), "777777\n");
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(pidDir);

		// `ps -ax` listing: map process.ppid -> PLANTED_ANCESTOR -> 1 (init),
		// so the ancestor walk adds ppid then PLANTED_ANCESTOR then stops at init.
		// A junk line and a self->1 line exercise the regex filter.
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("ps -o pid=,ppid= -ax")) {
				return [
					"garbage line that does not match",
					`${process.ppid} ${PLANTED_ANCESTOR}`,
					`${PLANTED_ANCESTOR} 1`,
					"1 0",
				].join("\n");
			}
			return "";
		});
	});

	afterEach(() => {
		cwdSpy.mockRestore();
		rmSync(pidDir, { recursive: true, force: true });
	});

	it("returns null for a command that is not a plain `kill <pid>`", () => {
		expect(checkSelfKill("ls -la")).toBeNull();
		expect(checkSelfKill("kill -9 1234")).toBeNull(); // signal form not matched
		expect(checkSelfKill("killall node")).toBeNull();
	});

	it("blocks killing the current process (self) — primes the protected-pid cache", () => {
		// First checkSelfKill call in the module: builds + caches the protected
		// set, walking the planted ancestor chain and reading harness.pid.
		const result = checkSelfKill(`  kill ${process.pid}  `);
		expect(result?.block).toContain(`PID ${process.pid}`);
		expect(result?.block).toContain("terminate this session");
		// The ps ancestor-walk ran during cache build.
		expect(execSyncMock).toHaveBeenCalled();
		expect(execSyncMock).toHaveBeenCalledWith("ps -o pid=,ppid= -ax 2>/dev/null", {
			encoding: "utf-8",
			timeout: 2000,
		});
	});

	it("blocks killing a planted ancestor PID (ancestor-walk populated the set)", () => {
		// Cache is already warm from the previous test; the planted ancestor is
		// in the set even though we changed cwd this test.
		const result = checkSelfKill(`kill ${PLANTED_ANCESTOR}`);
		expect(result?.block).toContain(`PID ${PLANTED_ANCESTOR}`);
	});

	it("blocks killing the harness pid read from harness.pid", () => {
		const result = checkSelfKill("kill 777777");
		expect(result?.block).toBeDefined();
	});

	it("warns when target resolves to a live (non-orphan) Claude/Interlinked process", () => {
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("-p 555")) {
				// ppid 999 (>1, non-orphan) + a node interlinked harness arg line.
				return "  999 node    node /x/interlinked/harness/server.js";
			}
			return "";
		});
		const result = checkSelfKill("kill 555");
		expect(result?.warning).toContain("PID 555");
		expect(result?.warning).toContain("another session");
	});

	it("allows killing an ORPHAN harness daemon (ppid <= 1) silently", () => {
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("-p 556")) {
				// ppid 1 = orphan → isOrphan true → not blocked, not warned.
				return "  1 node    node /x/interlinked/harness/server.js";
			}
			return "";
		});
		expect(checkSelfKill("kill 556")).toBeNull();
	});

	it("returns null when target is an unrelated process (not claude/interlinked)", () => {
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("-p 557")) return "  999 bash    /bin/bash -l";
			return "";
		});
		expect(checkSelfKill("kill 557")).toBeNull();
	});

	it("warns when the process arg matches the `harness/server` operand (live)", () => {
		// node + harness/server (no 'claude'/'interlinked' word) → exercises the
		// third operand of the isClaudeOrInterlinked OR.
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("-p 560")) return "  999 node    node /opt/x/harness/server.js";
			return "";
		});
		expect(checkSelfKill("kill 560")?.warning).toBeDefined();
	});

	it.each([
		["bun", 565],
		["deno", 566],
	])("recognizes a live %s interpreter as a session process", (runtime, pid) => {
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes(`-p ${pid}`)) return `999 ${runtime} ${runtime} /x/interlinked/harness/server.js`;
			return "";
		});
		expect(checkSelfKill(`kill ${pid}`)?.warning).toContain("another session");
	});

	it("does not classify a command mentioning Claude without a supported interpreter as live", () => {
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("-p 567")) return "999 bash /tmp/claude-not-a-runtime-wrapper";
			return "";
		});
		expect(checkSelfKill("kill 567")).toBeNull();
	});

	it("trims and limits the live-process preview before placing it in the warning", () => {
		const raw = `999 node /x/interlinked ${" ".repeat(70)}TAIL`;
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("-p 568")) return raw;
			return "";
		});
		const preview = raw.slice(0, 80).trim();
		expect(checkSelfKill("kill 568")?.warning).toBe(
			`PID 568 appears to be a live Claude Code or Interlinked process in another session (${preview}). Killing it will terminate that session — proceed only if intended.`,
		);
	});

	it("returns null when an interpreter runs but the command is unrelated (no claude/interlinked)", () => {
		// node present but none of claude/interlinked/harness-server → second OR
		// clause is false → isClaudeOrInterlinked false → no warning.
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("-p 561")) return "  999 node    node /tmp/build-script.js";
			return "";
		});
		expect(checkSelfKill("kill 561")).toBeNull();
	});

	it("returns null when the ps lookup for the target throws (catch path)", () => {
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("-p 558")) throw new Error("no such process");
			return "";
		});
		expect(checkSelfKill("kill 558")).toBeNull();
	});

	it("returns null when the target ps output has no parseable ppid", () => {
		// Empty/garbage info → ppidMatch null → targetPpid 0 → isOrphan true.
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("-p 559")) return "node interlinked harness/server no-leading-pid";
			return "";
		});
		expect(checkSelfKill("kill 559")).toBeNull();
	});

	// --- Regex-precision adversarial cases (kill-command matcher, L95) ---
	// The `/^\s*kill\s+(\d+)\s*$/` matcher deliberately excludes anything that
	// ISN'T a bare `kill <pid>` invocation. Each case below is a real command
	// shape that must NOT be treated as a self-kill, and each one distinguishes
	// the regex's anchors/quantifiers from a looser or stricter variant.

	it("does not match `xkill` — trailing-substring commands must not fire (anchor precision)", () => {
		// A real X11 utility. Without the leading `^` anchor, a laxer matcher
		// would find "kill 1234" inside "xkill 1234" and misfire.
		expect(checkSelfKill("xkill 1234")).toBeNull();
	});

	it("does not match `kill <pid> <trailing garbage>` — trailing anchor precision", () => {
		// Without the trailing `$` anchor, a laxer matcher would match the
		// "kill 1234" PREFIX and ignore " extra".
		expect(checkSelfKill("kill 1234 extra")).toBeNull();
	});

	it("still blocks self-kill across MULTIPLE spaces between `kill` and the pid", () => {
		// `\s+` (one-or-more) must span more than one space; a matcher
		// collapsed to a single mandatory whitespace char would fail here.
		expect(checkSelfKill(`kill  ${process.pid}`)?.block).toBeDefined();
	});

	// --- Regex-precision adversarial cases (target-ppid matcher, L124) ---
	// `/^\s*(\d+)\s/` extracts the ppid from `ps -o ppid=,comm=,args=` output.

	it("resolves ppid with NO leading whitespace (leading \\s* is optional, not mandatory)", () => {
		execSyncMock.mockImplementation((cmd: string) => {
			// No leading space before the ppid digits — a matcher that requires
			// a leading \D+ (character-class negation) or a mandatory leading
			// \s would fail to parse this, misreading it as orphaned (ppid 0).
			if (cmd.includes("-p 562")) return "999 node interlinked";
			return "";
		});
		expect(checkSelfKill("kill 562")?.warning).toBeDefined();
	});

	it("does not treat a digit run PRECEDED by other text as the ppid (leading anchor precision)", () => {
		execSyncMock.mockImplementation((cmd: string) => {
			// "xxx999" — a matcher without the leading `^` anchor would still
			// find "999 " and misparse ppid=999 (non-orphan); the real
			// (anchored) regex must fail here, reading ppid as unparseable (0,
			// orphan) instead.
			if (cmd.includes("-p 563")) return "xxx999 node interlinked";
			return "";
		});
		expect(checkSelfKill("kill 563")).toBeNull();
	});

	it("requires WHITESPACE (not any char) immediately after the ppid digits (trailing class precision)", () => {
		execSyncMock.mockImplementation((cmd: string) => {
			// "2node" — digits immediately followed by a letter, no whitespace.
			// A matcher with the trailing \s negated to \S would wrongly parse
			// ppid=2 (non-orphan, "2"<=1 is false) and warn; the real regex
			// requires whitespace there and must fail to parse (ppid 0, orphan,
			// silent allow).
			if (cmd.includes("-p 564")) return "2node interlinked";
			return "";
		});
		expect(checkSelfKill("kill 564")).toBeNull();
	});
});

// =====================================================================
// getProtectedPids fail-open branches — fresh module via vi.resetModules()
// =====================================================================
// The block above warms the cache with a happy-path ps result. To hit the
// getProtectedPids catch blocks (ps throws; harness.pid unreadable/NaN) we need
// a COLD module so getProtectedPids runs again with hostile execSync/fs state.

describe("getProtectedPids fail-open paths (cold module)", () => {
	let coldDir: string;
	// SPY, not process.chdir(): chdir THROWS in a worker thread
	// ("process.chdir() is not supported in workers"), and Stryker's vitest
	// runner pins its own pool, so a real chdir here fails the mutation dry run
	// for any file whose graph-selected test scope includes this one.
	// getProtectedPids resolves the pid file via `join(process.cwd(), ...)`, so
	// the spy exercises the same path.
	let cwdSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		coldDir = mkdtempSync(join(tmpdir(), "pre-checks-cold-"));
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(coldDir);
		vi.resetModules();
	});

	afterEach(() => {
		cwdSpy.mockRestore();
		rmSync(coldDir, { recursive: true, force: true });
	});

	it("survives ps throwing AND a non-numeric harness.pid (both catch/NaN paths)", async () => {
		mkdirSync(join(coldDir, ".interlinked"), { recursive: true });
		// Non-numeric pid → Number.parseInt NaN → the !Number.isNaN guard skips add.
		writeFileSync(join(coldDir, ".interlinked", "harness.pid"), "not-a-number");

		vi.doMock("node:child_process", () => ({
			execSync: vi.fn(() => {
				throw new Error("ps unavailable");
			}),
		}));
		const mod = await import("../pre-checks.js");
		// Self-kill still blocks (process.pid added before the ps walk), proving
		// getProtectedPids returned a usable set despite both failures.
		const result = mod.checkSelfKill(`kill ${process.pid}`);
		expect(result?.block).toBeDefined();
	});

	it("survives when reading harness.pid itself throws (fs catch path)", async () => {
		// harness.pid exists as a DIRECTORY → existsSync true but readFileSync
		// throws (EISDIR) → exercises the inner try/catch around the pid-file
		// read; and ps throws too.
		mkdirSync(join(coldDir, ".interlinked", "harness.pid"), { recursive: true });
		vi.doMock("node:child_process", () => ({
			execSync: vi.fn(() => {
				throw new Error("ps boom");
			}),
		}));
		const mod = await import("../pre-checks.js");
		expect(mod.checkSelfKill(`kill ${process.pid}`)?.block).toBeDefined();
	});

	it("works when no harness.pid file exists (existsSync false branch, ps OK)", async () => {
		// No .interlinked/harness.pid (the common case) → the existsSync guard's
		// false branch is taken and the pid-file read is skipped. ps returns a
		// clean ancestor chain so the walk runs normally.
		vi.doMock("node:child_process", () => ({
			execSync: vi.fn((cmd: string) => {
				if (typeof cmd === "string" && cmd.includes("ps -o pid=,ppid= -ax")) {
					return `${process.ppid} 1\n1 0`;
				}
				return "";
			}),
		}));
		const mod = await import("../pre-checks.js");
		expect(mod.checkSelfKill(`kill ${process.pid}`)?.block).toBeDefined();
	});

	afterAll(() => {
		vi.resetModules();
		vi.doUnmock("node:child_process");
	});
});

// =====================================================================
// getProtectedPids ancestor-listing regex precision (cold module)
// =====================================================================
// `/^(\d+)\s+(\d+)$/` parses each `ps -o pid=,ppid= -ax` line into a
// (pid -> parent) entry BEFORE the ancestor walk runs. A malformed line that
// slips past a loosened anchor/quantifier can inject a BOGUS entry that
// silently redirects the walk — turning an unrelated pid into a falsely
// "protected" one (or the reverse: dropping a real ancestor). Each case below
// isolates ONE such corruption in its own fresh module (the map is built once
// per module instance, so these can't share the warm cache from the describe
// blocks above) and checks its effect via `checkSelfKill('kill <injected>')`.

describe("getProtectedPids ancestor-listing regex precision (cold module)", () => {
	let coldDir: string;
	const ppid = process.ppid;
	const PLANTED = 424242;
	// SPY, not process.chdir(): chdir THROWS in a worker thread
	// ("process.chdir() is not supported in workers"), and Stryker's vitest
	// runner pins its own pool, so a real chdir here fails the mutation dry run
	// for any file whose graph-selected test scope includes this one.
	// getProtectedPids resolves the pid file via `join(process.cwd(), ...)`, so
	// the spy exercises the same path.
	let cwdSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		coldDir = mkdtempSync(join(tmpdir(), "pre-checks-ancestor-regex-"));
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(coldDir);
		vi.resetModules();
	});

	afterEach(() => {
		cwdSpy.mockRestore();
		rmSync(coldDir, { recursive: true, force: true });
	});

	it("does not let a LEADING-garbage line override a valid ancestor mapping (leading anchor precision)", async () => {
		// "yyy424242 111111" must NOT match (no leading `^` binds it to the
		// digit run) — so PLANTED's real mapping (->1, from the valid line
		// before it) survives, and 111111 never enters the protected set.
		vi.doMock("node:child_process", () => ({
			execSync: vi.fn((cmd: string) => {
				if (typeof cmd === "string" && cmd.includes("ps -o pid=,ppid= -ax")) {
					return [`${ppid} ${PLANTED}`, `${PLANTED} 1`, `yyy${PLANTED} 111111`].join("\n");
				}
				return "";
			}),
		}));
		const mod = await import("../pre-checks.js");
		expect(mod.checkSelfKill(`kill ${PLANTED}`)?.block).toBeDefined(); // sanity: real ancestor still protected
		expect(mod.checkSelfKill("kill 111111")).toBeNull();
	});

	it("does not let a TRAILING-garbage line override a valid ancestor mapping (trailing anchor precision)", async () => {
		// "424242 222222 tail" must NOT match (no trailing `$` binds the
		// second digit run to end-of-line) — so PLANTED's real mapping
		// survives and 222222 never enters the protected set.
		vi.doMock("node:child_process", () => ({
			execSync: vi.fn((cmd: string) => {
				if (typeof cmd === "string" && cmd.includes("ps -o pid=,ppid= -ax")) {
					return [`${ppid} ${PLANTED}`, `${PLANTED} 1`, `${PLANTED} 222222 tail`].join("\n");
				}
				return "";
			}),
		}));
		const mod = await import("../pre-checks.js");
		expect(mod.checkSelfKill(`kill ${PLANTED}`)?.block).toBeDefined();
		expect(mod.checkSelfKill("kill 222222")).toBeNull();
	});

	it("DOES follow a two-space-separated ancestor line (\\s+ must accept more than one space)", async () => {
		// "424242  333333" (two spaces) must MATCH — the separator is `\s+`,
		// one-or-more. A matcher collapsed to a single mandatory whitespace
		// char would fail here, silently dropping 333333 from the walk.
		vi.doMock("node:child_process", () => ({
			execSync: vi.fn((cmd: string) => {
				if (typeof cmd === "string" && cmd.includes("ps -o pid=,ppid= -ax")) {
					return [`${ppid} ${PLANTED}`, `${PLANTED} 1`, `${PLANTED}  333333`].join("\n");
				}
				return "";
			}),
		}));
		const mod = await import("../pre-checks.js");
		// PLANTED's LAST-parsed mapping wins (Map.set overwrites in line
		// order), so the walk now goes ppid -> PLANTED -> 333333 -> (no
		// further entry) -> stop, protecting 333333 too.
		expect(mod.checkSelfKill("kill 333333")?.block).toBeDefined();
	});

	it("does not protect PID 1 when the ancestor walk correctly stops at init", async () => {
		vi.doMock("node:child_process", () => ({
			execSync: vi.fn((cmd: string) => {
				if (typeof cmd === "string" && cmd.includes("ps -o pid=,ppid= -ax")) {
					return [`${ppid} ${PLANTED}`, `${PLANTED} 1`, "1 0"].join("\n");
				}
				return "";
			}),
		}));
		const mod = await import("../pre-checks.js");
		expect(mod.checkSelfKill("kill 1")).toBeNull();
	});

	it("stops the ancestor walk at ten links rather than including an eleventh", async () => {
		const chain = Array.from({ length: 11 }, (_, i) => `${i === 0 ? ppid : 700000 + i - 1} ${700000 + i}`);
		chain.push("700010 1");
		vi.doMock("node:child_process", () => ({
			execSync: vi.fn((cmd: string) => {
				if (typeof cmd === "string" && cmd.includes("ps -o pid=,ppid= -ax")) return chain.join("\n");
				return "";
			}),
		}));
		const mod = await import("../pre-checks.js");
		expect(mod.checkSelfKill("kill 700010")).toBeNull();
	});

	it("parses leading whitespace in every ancestor-listing line", async () => {
		vi.doMock("node:child_process", () => ({
			execSync: vi.fn((cmd: string) => {
				if (typeof cmd === "string" && cmd.includes("ps -o pid=,ppid= -ax")) {
					return [`  ${ppid} ${PLANTED}`, `  ${PLANTED} 1`].join("\n");
				}
				return "";
			}),
		}));
		const mod = await import("../pre-checks.js");
		expect(mod.checkSelfKill(`kill ${PLANTED}`)?.block).toBeDefined();
	});

	afterAll(() => {
		vi.resetModules();
		vi.doUnmock("node:child_process");
	});
});

// =====================================================================
// checkEnvLeakToGit()
// =====================================================================

describe("checkEnvLeakToGit", () => {
	let envDir: string;
	beforeEach(() => {
		execSyncMock.mockReset();
		execSyncMock.mockReturnValue("");
		envDir = mkdtempSync(join(tmpdir(), "pre-checks-env-"));
	});
	afterEach(() => {
		rmSync(envDir, { recursive: true, force: true });
	});

	it("returns null for non-.env files", () => {
		expect(checkEnvLeakToGit("/p/config.json", "SECRET=abc", envDir)).toBeNull();
	});

	it("returns null for .env.example / .env.sample / .env.template", () => {
		expect(checkEnvLeakToGit(".env.example", "API_KEY=x", envDir)).toBeNull();
		expect(checkEnvLeakToGit(".env.sample", "API_KEY=x", envDir)).toBeNull();
		expect(checkEnvLeakToGit(".env.template", "API_KEY=x", envDir)).toBeNull();
	});

	it("matches a suffix .env name (production.env)", () => {
		// git check-ignore exits non-zero (mock throws) → not ignored → secrets → block.
		execSyncMock.mockImplementation(() => {
			throw new Error("not ignored");
		});
		const result = checkEnvLeakToGit("production.env", "DATABASE_URL=postgres://x", envDir);
		expect(result?.block).toContain("production.env");
	});

	it("returns null when the file IS gitignored (check-ignore exits 0)", () => {
		// execSync returning normally == exit 0 == file is ignored == safe.
		execSyncMock.mockReturnValue("");
		expect(checkEnvLeakToGit(".env", "API_KEY=supersecret", envDir)).toBeNull();
	});

	it("passes the absolute path and safety options to git check-ignore", () => {
		execSyncMock.mockReturnValue("");
		const abs = join(envDir, ".env");
		expect(checkEnvLeakToGit(abs, "API_KEY=supersecret", envDir)).toBeNull();
		expect(execSyncMock).toHaveBeenCalledWith(`git check-ignore --quiet "${abs}"`, {
			cwd: envDir,
			timeout: 2000,
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("blocks when not gitignored and content has secret-like patterns", () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("not ignored");
		});
		const result = checkEnvLeakToGit(".env.local", "TOKEN=abc123", envDir);
		expect(result?.block).toContain(".env.local");
		expect(result?.block).toContain(".gitignore");
	});

	it("warns (not block) when not gitignored but content has no secrets", () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("not ignored");
		});
		const result = checkEnvLeakToGit(".env", "JUST_A_FLAG=true", envDir);
		expect(result?.warning).toContain("env-leak");
	});

	it("warns when content is undefined (empty-text path, no secrets)", () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("not ignored");
		});
		expect(checkEnvLeakToGit(".env", undefined, envDir)?.warning).toContain("env-leak");
	});

	it("resolves a relative path against cwd before check-ignore", () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("not ignored");
		});
		expect(checkEnvLeakToGit(".env", "PRIVATE_KEY=----", envDir)?.block).toBeDefined();
	});

	it("uses an absolute path as-is (isAbsolute true branch)", () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("not ignored");
		});
		const abs = join(envDir, ".env");
		expect(checkEnvLeakToGit(abs, "SECRET=zzz", envDir)?.block).toBeDefined();
	});

	// --- Regex-precision adversarial cases (secrets matcher, L184) ---
	// `/(?:API_KEY|...)\s*=\s*\S+/i` allows optional whitespace on BOTH sides
	// of `=`. Each case pins one \s* side independently.

	it("detects a secret with whitespace BEFORE the `=` (leading \\s* side)", () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("not ignored");
		});
		// A matcher requiring \S* (non-whitespace) before "=" instead of \s*
		// would fail to match this — the space right before "=" is whitespace.
		expect(checkEnvLeakToGit(".env", "TOKEN =abc123", envDir)?.block).toBeDefined();
	});

	it("detects a secret with whitespace AFTER the `=` (trailing \\s* side)", () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("not ignored");
		});
		// A matcher requiring \S* (non-whitespace) after "=" instead of \s*
		// would fail to match this — the space right after "=" is whitespace.
		expect(checkEnvLeakToGit(".env", "TOKEN= abc123", envDir)?.block).toBeDefined();
	});
});

// =====================================================================
// checkStaleBranch()
// =====================================================================

describe("checkStaleBranch", () => {
	let staleDir: string;
	beforeEach(() => {
		execSyncMock.mockReset();
		execSyncMock.mockReturnValue("");
		staleDir = mkdtempSync(join(tmpdir(), "pre-checks-stale-"));
	});
	afterEach(() => {
		rmSync(staleDir, { recursive: true, force: true });
	});

	it("returns null (and caches) when not in a git repo — no .git dir", () => {
		expect(checkStaleBranch(staleDir, "sess-nogit")).toBeNull();
		expect(execSyncMock).not.toHaveBeenCalled();
		expect(checkStaleBranch(staleDir, "sess-nogit")).toBeNull();
		expect(execSyncMock).not.toHaveBeenCalled();
	});

	it("warns when the branch is far behind the main branch", () => {
		mkdirSync(join(staleDir, ".git"), { recursive: true });
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("rev-parse")) return "main";
			if (cmd.includes("rev-list")) return "120"; // > threshold 50
			return "";
		});
		const result = checkStaleBranch(staleDir, "sess-behind");
		expect(result?.warning).toContain("120 commits behind main");
		expect(execSyncMock).toHaveBeenCalledWith(
			"git rev-parse --verify main 2>/dev/null && echo main || echo master",
			{
				cwd: staleDir,
				timeout: 2000,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		expect(execSyncMock).toHaveBeenCalledWith(
			"git rev-list --count HEAD..main 2>/dev/null",
			{
				cwd: staleDir,
				timeout: 2000,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
	});

	it("returns null when behind count is within the threshold", () => {
		mkdirSync(join(staleDir, ".git"), { recursive: true });
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("rev-parse")) return "main";
			if (cmd.includes("rev-list")) return "3";
			return "";
		});
		expect(checkStaleBranch(staleDir, "sess-fresh")).toBeNull();
	});

	it("returns the cached result on a second call inside the interval (L204: interval must stay minutes-scale)", () => {
		// Two SYNCHRONOUS calls with no fake-timer advance can land in the same
		// millisecond, which would mask even a near-zero interval (0ms elapsed
		// < any positive threshold). Advancing fake time by 100ms is well
		// within the REAL 5-minute interval but far past a mutated near-zero
		// one, so this is the only way to make the boundary actually observable.
		vi.useFakeTimers();
		try {
			mkdirSync(join(staleDir, ".git"), { recursive: true });
			execSyncMock.mockImplementation((cmd: string) => {
				if (cmd.includes("rev-parse")) return "main";
				if (cmd.includes("rev-list")) return "200";
				return "";
			});
			const first = checkStaleBranch(staleDir, "sess-cache");
			expect(first?.warning).toBeDefined();
			const callsAfterFirst = execSyncMock.mock.calls.length;
			vi.advanceTimersByTime(100);
			const second = checkStaleBranch(staleDir, "sess-cache");
			expect(second).toBe(first);
			expect(execSyncMock.mock.calls.length).toBe(callsAfterFirst);
		} finally {
			vi.useRealTimers();
		}
	});

	it("refreshes exactly at the five-minute cache boundary", () => {
		vi.useFakeTimers();
		try {
			mkdirSync(join(staleDir, ".git"), { recursive: true });
			const fixedNow = new Date("2026-01-01T00:00:00.000Z").getTime();
			vi.setSystemTime(fixedNow);
			execSyncMock.mockImplementation((cmd: string) => {
				if (cmd.includes("rev-parse")) return "main";
				if (cmd.includes("rev-list")) return "120";
				return "";
			});
			checkStaleBranch(staleDir, "sess-cache-boundary");
			const callsAfterFirst = execSyncMock.mock.calls.length;
			vi.advanceTimersByTime(5 * 60 * 1000);
			checkStaleBranch(staleDir, "sess-cache-boundary");
			expect(execSyncMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not warn at exactly the stale-branch threshold", () => {
		mkdirSync(join(staleDir, ".git"), { recursive: true });
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("rev-parse")) return "main";
			if (cmd.includes("rev-list")) return "50";
			return "";
		});
		expect(checkStaleBranch(staleDir, "sess-threshold")).toBeNull();
	});

	it("returns null (catch path) when git rev-parse throws", () => {
		mkdirSync(join(staleDir, ".git"), { recursive: true });
		execSyncMock.mockImplementation(() => {
			throw new Error("git missing");
		});
		expect(checkStaleBranch(staleDir, "sess-throw")).toBeNull();
	});

	it("returns null when behind count is non-numeric (NaN guard)", () => {
		mkdirSync(join(staleDir, ".git"), { recursive: true });
		execSyncMock.mockImplementation((cmd: string) => {
			if (cmd.includes("rev-parse")) return "main";
			if (cmd.includes("rev-list")) return "not-a-number";
			return "";
		});
		expect(checkStaleBranch(staleDir, "sess-nan")).toBeNull();
	});
});

// =====================================================================
// checkDirtyWorkingTree()
// =====================================================================

describe("checkDirtyWorkingTree", () => {
	const dirtyCwd = "/some/repo";

	beforeEach(() => {
		execSyncMock.mockReset();
		execSyncMock.mockReturnValue("");
	});

	it("returns null for git commands that cannot discard changes", () => {
		expect(checkDirtyWorkingTree("git status", dirtyCwd)).toBeNull();
		expect(checkDirtyWorkingTree("ls -la", dirtyCwd)).toBeNull();
		expect(execSyncMock).not.toHaveBeenCalled();
	});

	it("warns when checkout runs with uncommitted changes", () => {
		execSyncMock.mockReturnValue(" M src/a.ts\n?? src/b.ts");
		const result = checkDirtyWorkingTree("git checkout main", dirtyCwd);
		expect(result?.warning).toContain("2 uncommitted change");
	});

	it("matches switch / rebase / reset verbs too", () => {
		execSyncMock.mockReturnValue(" M one.ts");
		expect(checkDirtyWorkingTree("git switch other", dirtyCwd)?.warning).toBeDefined();
		expect(checkDirtyWorkingTree("git rebase main", dirtyCwd)?.warning).toBeDefined();
		expect(checkDirtyWorkingTree("git reset --hard", dirtyCwd)?.warning).toBeDefined();
	});

	it("returns null when the working tree is clean", () => {
		execSyncMock.mockReturnValue("");
		expect(checkDirtyWorkingTree("git checkout main", dirtyCwd)).toBeNull();
	});

	it("trims whitespace-only git status output before deciding the tree is clean", () => {
		execSyncMock.mockReturnValue(" \n\t");
		expect(checkDirtyWorkingTree("git checkout main", dirtyCwd)).toBeNull();
	});

	it("passes the intended stdio and encoding options to git status", () => {
		execSyncMock.mockReturnValue(" M one.ts");
		checkDirtyWorkingTree("git checkout main", dirtyCwd);
		expect(execSyncMock).toHaveBeenCalledWith("git status --porcelain 2>/dev/null", {
			cwd: dirtyCwd,
			timeout: 3000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("returns null (catch path) when git status throws", () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("not a git repo");
		});
		expect(checkDirtyWorkingTree("git rebase main", dirtyCwd)).toBeNull();
	});

	it("still matches across MULTIPLE spaces between `git` and the verb (\\s+ precision)", () => {
		// `/\bgit\s+(checkout|switch|rebase|reset)\b/` — the separator is
		// `\s+` (one-or-more). A matcher collapsed to a single mandatory
		// whitespace char would fail to match "git  checkout" (two spaces).
		execSyncMock.mockReturnValue(" M one.ts");
		expect(checkDirtyWorkingTree("git  checkout main", dirtyCwd)?.warning).toBeDefined();
	});
});

// =====================================================================
// checkLargeFileWrite()
// =====================================================================

describe("checkLargeFileWrite", () => {
	it("returns null when content is undefined", () => {
		expect(checkLargeFileWrite(undefined)).toBeNull();
	});

	it("returns null for content under the 50KB threshold (L290: threshold must stay ~50KB, not ~0)", () => {
		// At 10KB this is comfortably under the REAL 50KB threshold but would
		// trip a threshold collapsed toward zero by the mutated arithmetic.
		expect(checkLargeFileWrite("x".repeat(10 * 1024))).toBeNull();
	});

	it("warns for content over the 50KB threshold", () => {
		const result = checkLargeFileWrite("x".repeat(51 * 1024));
		expect(result?.warning).toContain("large-file");
		expect(result?.warning).toContain("51KB");
	});

	it("allows content exactly at the 50KB threshold", () => {
		expect(checkLargeFileWrite("x".repeat(50 * 1024))).toBeNull();
	});
});

// =====================================================================
// checkConcurrentEdit()
// =====================================================================

describe("checkConcurrentEdit", () => {
	const target = "/repo/src/shared.ts";
	const now = Date.now();
	const recentIso = new Date(now - 5_000).toISOString();
	const oldIso = new Date(now - 20 * 60 * 1000).toISOString(); // 20m > 10m window

	it("returns null when no other session has touched the file", () => {
		const sessions = [makeSession({ id: "me", written: [target] })];
		expect(checkConcurrentEdit(target, "me", sessions)).toBeNull();
	});

	it("skips the current session even if it wrote the file", () => {
		const sessions = [
			makeSession({ id: "me", written: [target], writeTimes: [[target, recentIso]] }),
		];
		expect(checkConcurrentEdit(target, "me", sessions)).toBeNull();
	});

	it("skips a session that did not write THIS file", () => {
		const sessions = [makeSession({ id: "other", written: ["/repo/src/elsewhere.ts"] })];
		expect(checkConcurrentEdit(target, "me", sessions)).toBeNull();
	});

	it("skips a session with a STALE write-time entry for a file it no longer lists as written (files_written guard, not just writeTimeStr)", () => {
		// Regression-shaped: a session whose `file_write_times` map still has a
		// recent entry for `target`, but whose `files_written` set does NOT
		// contain `target` — an inconsistent-but-realistic shape (e.g. a file
		// that was reverted/untracked after being recorded). Without its OWN
		// fixture this scenario is invisible: every other case in this suite
		// keeps files_written and file_write_times in sync, so a mutant that
		// forces the `!session.files_written.has(absPath)` guard to `false`
		// (never skip) is rescued downstream by the writeTimeStr/NaN guards —
		// UNLESS file_write_times genuinely has a parseable recent entry, as
		// here, in which case only THIS guard stands between "skip" and a
		// false-positive warning about a file the session doesn't list as written.
		const sessions = [
			makeSession({
				id: "inconsistent-other",
				agentName: "Ghost",
				written: ["/repo/src/elsewhere.ts"], // does NOT include target
				writeTimes: [[target, recentIso]], // but DOES carry a fresh entry for target
			}),
		];
		expect(checkConcurrentEdit(target, "me", sessions)).toBeNull();
	});

	it("skips a session with no recorded write time for the file", () => {
		const sessions = [makeSession({ id: "other", written: [target] })]; // no writeTimes
		expect(checkConcurrentEdit(target, "me", sessions)).toBeNull();
	});

	it("skips a session whose write time is unparseable (NaN guard)", () => {
		const sessions = [
			makeSession({ id: "other", written: [target], writeTimes: [[target, "not-a-date"]] }),
		];
		expect(checkConcurrentEdit(target, "me", sessions)).toBeNull();
	});

	it("skips a write older than the 10-minute window", () => {
		const sessions = [
			makeSession({ id: "other", written: [target], writeTimes: [[target, oldIso]] }),
		];
		expect(checkConcurrentEdit(target, "me", sessions)).toBeNull();
	});

	it("warns using agent_name when a recent concurrent write exists (L19: window must stay minutes-scale)", () => {
		// At 5s old this is comfortably within the REAL 10-minute window but
		// would fall OUTSIDE a window collapsed toward zero by the mutated
		// arithmetic — the mutant would (wrongly) skip it as "too old".
		const sessions = [
			makeSession({
				id: "other-session-id",
				agentName: "Reviewer",
				written: [target],
				writeTimes: [[target, recentIso]],
			}),
		];
		const result = checkConcurrentEdit(target, "me", sessions);
		expect(result?.warning).toContain('"Reviewer"');
		expect(result?.warning).toContain("concurrent-edit");
	});

	it("reports recent age in seconds, not milliseconds", () => {
		vi.useFakeTimers();
		try {
			const fixedNow = new Date("2026-01-01T00:00:00.000Z").getTime();
			vi.setSystemTime(fixedNow);
			const exactRecent = new Date(fixedNow - 5_000).toISOString();
			const sessions = [
				makeSession({
					id: "exact-age-session",
					agentName: "Reviewer",
					written: [target],
					writeTimes: [[target, exactRecent]],
				}),
			];
			expect(checkConcurrentEdit(target, "me", sessions)?.warning).toContain("5s ago");
		} finally {
			vi.useRealTimers();
		}
	});

	it("still warns when a write is EXACTLY at the 10-minute window boundary — ageMs > WINDOW excludes only STRICTLY older writes (L19/L328-329)", () => {
		// `ageMs > CONCURRENT_EDIT_WINDOW_MS` must be a strict `>`: at ageMs
		// EXACTLY equal to the window, the write is still "within" it (not yet
		// too old). A mutant widening this to `>=` would wrongly skip it. Real
		// wall-clock timing can't hit this boundary deterministically (elapsed
		// time between capturing "now" and the call always pushes ageMs
		// slightly past the target), so this pins Date.now() with fake timers.
		vi.useFakeTimers();
		try {
			const fixedNow = new Date("2026-01-01T00:00:00.000Z").getTime();
			vi.setSystemTime(fixedNow);
			const windowMs = 10 * 60 * 1000; // CONCURRENT_EDIT_WINDOW_MS in pre-checks.ts
			const boundaryIso = new Date(fixedNow - windowMs).toISOString();
			const sessions = [
				makeSession({
					id: "boundary-session",
					agentName: "Boundary",
					written: [target],
					writeTimes: [[target, boundaryIso]],
				}),
			];
			const result = checkConcurrentEdit(target, "me", sessions);
			expect(result?.warning).toContain('"Boundary"');
		} finally {
			vi.useRealTimers();
		}
	});

	it("falls back to a session_id slice when agent_name is empty", () => {
		const sessions = [
			makeSession({
				id: "abcdef1234567890",
				agentName: "",
				written: [target],
				writeTimes: [[target, recentIso]],
			}),
		];
		const result = checkConcurrentEdit(target, "me", sessions);
		expect(result?.warning).toContain('"abcdef12"'); // first 8 chars
	});

	it("resolves a relative target path against cwd before comparison", () => {
		const rel = "src/rel-target.ts";
		const abs = join(process.cwd(), rel);
		const sessions = [
			makeSession({
				id: "peer",
				agentName: "Peer",
				written: [abs],
				writeTimes: [[abs, recentIso]],
			}),
		];
		expect(checkConcurrentEdit(rel, "me", sessions)?.warning).toContain('"Peer"');
	});
});
import { makeSession as completeSessionFixture } from "./fixtures/evaluator.js";
