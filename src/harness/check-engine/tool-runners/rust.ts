// ===========================================
// Tool Runners — Rust (cargo check, cargo clippy, rustfmt)
// ===========================================

import { spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { nonNull } from "../../../lib/non-null.js";
import { filterResultsToFile, parseCargoJson } from "../output-parsers.js";
import type { CheckResult, ToolRunnerInput } from "../types.js";

// -------------------------------------------
// cargo check
// -------------------------------------------

export function runCargoCheck(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		// cargo check is always project-wide
		const result = spawnSync("cargo", ["check", "--message-format=json"], {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		// Exit 0 = clean, exit 101 = compilation errors
		if (result.status === 0) return [];

		const output = (result.stdout || "") + (result.stderr || "");
		const results = parseCargoJson(output, "cargo-check");

		// In file mode, filter to the target file
		if (scope.mode === "file" && scope.targetFile && scope.filterToFile) {
			return filterResultsToFile(results, scope.targetFile);
		}
		return results;
	} catch {
		return [];
	}
}

// -------------------------------------------
// cargo clippy
// -------------------------------------------

export function runCargoClippy(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		const result = spawnSync(
			"cargo",
			["clippy", "--message-format=json", "--", "-W", "clippy::all"],
			{
				cwd: scope.projectRoot,
				timeout: timeoutMs,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		if (result.status === 0) return [];

		const output = (result.stdout || "") + (result.stderr || "");
		const results = parseCargoJson(output, "cargo-clippy");

		if (scope.mode === "file" && scope.targetFile && scope.filterToFile) {
			return filterResultsToFile(results, scope.targetFile);
		}
		return results;
	} catch {
		return [];
	}
}

// -------------------------------------------
// rustfmt --check (formatting)
// -------------------------------------------

/** Parse `Diff in <path> at line <n>:` / `Diff in <path>:<n>:` headers —
 *  rustfmt's --check output across versions. Exported for tests. */
export function parseRustfmtCheckOutput(output: string, projectRoot: string): CheckResult[] {
	const results: CheckResult[] = [];
	for (const lineText of output.split("\n")) {
		const m = lineText.match(/^Diff in (.+?)(?: at line |:)(\d+)/);
		if (!m) continue;
		results.push({
			tool: "rustfmt",
			severity: "warning",
			file: relative(projectRoot, nonNull(m[1])),
			line: Number.parseInt(nonNull(m[2]), 10),
			message: "not rustfmt-formatted — run `cargo fmt` (or `rustfmt <file>`)",
		});
	}
	return results;
}

/** Valid `edition` values a Cargo.toml can declare. */
const CARGO_EDITIONS = new Set(["2015", "2018", "2021", "2024"]);

/**
 * The crate edition governing `targetFile`: the `edition = "…"` of the nearest
 * Cargo.toml walking UP from the file to `projectRoot`. Direct `rustfmt`
 * (unlike `cargo fmt`) does NOT read Cargo.toml and defaults to edition 2015,
 * so 2021/2024 syntax produced a parse error that the old runner then
 * swallowed as "no diff headers" — formatting silently never validated
 * (finding 2026-06, round 6). Null when no Cargo.toml declares one.
 */
export function crateEditionFor(targetFile: string, projectRoot: string): string | null {
	const root = resolve(projectRoot);
	let dir = resolve(root, dirname(targetFile));
	if (!dir.startsWith(root)) dir = root;
	for (;;) {
		try {
			const manifest = readFileSync(join(dir, "Cargo.toml"), "utf-8");
			const m = manifest.match(/^\s*edition\s*=\s*"(\d{4})"/m);
			if (m && CARGO_EDITIONS.has(nonNull(m[1]))) return nonNull(m[1]);
		} catch (err) {
			// A missing manifest at this level is expected — keep walking up. Any
			// OTHER error (permissions, I/O) is genuinely exceptional: rethrow it
			// rather than silently mis-detecting the edition as 2015.
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		if (dir === root) return null;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** A single loud "the formatter could not run" finding — a tool failure must
 *  never read as a clean pass (finding 2026-06, round 6: a rustfmt parse error
 *  produced no diff headers and the runner reported nothing, silently skipping
 *  formatting validation while the check still carried its [proven] tag). */
function rustfmtFailureResult(
	target: string | undefined,
	projectRoot: string,
	status: number | null,
	stderr: string,
): CheckResult {
	const firstLine = stderr.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "no stderr";
	return {
		tool: "rustfmt",
		severity: "warning",
		file: target ? relative(projectRoot, resolve(projectRoot, target)) : ".",
		line: 1,
		message:
			`rustfmt failed (exit ${status ?? "none"}): ${firstLine.slice(0, 160)} — ` +
			"formatting NOT validated for this change",
	};
}

/** Spawn `rustfmt --check` for a single file, or `cargo fmt --all -- --check`
 *  for the whole project — the two invocation shapes `runRustfmtCheck` picks
 *  between. File mode threads the crate edition explicitly (bare rustfmt does
 *  not read Cargo.toml and would parse 2021/2024 syntax as edition-2015
 *  errors). */
function spawnRustfmt(
	fileTarget: string | undefined,
	scope: ToolRunnerInput["scope"],
	timeoutMs: number,
): SpawnSyncReturns<string> {
	const spawnOpts: SpawnSyncOptionsWithStringEncoding = {
		cwd: scope.projectRoot,
		timeout: timeoutMs,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	};
	if (!fileTarget) {
		return spawnSync("cargo", ["fmt", "--all", "--", "--check", "--color=never"], spawnOpts);
	}
	const edition = crateEditionFor(fileTarget, scope.projectRoot);
	const args = [
		"--check",
		"--color=never",
		...(edition !== null ? ["--edition", edition] : []),
		fileTarget,
	];
	return spawnSync("rustfmt", args, spawnOpts);
}

/** Turn a non-zero, non-ENOENT `rustfmt`/`cargo fmt` result into findings:
 *  parsed diff headers scoped to the edited file, or — when nothing parsed —
 *  a loud tool-failure result so a parse error never reads as a clean pass. */
function interpretRustfmtFailure(
	result: SpawnSyncReturns<string>,
	fileTarget: string | undefined,
	scope: ToolRunnerInput["scope"],
): CheckResult[] {
	const output = (result.stdout || "") + (result.stderr || "");
	const parsed = parseRustfmtCheckOutput(output, scope.projectRoot);
	// Honor file-scope (finding 2026-06, round 7): pointing rustfmt at a crate
	// root / mod.rs makes it recurse and report formatting diffs in CHILD
	// modules. A per-edit check must surface only the edited file's findings,
	// not pre-existing diffs elsewhere — the same `filterToFile` contract
	// cargo check/clippy already honor above.
	const findings =
		scope.mode === "file" && scope.targetFile && scope.filterToFile
			? filterResultsToFile(parsed, scope.targetFile)
			: parsed;
	if (findings.length > 0) return findings;
	// Parsed diffs existed but were all filtered out as OTHER files → the
	// edited file is clean; don't synthesize a tool-failure warning.
	if (parsed.length > 0) return [];
	// Non-zero with NO parsable diff headers = the tool itself failed (parse
	// error, bad flag, timeout). Surfacing it as a distinct "not validated"
	// warning keeps the failure visible without double-reporting the syntax
	// error itself (cargo-check owns that diagnostic).
	return [rustfmtFailureResult(fileTarget, scope.projectRoot, result.status, result.stderr || "")];
}

export function runRustfmtCheck(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		// File mode checks the one edited file (the cheap per-edit path);
		// project mode defers workspace discovery to cargo fmt.
		const fileTarget = scope.mode === "file" ? scope.targetFile : undefined;
		const result = spawnRustfmt(fileTarget, scope, timeoutMs);

		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		// Exit 0 = formatted clean.
		if (result.status === 0) return [];
		return interpretRustfmtFailure(result, fileTarget, scope);
	} catch {
		return [];
	}
}
