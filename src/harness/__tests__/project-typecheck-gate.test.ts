// Tests for the project-wide typecheck commit/push gate. The gate runs
// the project's typecheck script (matches CI exactly) and surfaces ALL
// diagnostics — pre-existing or not. This is the safety net that
// prevents an agent from ignoring tsc errors in untouched files.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { runWithProjectCompilerLease } from "../project-compiler-gate.js";
import {
	checkProjectTestsClean,
	checkProjectTestsCleanAsync,
	checkProjectTypecheckClean,
	checkProjectTypecheckCleanAsync,
	parseTestFailures,
	parseTscDiagnostics,
	resolveTestCommand,
	resolveTypecheckCommand,
} from "../project-typecheck-gate.js";

let tmp: string;
let savedEnv: string | undefined;
let savedTestsEnv: string | undefined;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-tcgate-"));
	savedEnv = process.env.INTERLINKED_SKIP_PROJECT_TYPECHECK;
	delete process.env.INTERLINKED_SKIP_PROJECT_TYPECHECK;
	savedTestsEnv = process.env.INTERLINKED_SKIP_PROJECT_TESTS;
	delete process.env.INTERLINKED_SKIP_PROJECT_TESTS;
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	if (savedEnv === undefined) delete process.env.INTERLINKED_SKIP_PROJECT_TYPECHECK;
	else process.env.INTERLINKED_SKIP_PROJECT_TYPECHECK = savedEnv;
	if (savedTestsEnv === undefined) delete process.env.INTERLINKED_SKIP_PROJECT_TESTS;
	else process.env.INTERLINKED_SKIP_PROJECT_TESTS = savedTestsEnv;
});

describe("resolveTypecheckCommand", () => {
	it("prefers `typecheck:stable` because that's what CI runs", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: {
					typecheck: "tsgo --noEmit",
					"typecheck:stable": "tsc --noEmit",
				},
			}),
		);
		const cmd = resolveTypecheckCommand(tmp);
		expect(cmd?.source).toBe("typecheck:stable");
		expect(cmd?.bin).toBe("npm");
		expect(cmd?.args).toEqual(["run", "--silent", "typecheck:stable"]);
	});

	it("falls back to `typecheck` when `typecheck:stable` is absent", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }),
		);
		const cmd = resolveTypecheckCommand(tmp);
		expect(cmd).toEqual({
			bin: "npm",
			args: ["run", "--silent", "typecheck"],
			source: "typecheck",
		});
	});

	it("does not infer a local tsc when tsconfig.json is absent", () => {
		writeFileSync(join(tmp, "package.json"), JSON.stringify({}));
		mkdirSync(join(tmp, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(tmp, "node_modules", ".bin", "tsc"), "#!/bin/sh\nexit 0\n");
		expect(resolveTypecheckCommand(tmp)).toBeNull();
	});

	it("falls back to local node_modules/.bin/tsc when only tsconfig.json is present", () => {
		writeFileSync(join(tmp, "package.json"), JSON.stringify({}));
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({}));
		mkdirSync(join(tmp, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(tmp, "node_modules", ".bin", "tsc"), "#!/bin/sh\nexit 0\n");
		const cmd = resolveTypecheckCommand(tmp);
		expect(cmd?.source).toBe("local-tsc");
		expect(cmd?.bin).toBe(join(tmp, "node_modules", ".bin", "tsc"));
		expect(cmd?.args).toEqual(["--noEmit"]);
	});

	it("returns null when tsconfig exists but tsc isn't installed (fresh clone)", () => {
		// The "fresh clone with no `npm install`" case. We can't reliably
		// gate without tsc, so we MUST no-op rather than block — blocking
		// would prevent any commit until the user runs `npm install`.
		writeFileSync(join(tmp, "package.json"), JSON.stringify({}));
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({}));
		expect(resolveTypecheckCommand(tmp)).toBeNull();
	});

	it("returns null for non-TS projects (no scripts, no tsconfig)", () => {
		// Python repo, Go repo, doc-only repo, etc. The gate should be
		// silent there — never block, never warn.
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "py-repo" }));
		expect(resolveTypecheckCommand(tmp)).toBeNull();
	});

	it("returns null for a directory with neither package.json nor tsconfig.json", () => {
		expect(resolveTypecheckCommand(tmp)).toBeNull();
	});

	it("survives a malformed package.json by falling back to tsconfig+local-tsc probe", () => {
		writeFileSync(join(tmp, "package.json"), "{ this is not json");
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({}));
		mkdirSync(join(tmp, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(tmp, "node_modules", ".bin", "tsc"), "#!/bin/sh\nexit 0\n");
		expect(resolveTypecheckCommand(tmp)?.source).toBe("local-tsc");
	});
});

