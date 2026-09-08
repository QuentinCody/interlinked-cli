import type { SpawnSyncStub } from "./test-process-fixtures.js";
// Behavioral unit tests for the Rust tool runners (cargo check, cargo clippy).
//
// Both runners are synchronous, so the only boundary mocked is
// node:child_process `spawnSync`. The real `parseCargoJson` /
// `filterResultsToFile` parsers run unmocked so we exercise the actual
// NDJSON → CheckResult[] mapping and the file-mode filter branch.
//
// Every branch of both runners is covered:
//   • ENOENT (cargo absent) → []
//   • status === 0 (clean compile) → []
//   • status === 101 (compile errors) → parsed diagnostics
//   • status === null (spawn never started, no .error) → parse path
//   • stdout / stderr `|| ""` fallbacks (one side undefined)
//   • file mode + targetFile + filterToFile → filtered to target
//   • project mode (and partial file-mode triggers) → unfiltered
//   • catch block (spawnSync throws) → []

import type { SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import type { CheckResult, CheckScope, ToolRunnerInput } from "../types.js";

const spawnSyncMock = vi.fn<SpawnSyncStub>();

vi.mock("node:child_process", () => ({
	spawnSync: (...args: Parameters<SpawnSyncStub>) => spawnSyncMock(...args),
}));

// Imported after the mock is registered.
const { runCargoCheck, runCargoClippy, runRustfmtCheck, parseRustfmtCheckOutput, crateEditionFor } =
	await import("./rust.js");

const PROJECT_ROOT = "/work/crate";
const TARGET_FILE = "src/lib.rs";

/**
 * Build one line of cargo's `--message-format=json` NDJSON stream:
 * a `compiler-message` carrying a single span. `parseCargoJson` only
 * emits a CheckResult for lines shaped exactly like this.
 */
function cargoMessageLine(over: {
	level?: string;
	fileName?: string;
	lineStart?: number;
	columnStart?: number;
	message?: string;
	code?: string | null;
}): string {
	const code = over.code === null ? null : { code: over.code ?? "E0308" };
	return JSON.stringify({
		reason: "compiler-message",
		message: {
			level: over.level ?? "error",
			message: over.message ?? "mismatched types",
			code,
			spans: [
				{
					file_name: over.fileName ?? TARGET_FILE,
					line_start: over.lineStart ?? 7,
					column_start: over.columnStart ?? 3,
				},
			],
		},
	});
}

/** A non-compiler-message NDJSON line (e.g. cargo's build progress). */
function nonMessageLine(): string {
	return JSON.stringify({ reason: "compiler-artifact", package_id: "crate 0.1.0" });
}

function fileScope(overrides: Partial<CheckScope> = {}): CheckScope {
	return {
		projectRoot: PROJECT_ROOT,
		mode: "file",
		targetFile: TARGET_FILE,
		filterToFile: true,
		...overrides,
	};
}

function input(scope: CheckScope, timeoutMs = 5_000): ToolRunnerInput {
	return { scope, timeoutMs };
}

/** Minimal SpawnSyncReturns; `stdout`/`stderr` widened so we can pass
 *  `undefined` to exercise the runners' `|| ""` fallbacks. */
function spawnResult(
	over: Partial<Omit<SpawnSyncReturns<string>, "stdout" | "stderr">> & {
		stdout?: string | undefined;
		stderr?: string | undefined;
	},
): SpawnSyncReturns<string> {
	const base: SpawnSyncReturns<string> = {
		pid: 321,
		output: [],
		stdout: "",
		stderr: "",
		status: null,
		signal: null,
	};
	// SAFETY: this fixture deliberately allows absent stdout/stderr to exercise the runner's fallback for incomplete process results.
	return { ...base, ...over } as SpawnSyncReturns<string>;
}

function enoentError(): NodeJS.ErrnoException {
	const e: NodeJS.ErrnoException = new Error("spawn cargo ENOENT");
	e.code = "ENOENT";
	return e;
}

beforeEach(() => {
	spawnSyncMock.mockReset();
});

// Each runner shares an identical control-flow skeleton, so the suite is
// parametrized over both. `expectedTool` is what the runner stamps onto
// each CheckResult; `expectedArgv` pins the exact cargo invocation.
const runners = [
	{
		name: "runCargoCheck",
		fn: runCargoCheck,
		expectedTool: "cargo-check" as const,
		expectedArgv: ["check", "--message-format=json"],
	},
	{
		name: "runCargoClippy",
		fn: runCargoClippy,
		expectedTool: "cargo-clippy" as const,
		expectedArgv: ["clippy", "--message-format=json", "--", "-W", "clippy::all"],
	},
];

describe.each(runners)("$name", ({ fn, expectedTool, expectedArgv }) => {
	it("invokes cargo with the right argv, cwd, timeout, encoding and pipes", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		fn(input(fileScope(), 8_888));

		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = nonNull(spawnSyncMock.mock.calls[0]);
		expect(cmd).toBe("cargo");
		expect(args).toEqual(expectedArgv);
		expect(opts).toMatchObject({
			cwd: PROJECT_ROOT,
			timeout: 8_888,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("returns [] when cargo is absent (error.code === ENOENT)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: null, error: enoentError() }));
		expect(fn(input(fileScope()))).toEqual([]);
	});

	it("returns [] for a non-ENOENT spawn error that still reports status 0", () => {
		// A generic error whose code !== ENOENT does NOT hit the early return;
		// status === 0 then takes over and yields the clean-compile [].
		const e: NodeJS.ErrnoException = new Error("EACCES");
		e.code = "EACCES";
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, error: e }));
		expect(fn(input(fileScope()))).toEqual([]);
	});

	it("returns [] on a clean compile (status === 0) without parsing", () => {
		// stdout carries a would-be diagnostic, but status 0 short-circuits
		// before the parser ever sees it.
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 0, stdout: cargoMessageLine({}) }),
		);
		expect(fn(input(fileScope()))).toEqual([]);
	});

	it("parses an error diagnostic from stdout on status 101 (file mode, on-target)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 101,
				stdout: `${nonMessageLine()}\n${cargoMessageLine({
					level: "error",
					message: "mismatched types",
					code: "E0308",
					lineStart: 12,
					columnStart: 5,
				})}\n`,
			}),
		);
		const out = fn(input(fileScope()));
		expect(out).toEqual<CheckResult[]>([
			{
				tool: expectedTool,
				severity: "error",
				file: TARGET_FILE,
				line: 12,
				column: 5,
				message: "mismatched types",
				ruleId: "E0308",
			},
		]);
	});

	it("maps a non-error level to severity 'warning'", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 101,
				stdout: cargoMessageLine({
					level: "warning",
					message: "unused variable: `x`",
					code: "unused_variables",
				}),
			}),
		);
		const out = fn(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			tool: expectedTool,
			severity: "warning",
			ruleId: "unused_variables",
			message: "unused variable: `x`",
		});
	});

	it("reads diagnostics from stderr when stdout is undefined ('' fallback)", () => {
		// stdout undefined exercises `(result.stdout || "")`; the diagnostic
		// arrives via stderr, exercising the stderr side of the concat.
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 101,
				stdout: undefined,
				stderr: cargoMessageLine({ message: "borrow checker error", code: "E0502" }),
			}),
		);
		const out = fn(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toBe("borrow checker error");
		expect(nonNull(out[0]).ruleId).toBe("E0502");
	});

	it("handles undefined stderr via the '' fallback (stdout-only diagnostic)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 101,
				stdout: cargoMessageLine({ message: "type error" }),
				stderr: undefined,
			}),
		);
		const out = fn(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toBe("type error");
	});

	it("returns [] on status 101 with empty output (parser yields nothing)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 101, stdout: "", stderr: "" }));
		expect(fn(input(fileScope()))).toEqual([]);
	});

	it("treats status === null (no error) as non-zero and parses output", () => {
		// Neither ENOENT nor status 0 — falls through to the parse path.
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: null, stdout: cargoMessageLine({ message: "killed mid-build" }) }),
		);
		const out = fn(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toBe("killed mid-build");
	});

	it("emits ruleId undefined when the diagnostic carries no code", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 101, stdout: cargoMessageLine({ code: null }) }),
		);
		const out = fn(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).ruleId).toBeUndefined();
	});

	// --- file-mode filtering branch -----------------------------------------

	it("filters out off-target diagnostics in file mode (filterToFile=true)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 101,
				stdout: [
					cargoMessageLine({ fileName: "src/other.rs", message: "in other file" }),
					cargoMessageLine({ fileName: TARGET_FILE, message: "in target file" }),
				].join("\n"),
			}),
		);
		const out = fn(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe(TARGET_FILE);
		expect(nonNull(out[0]).message).toBe("in target file");
	});

	it("matches via endsWith when cargo reports an absolute path for the target", () => {
		// filterResultsToFile keeps results whose file endsWith targetFile.
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 101,
				stdout: cargoMessageLine({
					fileName: `${PROJECT_ROOT}/${TARGET_FILE}`,
					message: "abs path diag",
				}),
			}),
		);
		const out = fn(input(fileScope({ targetFile: `${PROJECT_ROOT}/${TARGET_FILE}` })));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toBe("abs path diag");
	});

	it("does NOT filter in project mode (returns every file's diagnostics)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 101,
				stdout: [
					cargoMessageLine({ fileName: "src/a.rs", message: "diag a" }),
					cargoMessageLine({ fileName: "src/b.rs", message: "diag b" }),
				].join("\n"),
			}),
		);
		const out = fn(input(fileScope({ mode: "project" })));
		expect(out).toHaveLength(2);
		expect(out.map((r) => r.file)).toEqual(["src/a.rs", "src/b.rs"]);
	});

	it("does NOT filter when filterToFile is absent even in file mode", () => {
		const scope = fileScope();
		delete scope.filterToFile;
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 101,
				stdout: [
					cargoMessageLine({ fileName: "src/x.rs", message: "diag x" }),
					cargoMessageLine({ fileName: TARGET_FILE, message: "diag target" }),
				].join("\n"),
			}),
		);
		const out = fn(input(scope));
		expect(out).toHaveLength(2);
	});

	it("does NOT filter when targetFile is absent even in file mode", () => {
		const scope = fileScope();
		delete (scope).targetFile;
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 101,
				stdout: cargoMessageLine({ fileName: "src/anywhere.rs", message: "kept" }),
			}),
		);
		const out = fn(input(scope));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe("src/anywhere.rs");
	});

	it("returns [] from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(fn(input(fileScope()))).toEqual([]);
	});
});