describe("parseTscDiagnostics", () => {
	it("parses one diagnostic per error line", () => {
		const out = [
			"src/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
			"src/bar.ts(7,1): error TS2783: 'x' is specified more than once.",
		].join("\n");
		const diags = parseTscDiagnostics(out);
		expect(diags).toHaveLength(2);
		expect(diags[0]).toEqual({
			file: "src/foo.ts",
			line: 10,
			col: 5,
			code: "TS2322",
			message: "Type 'string' is not assignable to type 'number'.",
		});
		expect(nonNull(diags[1]).code).toBe("TS2783");
	});

	it("ignores npm-script preamble and 'Found N errors' summary lines", () => {
		const out = [
			"> interlinked-cli@0.1.0 typecheck:stable",
			"> tsc --noEmit",
			"",
			"src/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
			"",
			"Found 1 error in src/foo.ts:10",
		].join("\n");
		const diags = parseTscDiagnostics(out);
		expect(diags).toHaveLength(1);
		expect(nonNull(diags[0]).file).toBe("src/foo.ts");
	});

	it("handles paths with spaces and unicode", () => {
		const out =
			"src/with space/héllo.ts(1,1): error TS9999: Custom check failed — see docs.";
		const diags = parseTscDiagnostics(out);
		expect(diags).toHaveLength(1);
		expect(nonNull(diags[0]).file).toBe("src/with space/héllo.ts");
		expect(nonNull(diags[0]).message).toContain("Custom check failed");
	});

	it("requires a diagnostic to occupy the complete line and preserves only a trimmed message", () => {
		const out = [
			"compiler noise src/noise.ts(1,1): error TS0000: should be ignored",
			"src/spaced.ts(12,34):  error  TS1234:   message with padding   ",
			"src/trailing.ts(1,1): error TS9999: valid diagnostic followed by noise",
			"trailing noise",
		].join("\n");
		const diags = parseTscDiagnostics(out);
		expect(diags).toEqual([
			{
				file: "compiler noise src/noise.ts",
				line: 1,
				col: 1,
				code: "TS0000",
				message: "should be ignored",
			},
			{
				file: "src/spaced.ts",
				line: 12,
				col: 34,
				code: "TS1234",
				message: "message with padding",
			},
			{
				file: "src/trailing.ts",
				line: 1,
				col: 1,
				code: "TS9999",
				message: "valid diagnostic followed by noise",
			},
		]);
	});

	it("accepts multi-digit columns and requires whitespace in each diagnostic separator", () => {
		const out = [
			"src/column.ts(1,10): error TS1000: ten-column diagnostic",
			"src/no-space.ts(1,1):error TS1001: missing separator",
			"src/no-code-space.ts(1,1): errorTS1002: missing separator",
			"src/no-message-space.ts(1,1): error TS1003:no message separator",
		].join("\n");
		expect(parseTscDiagnostics(out)).toEqual([
			{
				file: "src/column.ts",
				line: 1,
				col: 10,
				code: "TS1000",
				message: "ten-column diagnostic",
			},
		]);
	});

	it("returns empty array on clean output", () => {
		expect(parseTscDiagnostics("")).toEqual([]);
		expect(parseTscDiagnostics("Found 0 errors.\n")).toEqual([]);
	});
});