// -------------------------------------------
// rustfmt --check
// -------------------------------------------

describe("parseRustfmtCheckOutput", () => {
	it("parses the `at line` header format", () => {
		const out = parseRustfmtCheckOutput(
			`Diff in ${PROJECT_ROOT}/src/lib.rs at line 5:\n some diff body\n`,
			PROJECT_ROOT,
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ tool: "rustfmt", severity: "warning", file: "src/lib.rs", line: 5 });
	});

	it("parses the colon header format", () => {
		const out = parseRustfmtCheckOutput(
			`Diff in ${PROJECT_ROOT}/src/main.rs:12:\n`,
			PROJECT_ROOT,
		);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe("src/main.rs");
		expect(nonNull(out[0]).line).toBe(12);
	});

	it("emits one finding per diff header and ignores diff bodies", () => {
		const out = parseRustfmtCheckOutput(
			[
				`Diff in ${PROJECT_ROOT}/src/a.rs at line 1:`,
				"-fn x(){}",
				"+fn x() {}",
				`Diff in ${PROJECT_ROOT}/src/b.rs at line 9:`,
			].join("\n"),
			PROJECT_ROOT,
		);
		expect(out.map((r) => r.file)).toEqual(["src/a.rs", "src/b.rs"]);
	});

	it("returns [] for non-diff output (e.g. a parse error message)", () => {
		expect(parseRustfmtCheckOutput("error: expected one of `!` or `::`\n", PROJECT_ROOT)).toEqual(
			[],
		);
	});
});