describe("checkProjectTypecheckClean", () => {
	it("no-ops on a non-TS project (returns empty)", () => {
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "py-repo" }));
		expect(checkProjectTypecheckClean(tmp)).toEqual([]);
	});

	// test-contract: public-api — an audited bypass is a warning finding with the stable structural metadata
	it("emits a warning entry (not an error) when bypassed via env var", () => {
		// Bypass should ALWAYS surface so an audit log can find it later.
		// But it must not block — that's the whole point of bypass.
		process.env.INTERLINKED_SKIP_PROJECT_TYPECHECK = "1";
		const results = checkProjectTypecheckClean(tmp);
		expect(results).toHaveLength(1);
		expect(results).toEqual([
			{
				source: "structural",
				name: "project_typecheck_skipped",
				severity: "warning",
				message:
					"Project typecheck gate bypassed via INTERLINKED_SKIP_PROJECT_TYPECHECK=1. Verify CI manually before merging.",
				determinism: "fully_deterministic",
			},
		]);
	});

	it("returns empty when the typecheck script exits clean", () => {
		// Stub `typecheck:stable` script that exits 0 with no output —
		// the success path. We test against the script wiring rather
		// than spinning up a real tsc subprocess in a temp dir; that
		// would force an `npm install typescript` per test (slow + flaky
		// in CI). The script wiring IS what production exercises.
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ scripts: { "typecheck:stable": "node -e \"process.exit(0)\"" } }),
		);
		expect(checkProjectTypecheckClean(tmp)).toEqual([]);
	});

	it("returns one error entry per tsc diagnostic when the typecheck script fails", () => {
		// Stub script prints two tsc-format diagnostics on stdout and
		// exits 1. The gate must surface both as error entries with the
		// file reference threaded through.
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: {
					"typecheck:stable":
						'node -e "console.log(\\"src/foo.ts(10,5): error TS2322: bad type.\\");console.log(\\"src/bar.ts(7,1): error TS2783: dup key.\\");process.exit(1)"',
				},
			}),
		);

		const results = checkProjectTypecheckClean(tmp);
		expect(results).toEqual([
			{
				source: "structural",
				name: "project_typecheck_clean",
				severity: "error",
				message: "src/foo.ts:10:5 — TS2322: bad type.",
				file: "src/foo.ts",
				determinism: "fully_deterministic",
			},
			{
				source: "structural",
				name: "project_typecheck_clean",
				severity: "error",
				message: "src/bar.ts:7:1 — TS2783: dup key.",
				file: "src/bar.ts",
				determinism: "fully_deterministic",
			},
		]);
	});

	it("flags pre-existing errors in untouched files — the whole point of the gate", () => {
		// Failure mode: agent edits file A, doesn't touch file B, but
		// file B has a tsc error. Per-edit (diff-aware) checks won't
		// surface it. THIS gate must — that's the contract.
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: {
					"typecheck:stable":
						'node -e "console.log(\\"src/untouched-broken.ts(3,1): error TS2322: pre-existing.\\");process.exit(1)"',
				},
			}),
		);
		const results = checkProjectTypecheckClean(tmp);
		expect(results.some((r) => r.file?.includes("untouched-broken.ts"))).toBe(true);
	});

	it("surfaces unparseable failure output rather than silently allowing", () => {
		// Defensive: if the typecheck script exits non-zero but produces
		// no parseable diagnostics (malformed output, runtime crash,
		// SIGSEGV, etc.), the gate must still BLOCK with a raw-output
		// fallback message. Silent-allow on parse failure would defeat
		// the gate entirely.
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: {
					"typecheck:stable":
						'node -e "console.error(\\"compiler crashed: stack overflow\\");process.exit(2)"',
				},
			}),
		);
		const results = checkProjectTypecheckClean(tmp);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).severity).toBe("error");
		expect(nonNull(results[0]).name).toBe("project_typecheck_clean");
		expect(nonNull(results[0]).message).toContain("compiler crashed");
	});

	it("reports an empty raw failure without inventing output and caps diagnostics at 50", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: {
					"typecheck:stable":
						'node -e "process.exit(2)"',
				},
			}),
		);
		const empty = checkProjectTypecheckClean(tmp);
		expect(empty).toHaveLength(1);
		expect(nonNull(empty[0])).toEqual({
			source: "structural",
			name: "project_typecheck_clean",
			severity: "error",
			message: "Project typecheck (typecheck:stable) failed (exit 2) but no TS diagnostics parsed. Raw output: ",
			determinism: "fully_deterministic",
		});

		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: {
					"typecheck:stable": "node emit-many.js",
				},
			}),
		);
		writeFileSync(
			join(tmp, "emit-many.js"),
			"for (let i = 1; i <= 51; i++) console.log(`src/f${i}.ts(1,1): error TS${i}: bad`); process.exit(1);",
		);
		const many = checkProjectTypecheckClean(tmp);
		expect(many).toHaveLength(50);
		expect(nonNull(many[0]).message).toContain("src/f1.ts:1:1 — TS1: bad");
		expect(nonNull(many[49]).message).toContain("src/f50.ts:1:1 — TS50: bad");
		expect(many.some((r) => r.message.includes("src/f51.ts"))).toBe(false);
	});

	it("trims and truncates unparseable stderr in the fallback message", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: {
					"typecheck:stable": "node emit-raw.js",
				},
			}),
		);
		writeFileSync(
			join(tmp, "emit-raw.js"),
			'process.stderr.write("  boom  " + "x".repeat(600)); process.exit(2);',
		);
		const results = checkProjectTypecheckClean(tmp);
		const message = nonNull(results[0]).message;
		expect(message).toContain("Raw output: boom  ");
		expect(message).not.toContain("  boom");
		expect(message).not.toContain("x".repeat(501));
		expect(message).toHaveLength(
			"Project typecheck (typecheck:stable) failed (exit 2) but no TS diagnostics parsed. Raw output: ".length + 500,
		);
	});

	// test-contract: boundary — an undispatchable local compiler is an audited warning, not a false clean result
	it("reports 'could not run' when spawnSync itself fails (non-executable local-tsc binary)", () => {
		// Drive the local-tsc discovery path with a binary file that has no
		// execute bit — spawnSync then sets `result.error` (EACCES) rather
		// than returning a normal exit status. This exercises the
		// `result.error` branch distinctly from a script that runs and fails.
		writeFileSync(join(tmp, "package.json"), JSON.stringify({}));
		writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({}));
		mkdirSync(join(tmp, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(tmp, "node_modules", ".bin", "tsc"), "#!/bin/sh\nexit 0\n", {
			mode: 0o644,
		});
		const results = checkProjectTypecheckClean(tmp);
		expect(results).toHaveLength(1);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0])).toMatchObject({
			source: "structural",
			name: "project_typecheck_failed_to_run",
			severity: "warning",
			determinism: "fully_deterministic",
		});
		expect(nonNull(results[0]).message).toContain("could not run");
		expect(nonNull(results[0]).message).toContain("Verify CI manually");
	});

	// test-contract: public-api — terminated typechecks expose the signal cause in the stable warning message
	it("reports 'exceeded timeout' when the child process is terminated by a signal", () => {
		// spawnSync sets `status: null` + `signal: "SIGTERM"` both on a real
		// timeout AND whenever the child is killed by that signal for any
		// other reason — the gate can't distinguish, so it must treat any
		// SIGTERM the same way. The stub script kills itself immediately so
		// the test doesn't have to wait out the real 60s budget.
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: {
					"typecheck:stable": 'node -e "process.kill(process.pid, \\"SIGTERM\\")"',
				},
			}),
		);
		const results = checkProjectTypecheckClean(tmp);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).name).toBe("project_typecheck_timed_out");
		expect(nonNull(results[0]).severity).toBe("warning");
		expect(nonNull(results[0]).message).toContain("exceeded");
		expect(nonNull(results[0]).message).toContain("timeout");
		expect(nonNull(results[0]).message).toContain("signal SIGTERM");
	});

	// `process.exit(143)` reproduces the exit-code-only signal-death shape
	// (status: 143, signal: null) deterministically on every platform — no
	// dependence on how any given OS/wrapper combination relays a real
	// self-inflicted kill signal (see CI run 31517477152 for the report).
	// Asserting the derived "signal SIGTERM" text pins the fix: the message
	// must name the same cause from the exit code alone, everywhere.
	it("P: classifies the POSIX 128+n signal-exit encoding as terminated (Linux npm re-encodes SIGTERM as exit 143 with signal null — CI run 31517477152)", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: { "typecheck:stable": 'node -e "process.exit(143)"' },
			}),
		);
		const results = checkProjectTypecheckClean(tmp);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).name).toBe("project_typecheck_timed_out");
		expect(nonNull(results[0]).severity).toBe("warning");
		expect(nonNull(results[0]).message).toContain("exit 143");
		expect(nonNull(results[0]).message).toContain("signal SIGTERM");
	});

	it("classifies the signal base exit code itself as terminated", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ scripts: { "typecheck:stable": 'node -e "process.exit(128)"' } }),
		);
		const results = checkProjectTypecheckClean(tmp);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0])).toEqual({
			source: "structural",
			name: "project_typecheck_timed_out",
			severity: "warning",
			message: "Project typecheck (typecheck:stable) exceeded 60s timeout or was terminated (exit 128). Verify CI manually.",
			determinism: "fully_deterministic",
		});
	});

	// test-contract: boundary — compiler diagnostics emitted only on stderr remain parsed as diagnostics, not downgraded to raw output
	it("parses diagnostics emitted on stderr when stdout is empty", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: {
					"typecheck:stable":
						'node -e "console.error(\\"src/stderr.ts(4,2): error TS7006: implicit any.\\");process.exit(1)"',
				},
			}),
		);
		expect(checkProjectTypecheckClean(tmp)).toEqual([
			{
				source: "structural",
				name: "project_typecheck_clean",
				severity: "error",
				message: "src/stderr.ts:4:2 — TS7006: implicit any.",
				file: "src/stderr.ts",
				determinism: "fully_deterministic",
			},
		]);
	});

	it("reports NOT CHECKED instead of spawning while another compiler owns the project", async () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ scripts: { "typecheck:stable": 'node -e "process.exit(0)"' } }),
		);
		let releaseBarrier: () => void = () => {};
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const barrier = new Promise<void>((resolve) => {
			releaseBarrier = resolve;
		});
		const owner = runWithProjectCompilerLease(tmp, async () => {
			markStarted();
			await barrier;
		});
		await started;

		const results = checkProjectTypecheckClean(tmp);
		releaseBarrier();
		await owner;

		expect(results).toEqual([
			{
				source: "structural",
				name: "project_typecheck_deferred",
				severity: "warning",
				message:
					"Project typecheck was NOT CHECKED because another compiler owns this project. Retry before committing or pushing.",
				determinism: "fully_deterministic",
			},
		]);
	});
});