describe("runRustfmtCheck", () => {
	it("file mode invokes rustfmt --check on the single target file", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runRustfmtCheck(input(fileScope()));
		expect(spawnSyncMock).toHaveBeenCalledWith(
			"rustfmt",
			["--check", "--color=never", TARGET_FILE],
			expect.objectContaining({ cwd: PROJECT_ROOT }),
		);
	});

	it("project mode delegates to cargo fmt --all -- --check", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runRustfmtCheck(input({ projectRoot: PROJECT_ROOT, mode: "project" }));
		expect(spawnSyncMock).toHaveBeenCalledWith(
			"cargo",
			["fmt", "--all", "--", "--check", "--color=never"],
			expect.objectContaining({ cwd: PROJECT_ROOT }),
		);
	});

	it("returns [] when rustfmt is not installed (ENOENT)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ error: enoentError(), status: null }));
		expect(runRustfmtCheck(input(fileScope()))).toEqual([]);
	});

	it("returns [] on a clean exit (file already formatted)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: "" }));
		expect(runRustfmtCheck(input(fileScope()))).toEqual([]);
	});

	it("maps diff output to warnings on a non-zero exit", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 1,
				stdout: `Diff in ${PROJECT_ROOT}/${TARGET_FILE} at line 3:\n-fn a(){}\n+fn a() {}\n`,
			}),
		);
		const out = runRustfmtCheck(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ tool: "rustfmt", file: TARGET_FILE, line: 3 });
	});

	it("surfaces a tool FAILURE on a non-zero exit with no diff headers (round 6: silence read as clean)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 1, stderr: "error: this file contains an unclosed delimiter\n" }),
		);
		const out = runRustfmtCheck(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ tool: "rustfmt", severity: "warning", file: TARGET_FILE });
		expect(nonNull(out[0]).message).toContain("formatting NOT validated");
		expect(nonNull(out[0]).message).toContain("unclosed delimiter");
	});

	it("returns [] from runRustfmtCheck's catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(runRustfmtCheck(input(fileScope()))).toEqual([]);
	});

	// Round 7 (finding 2026-06): rustfmt aimed at a crate root / mod.rs recurses
	// into child modules and reports their formatting diffs too. A per-edit
	// check must honor filterToFile and surface only the EDITED file's findings.
	it("filters child-module diffs to the target file in file mode (filterToFile=true)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 1,
				stdout: [
					`Diff in ${PROJECT_ROOT}/${TARGET_FILE} at line 3:`,
					`Diff in ${PROJECT_ROOT}/src/other_mod.rs at line 9:`,
					`Diff in ${PROJECT_ROOT}/src/nested/deep.rs at line 1:`,
				].join("\n"),
			}),
		);
		const out = runRustfmtCheck(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe(TARGET_FILE);
	});

	it("returns [] (target clean) when ONLY other files have diffs — no synthesized failure", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 1,
				stdout: `Diff in ${PROJECT_ROOT}/src/other_mod.rs at line 9:\n-fn a(){}\n+fn a() {}\n`,
			}),
		);
		expect(runRustfmtCheck(input(fileScope()))).toEqual([]);
	});

	it("does NOT filter when filterToFile is absent (project-wide reporting preserved)", () => {
		const scope = fileScope();
		delete scope.filterToFile;
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 1,
				stdout: [
					`Diff in ${PROJECT_ROOT}/${TARGET_FILE} at line 3:`,
					`Diff in ${PROJECT_ROOT}/src/other_mod.rs at line 9:`,
				].join("\n"),
			}),
		);
		expect(runRustfmtCheck(input(scope))).toHaveLength(2);
	});
});