describe("checkProjectTypecheckCleanAsync", () => {
	it("runs the daemon production path without blocking on spawnSync", async () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ scripts: { "typecheck:stable": 'node -e "process.exit(0)"' } }),
		);
		await expect(checkProjectTypecheckCleanAsync(tmp)).resolves.toEqual([]);
	});

	it("does not turn an unstructured non-zero compiler exit into clean", async () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: {
					"typecheck:stable":
						'node -e "console.error(\\"compiler transport failed\\");process.exit(2)"',
				},
			}),
		);
		const results = await checkProjectTypecheckCleanAsync(tmp);
		expect(results).toEqual([
			expect.objectContaining({
				name: "project_typecheck_clean",
				severity: "error",
				message: expect.stringContaining("compiler transport failed"),
			}),
		]);
	});

	it("parses structured diagnostics from a non-zero async compiler run", async () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: {
					"typecheck:stable":
						'node -e "console.error(\\"src/async.ts(8,3): error TS2322: bad async type.\\");process.exit(1)"',
				},
			}),
		);
		await expect(checkProjectTypecheckCleanAsync(tmp)).resolves.toEqual([
			{
				source: "structural",
				name: "project_typecheck_clean",
				severity: "error",
				message: "src/async.ts:8:3 — TS2322: bad async type.",
				file: "src/async.ts",
				determinism: "fully_deterministic",
			},
		]);
	});

	it("records the bypass instead of running a compiler that would fail", async () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: {
					"typecheck:stable":
						'node -e "console.error(\\"src/x.ts(1,1): error TS2322: bypassed.\\");process.exit(1)"',
				},
			}),
		);
		process.env.INTERLINKED_SKIP_PROJECT_TYPECHECK = "1";
		await expect(checkProjectTypecheckCleanAsync(tmp)).resolves.toEqual([
			{
				source: "structural",
				name: "project_typecheck_skipped",
				severity: "warning",
				message:
					"Project typecheck gate bypassed via INTERLINKED_SKIP_PROJECT_TYPECHECK=1. Verify CI manually before merging.",
				determinism: "fully_deterministic",
			},
		]);
	});

	it("stays inert in a project with neither a typecheck script nor a local tsc", async () => {
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "not-a-ts-project" }));
		await expect(checkProjectTypecheckCleanAsync(tmp)).resolves.toEqual([]);
	});

	it("reports a timeout — never clean — when the compiler outlives its budget", async () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ scripts: { "typecheck:stable": 'node -e "setTimeout(() => {}, 10000)"' } }),
		);
		await expect(checkProjectTypecheckCleanAsync(tmp, { timeoutMs: 250 })).resolves.toEqual([
			{
				source: "structural",
				name: "project_typecheck_timed_out",
				severity: "warning",
				message:
					"Project typecheck (typecheck:stable) exceeded 0.25s timeout or was terminated. Verify CI manually.",
				determinism: "fully_deterministic",
			},
		]);
	});

	it("reports failed-to-run when the compiler never produced an exit code", async () => {
		writeFileSync(join(tmp, "tsconfig.json"), "{}");
		mkdirSync(join(tmp, "node_modules", ".bin"), { recursive: true });
		// Present (so it resolves as `local-tsc`) but not executable: the spawn
		// errors out, and `code: null` must never read as a clean compile.
		writeFileSync(join(tmp, "node_modules", ".bin", "tsc"), "not executable", { mode: 0o644 });
		await expect(checkProjectTypecheckCleanAsync(tmp)).resolves.toEqual([
			{
				source: "structural",
				name: "project_typecheck_failed_to_run",
				severity: "warning",
				message: "Project typecheck (local-tsc) could not run to completion. Verify CI manually.",
				determinism: "fully_deterministic",
			},
		]);
	});

	it("defers with the admission reason when another compiler holds the project", async () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ scripts: { "typecheck:stable": 'node -e "process.exit(0)"' } }),
		);
		let releaseBarrier: () => void = () => {};
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const barrier = new Promise<void>((resolve) => {
			releaseBarrier = resolve;
		});
		const owner = runWithProjectCompilerLease(tmp, async () => {
			markStarted();
			await barrier;
		});
		await started;

		const results = await checkProjectTypecheckCleanAsync(tmp);
		releaseBarrier();
		await owner;

		expect(results).toEqual([
			{
				source: "structural",
				name: "project_typecheck_deferred",
				severity: "warning",
				message:
					"Project typecheck was NOT CHECKED: compiler admission timed out while queued. Retry before committing or pushing.",
				determinism: "fully_deterministic",
			},
		]);
	});
});

describe("resolveTestCommand", () => {
	it("returns `npm test --silent` when a test script is declared", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ scripts: { test: "vitest run" } }),
		);
		const cmd = resolveTestCommand(tmp);
		expect(cmd?.source).toBe("npm-test");
		expect(cmd?.bin).toBe("npm");
		expect(cmd?.args).toEqual(["test", "--silent"]);
	});

	it("returns null when no test script is declared (gate stays inert)", () => {
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "no-test-repo" }));
		expect(resolveTestCommand(tmp)).toBeNull();
	});

	// test-contract: boundary — a null scripts field is treated as an absent test command without throwing
	it("returns null when package scripts is explicitly null", () => {
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ scripts: null }));
		expect(resolveTestCommand(tmp)).toBeNull();
	});

	it("returns null when there's no package.json at all", () => {
		expect(resolveTestCommand(tmp)).toBeNull();
	});

	it("returns null when package.json is malformed", () => {
		writeFileSync(join(tmp, "package.json"), "{ this is not json");
		expect(resolveTestCommand(tmp)).toBeNull();
	});
});

describe("parseTestFailures", () => {
	it("extracts test names from vitest red-cross lines", () => {
		const out = [
			"   × evaluateTscDiffOverlay > TS2322 is classified as blocking 4ms",
			"   × DEFAULT_ADVISORY_SKIPS > matches the expected set 10ms",
		].join("\n");
		expect(parseTestFailures(out)).toEqual([
			"evaluateTscDiffOverlay > TS2322 is classified as blocking 4ms",
			"DEFAULT_ADVISORY_SKIPS > matches the expected set 10ms",
		]);
	});

	it("extracts FAIL <path> headers", () => {
		const out =
			" FAIL  src/harness/__tests__/diff-overlay.test.ts > evaluateBiomeDiffOverlay";
		const failures = parseTestFailures(out);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain("diff-overlay.test.ts");
	});

	it("dedupes retry lines so one test counts once even with retries", () => {
		// Vitest emits the same FAIL line per retry attempt — the user
		// sees the failure once, not three times.
		const out = [
			" FAIL  src/foo.test.ts > a > b",
			" FAIL  src/foo.test.ts > a > b",
			" FAIL  src/foo.test.ts > a > b",
		].join("\n");
		expect(parseTestFailures(out)).toHaveLength(1);
	});

	it("returns empty array on clean output", () => {
		expect(parseTestFailures("Test Files  398 passed (398)\nTests  6120 passed")).toEqual(
			[],
		);
	});

	it("strips ANSI color codes before matching", () => {
		// Vitest emits ANSI escapes even when piped — without stripping,
		// the regex wouldn't match the failure prefix.
		const out = "\x1b[31m   ×\x1b[0m foo > bar > baz 4ms";
		const failures = parseTestFailures(out);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain("foo > bar > baz");
	});

	it("requires the failure marker at the start of a line and trims its message", () => {
		const out = [
			"noise FAIL suite > embedded",
			" FAIL suite > actual   ",
			"status: ✗ suite > embedded too",
		].join("\n");
		expect(parseTestFailures(out)).toEqual(["suite > actual"]);
	});

	// test-contract: boundary — the documented failure marker requires whitespace before the test name and tolerates padding
	it("requires marker whitespace while accepting multiple spaces", () => {
		const out = [
			"×  suite > padded 4ms",
			"×suite > missing separator",
		].join("\n");
		expect(parseTestFailures(out)).toEqual(["suite > padded 4ms"]);
	});
});