// -------------------------------------------
// rustfmt — crate edition threading (round 6)
// -------------------------------------------
// Direct `rustfmt` does not read Cargo.toml and defaults to edition 2015, so
// 2021/2024 syntax parse-errored and (pre-fix) the runner suppressed the
// failure entirely — formatting silently never validated.

describe("crateEditionFor + file-mode --edition threading", () => {
	let crateRoot: string;

	beforeEach(() => {
		crateRoot = mkdtempSync(join(tmpdir(), "rustfmt-edition-"));
	});

	afterEach(() => {
		rmSync(crateRoot, { recursive: true, force: true });
	});

	it("reads the edition from the nearest Cargo.toml walking up from the file", () => {
		mkdirSync(join(crateRoot, "member/src"), { recursive: true });
		writeFileSync(join(crateRoot, "Cargo.toml"), '[workspace]\nmembers = ["member"]\n', "utf-8");
		writeFileSync(
			join(crateRoot, "member/Cargo.toml"),
			'[package]\nname = "member"\nedition = "2021"\n',
			"utf-8",
		);
		expect(crateEditionFor("member/src/lib.rs", crateRoot)).toBe("2021");
		// A file outside the member falls through to the (edition-less) root.
		expect(crateEditionFor("src/other.rs", crateRoot)).toBeNull();
	});

	it("ignores values outside the known edition set", () => {
		writeFileSync(join(crateRoot, "Cargo.toml"), 'edition = "2099"\n', "utf-8");
		expect(crateEditionFor("src/lib.rs", crateRoot)).toBeNull();
	});

	it("passes --edition to file-mode rustfmt when the crate declares one", () => {
		mkdirSync(join(crateRoot, "src"), { recursive: true });
		writeFileSync(
			join(crateRoot, "Cargo.toml"),
			'[package]\nname = "x"\nedition = "2024"\n',
			"utf-8",
		);
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runRustfmtCheck(input({ projectRoot: crateRoot, mode: "file", targetFile: "src/lib.rs" }));
		expect(spawnSyncMock).toHaveBeenCalledWith(
			"rustfmt",
			["--check", "--color=never", "--edition", "2024", "src/lib.rs"],
			expect.objectContaining({ cwd: crateRoot }),
		);
	});
});