describe("checkProjectTestsClean", () => {
	it("no-ops on a project with no test script", () => {
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "no-test-repo" }));
		expect(checkProjectTestsClean(tmp)).toEqual([]);
	});

	// test-contract: public-api — an audited test bypass is a warning finding with stable structural metadata
	it("emits a skipped warning (not error) when bypassed via env var", () => {
		process.env.INTERLINKED_SKIP_PROJECT_TESTS = "1";
		const results = checkProjectTestsClean(tmp);
		expect(results).toHaveLength(1);
		expect(results).toEqual([
			{
				source: "structural",
				name: "project_tests_skipped",
				severity: "warning",
				message:
					"Project test gate bypassed via INTERLINKED_SKIP_PROJECT_TESTS=1. Verify CI manually before merging.",
				determinism: "fully_deterministic",
			},
		]);
	});

	it("returns empty when the test script exits 0", () => {
		// Stub script — same approach as the typecheck gate tests. We
		// verify the script-wiring contract, not real vitest behavior.
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }),
		);
		expect(checkProjectTestsClean(tmp)).toEqual([]);
	});

	it("returns one error entry per parsed test failure", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: {
					test: 'node -e "console.log(\\"   × suite > test 1 4ms\\");console.log(\\"   × suite > test 2 6ms\\");process.exit(1)"',
				},
			}),
		);
		const results = checkProjectTestsClean(tmp);
		expect(results).toEqual([
			{
				source: "structural",
				name: "project_tests_clean",
				severity: "error",
				message: "suite > test 1 4ms",
				determinism: "fully_deterministic",
			},
			{
				source: "structural",
				name: "project_tests_clean",
				severity: "error",
				message: "suite > test 2 6ms",
				determinism: "fully_deterministic",
			},
		]);
	});

	it("surfaces unparseable failure output rather than silently allowing", () => {
		// Same defensive contract as the typecheck gate. Non-zero exit
		// must always block — even if no failures parse.
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: {
					test: 'node -e "console.error(\\"vitest crashed: out of memory\\");process.exit(2)"',
				},
			}),
		);
		const results = checkProjectTestsClean(tmp);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).severity).toBe("error");
		expect(nonNull(results[0]).message).toContain("vitest crashed");
	});

	it("reports an empty raw failure without inventing output and caps failures at 10", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ scripts: { test: 'node -e "process.exit(2)"' } }),
		);
		const empty = checkProjectTestsClean(tmp);
		expect(empty).toHaveLength(1);
		expect(nonNull(empty[0])).toEqual({
			source: "structural",
			name: "project_tests_clean",
			severity: "error",
			message: "Project tests (npm-test) failed (exit 2) but no failure list parsed. Raw tail: ",
			determinism: "fully_deterministic",
		});

		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: {
					test: "node emit-many.js",
				},
			}),
		);
		writeFileSync(
			join(tmp, "emit-many.js"),
			"for (let i = 1; i <= 11; i++) console.log(` × suite > test ${i}`); process.exit(1);",
		);
		const many = checkProjectTestsClean(tmp);
		expect(many).toHaveLength(10);
		expect(nonNull(many[0]).message).toBe("suite > test 1");
		expect(nonNull(many[9]).message).toBe("suite > test 10");
		expect(many.some((r) => r.message === "suite > test 11")).toBe(false);
	});

	it("trims and truncates unparseable stderr in the fallback message", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: {
					test: "node emit-raw.js",
				},
			}),
		);
		writeFileSync(
			join(tmp, "emit-raw.js"),
			'process.stderr.write("  boom  " + "x".repeat(600)); process.exit(2);',
		);
		const results = checkProjectTestsClean(tmp);
		const message = nonNull(results[0]).message;
		expect(message).toContain("Raw tail: boom  ");
		expect(message).not.toContain("  boom");
		expect(message).not.toContain("x".repeat(501));
		expect(message).toHaveLength(
			"Project tests (npm-test) failed (exit 2) but no failure list parsed. Raw tail: ".length + 500,
		);
	});

	// test-contract: boundary — an undispatchable test runner is an audited warning, not a false clean result
	it("reports 'could not run' when spawnSync itself fails to launch npm", () => {
		// resolveTestCommand always resolves to the `npm` binary, so to force
		// spawnSync's own `result.error` (ENOENT) rather than a script
		// failure, PATH is temporarily emptied so `npm` can't be resolved.
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }),
		);
		const savedPath = process.env.PATH;
		process.env.PATH = "";
		try {
			const results = checkProjectTestsClean(tmp);
			expect(results).toHaveLength(1);
			expect(nonNull(results[0]).source).toBe("structural");
			expect(nonNull(results[0]).name).toBe("project_tests_failed_to_run");
			expect(nonNull(results[0]).severity).toBe("warning");
			expect(nonNull(results[0]).determinism).toBe("fully_deterministic");
			expect(nonNull(results[0]).message).toContain("could not run");
			expect(nonNull(results[0]).message).toContain("Verify CI manually");
		} finally {
			process.env.PATH = savedPath;
		}
	});

	// test-contract: public-api — terminated test runs expose the signal cause in the stable warning message
	it("reports 'exceeded timeout' when the test process is terminated by a signal", () => {
		// Same rationale as the typecheck gate's SIGTERM test: spawnSync's
		// timeout kill and a same-signal external kill look identical in the
		// result object, so a self-terminating stub proves the branch without
		// waiting out the real 5-minute budget.
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: { test: 'node -e "process.kill(process.pid, \\"SIGTERM\\")"' },
			}),
		);
		const results = checkProjectTestsClean(tmp);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).name).toBe("project_tests_timed_out");
		expect(nonNull(results[0]).severity).toBe("warning");
		expect(nonNull(results[0]).message).toContain("exceeded");
		expect(nonNull(results[0]).message).toContain("timeout");
		expect(nonNull(results[0]).message).toContain("signal SIGTERM");
	});

	// See the matching typecheck-gate test above for why `process.exit(143)`
	// pins this cross-platform: it reproduces the exit-code-only signal-death
	// shape deterministically everywhere, so asserting "signal SIGTERM" here
	// proves the derivation without depending on any OS/wrapper relay quirk.
	it("P: classifies the POSIX 128+n signal-exit encoding as terminated (Linux npm re-encodes SIGTERM as exit 143 with signal null — CI run 31517477152)", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ scripts: { test: 'node -e "process.exit(143)"' } }),
		);
		const results = checkProjectTestsClean(tmp);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0]).name).toBe("project_tests_timed_out");
		expect(nonNull(results[0]).severity).toBe("warning");
		expect(nonNull(results[0]).message).toContain("exit 143");
		expect(nonNull(results[0]).message).toContain("signal SIGTERM");
	});

	it("classifies the signal base exit code itself as terminated", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ scripts: { test: 'node -e "process.exit(128)"' } }),
		);
		const results = checkProjectTestsClean(tmp);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0])).toEqual({
			source: "structural",
			name: "project_tests_timed_out",
			severity: "warning",
			message: "Project tests (npm-test) exceeded 300s timeout or was terminated (exit 128). Verify CI manually.",
			determinism: "fully_deterministic",
		});
	});
});

describe("checkProjectTestsCleanAsync", () => {
	it("returns empty only after the bounded test command completes successfully", async () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
		);
		await expect(checkProjectTestsCleanAsync(tmp)).resolves.toEqual([]);
	});

	it("surfaces a missing test launcher as an explicit unavailable no-verdict", async () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
		);
		const savedPath = process.env.PATH;
		process.env.PATH = "";
		try {
			await expect(checkProjectTestsCleanAsync(tmp)).resolves.toEqual([
				{
					source: "structural",
					name: "project_tests_deferred",
					severity: "warning",
					message:
						"Project tests (npm-test) were NOT CHECKED (unavailable). Retry before pushing.",
					determinism: "fully_deterministic",
				},
			]);
		} finally {
			process.env.PATH = savedPath;
		}
	});

	it("blocks on unstructured non-zero output instead of laundering a crash as clean", async () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({
				scripts: {
					test: 'node -e "console.error(\\"runner crashed\\");process.exit(2)"',
				},
			}),
		);
		const results = await checkProjectTestsCleanAsync(tmp);
		expect(results).toHaveLength(1);
		expect(nonNull(results[0])).toMatchObject({
			name: "project_tests_clean",
			severity: "error",
		});
		expect(nonNull(results[0]).message).toContain("runner crashed");
	});

	it("treats a wrapper-encoded signal exit as deferred, not as a test failure", async () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ scripts: { test: 'node -e "process.exit(143)"' } }),
		);
		await expect(checkProjectTestsCleanAsync(tmp)).resolves.toEqual([
			{
				source: "structural",
				name: "project_tests_deferred",
				severity: "warning",
				message:
					"Project tests (npm-test) were NOT CHECKED (interrupted). Retry before pushing.",
				determinism: "fully_deterministic",
			},
		]);
	});
});
