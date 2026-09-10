// ===========================================
// Tool Runner — TypeScript (tsc / tsgo)
// ===========================================
// Prefers tsgo (TypeScript 7 native Go compiler) when available.
// Falls back to tsc transparently. Output format is identical.

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { errorMessage } from "../../../lib/error-message.js";
import {
	ProjectCompilerUnavailableError,
	runWithProjectCompilerLease,
	tryAcquireProjectCompilerLease,
} from "../../project-compiler-gate.js";
import { filterResultsToFile, parseTscOutput } from "../output-parsers.js";
import { runProcessAsync, type RunProcessResult } from "../spawn-async.js";
import type { CheckResult, ToolRunnerInput } from "../types.js";

/** Walk up from startDir to find tsconfig.json (max 5 levels). */
function findTsconfig(startDir: string): string | null {
	let dir = startDir;
	for (let i = 0; i < 5; i++) {
		if (existsSync(resolve(dir, "tsconfig.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

// -------------------------------------------
// tsgo detection (cached per process)
// -------------------------------------------
// Resolves tsgo from the CLI's own dependencies first, so it works in any
// codebase the harness runs in — not just projects that have
// @typescript/native-preview installed locally.

/** Cached result: absolute path to tsgo.js, "npx", or null (not available). */
let _tsgoResolved: { bin: string; viaNode: boolean } | null | undefined;
/** Daemon-path resolution never launches a synchronous version probe. */
let _daemonTsgoResolved: { bin: string; viaNode: boolean } | null | undefined;

const COMPILER_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024;

function unavailableFinding(file: string, reason: string): CheckResult[] {
	return [
		{
			tool: "tsc",
			severity: "warning",
			file,
			line: 0,
			message: `[interlinked:tsc-unavailable] TypeScript was NOT CHECKED: ${reason}`,
			ruleId: "tsc-unavailable",
		},
	];
}

export function parseCompletedCompiler(output: string, status: number, file: string): CheckResult[] {
	if (output.length >= COMPILER_OUTPUT_LIMIT_BYTES) {
		return unavailableFinding(file, "compiler output was truncated");
	}
	const parsed = parseTscOutput(output);
	if (status !== 0 && parsed.length === 0) {
		return unavailableFinding(file, `compiler exited ${status} without parseable diagnostics`);
	}
	return parsed;
}

function parseSyncCompilerResult(
	result: SpawnSyncReturns<string>,
	file: string,
): CheckResult[] {
	if (result.error) return unavailableFinding(file, `compiler failed: ${result.error.message}`);
	if (result.signal) return unavailableFinding(file, `compiler was killed by ${result.signal}`);
	if (result.status === null) return unavailableFinding(file, "compiler returned no exit status");
	return parseCompletedCompiler(`${result.stdout || ""}${result.stderr || ""}`, result.status, file);
}

function runCompilerSync(options: {
	cmd: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	resultFile: string;
}): CheckResult[] {
	const release = tryAcquireProjectCompilerLease(options.cwd);
	if (!release) return unavailableFinding(options.resultFile, "another compiler owns this project");
	try {
		const result = spawnSync(options.cmd, options.args, {
			cwd: options.cwd,
			timeout: options.timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return parseSyncCompilerResult(result, options.resultFile);
	} catch (error) {
		const detail = errorMessage(error);
		return unavailableFinding(options.resultFile, `compiler spawn threw: ${detail}`);
	} finally {
		release();
	}
}

function parseAsyncCompilerResult(result: RunProcessResult, file: string): CheckResult[] {
	if (result.timedOut) return unavailableFinding(file, "compiler timed out and was terminated");
	if (result.killed) return unavailableFinding(file, "compiler was terminated before completion");
	if (result.code === null) return unavailableFinding(file, "compiler failed to spawn or exit cleanly");
	return parseCompletedCompiler(`${result.stdout}${result.stderr}`, result.code, file);
}

function compilerResultFile(input: ToolRunnerInput, projectRoot: string): string {
	const target = input.scope.mode === "file" ? input.scope.targetFile : undefined;
	return target ? relative(projectRoot, target) : "tsconfig.json";
}

function compilerWasUnavailable(findings: readonly CheckResult[]): boolean {
	return findings.some((finding) => finding.ruleId === "tsc-unavailable");
}

function bundledTsgoPath(): string | null {
	try {
		const require = createRequire(import.meta.url);
		const pkgPath = require.resolve("@typescript/native-preview/package.json");
		const tsgoBin = resolve(dirname(pkgPath), "bin", "tsgo.js");
		return existsSync(tsgoBin) ? tsgoBin : null;
	} catch {
		return null;
	}
}

/**
 * Resolve the tsgo binary. Priority:
 * 1. CLI's own node_modules (via createRequire — works even in foreign projects)
 * 2. Target project's npx (in case they pin a different version)
 * 3. null → fall back to tsc
 */
function resolveTsgo(): { bin: string; viaNode: boolean } | null {
	if (_tsgoResolved !== undefined) return _tsgoResolved;

	// 1. Try resolving from the CLI's own dependency tree
	const tsgoBin = bundledTsgoPath();
	if (tsgoBin) {
		try {
			// Verify it actually runs
			const check = spawnSync("node", [tsgoBin, "--version"], {
				timeout: 5_000,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			if (check.status === 0 && !check.error) {
				_tsgoResolved = { bin: tsgoBin, viaNode: true };
				return _tsgoResolved;
			}
		} catch {
			// Compatibility sync path only: fall through to the npx probe.
			void 0;
		}
	}

	// 2. Try npx (target project's own install)
	try {
		const result = spawnSync("npx", ["tsgo", "--version"], {
			timeout: 5_000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (result.status === 0 && !result.error) {
			_tsgoResolved = { bin: "tsgo", viaNode: false };
			return _tsgoResolved;
		}
	} catch (_err) {
		void 0; /* intentional: not available via npx either — return null below */
	}

	_tsgoResolved = null;
	return null;
}

/** Returns the resolved tsgo info, or null to fall back to tsc. */
function tscCommand(): { cmd: string; args: string[]; useTsgo: boolean } {
	const tsgo = resolveTsgo();
	if (tsgo) {
		if (tsgo.viaNode) {
			// Direct invocation: node /abs/path/to/tsgo.js
			return { cmd: "node", args: [tsgo.bin], useTsgo: true };
		}
		// npx invocation
		return { cmd: "npx", args: ["tsgo"], useTsgo: true };
	}
	return { cmd: "npx", args: ["tsc"], useTsgo: false };
}

/**
 * Compiler selection for the daemon's async path. Resolving a bundled module
 * is cheap filesystem work; launching `--version` through spawnSync is not.
 * The actual async compiler invocation is the executable check and reports a
 * typed unavailable finding if this candidate is broken. When the bundled
 * compiler is absent, use the project's tsc rather than synchronously probing
 * npx on the daemon event loop.
 */
function tscCommandForAsyncRunner(): { cmd: string; args: string[]; useTsgo: boolean } {
	if (_daemonTsgoResolved === undefined) {
		const bin = bundledTsgoPath();
		_daemonTsgoResolved = bin ? { bin, viaNode: true } : null;
	}
	if (_daemonTsgoResolved) {
		return { cmd: "node", args: [_daemonTsgoResolved.bin], useTsgo: true };
	}
	return { cmd: "npx", args: ["tsc"], useTsgo: false };
}

export function runTsc(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;
	const tscRoot = findTsconfig(scope.projectRoot);
	const { cmd, args: cmdArgs } = tscCommand();

	// If no tsconfig found but we have a specific .ts file, type-check it standalone.
	// This catches standalone scripts (hooks, configs) outside any tsconfig project.
	if (!tscRoot) {
		if (scope.mode === "file" && scope.targetFile?.match(/\.tsx?$/)) {
			return runTscStandalone(scope.targetFile, scope.projectRoot, timeoutMs);
		}
		return [];
	}

	const parsed = runCompilerSync({
		cmd,
		args: [...cmdArgs, "--noEmit", "--pretty", "false"],
		cwd: tscRoot,
		timeoutMs,
		resultFile: compilerResultFile(input, tscRoot),
	});

	if (scope.mode === "file" && scope.targetFile && scope.filterToFile) {
		if (compilerWasUnavailable(parsed)) return parsed;
		const rel = relative(tscRoot, scope.targetFile);
		const filtered = filterResultsToFile(parsed, rel);
		if (filtered.length === 0 && !isFileInTscScope(scope.targetFile, tscRoot)) {
			return runTscStandalone(scope.targetFile, tscRoot, timeoutMs);
		}
		return filtered;
	}

	return parsed;
}

/**
 * Type-check a standalone .ts file that isn't part of any tsconfig project.
 * Uses minimal compiler options to catch obvious errors (missing types, bad imports).
 */
function runTscStandalone(filePath: string, cwd: string, timeoutMs: number): CheckResult[] {
	const { cmd, args: cmdArgs, useTsgo } = tscCommand();
	const args = [
		...cmdArgs,
		"--noEmit",
		"--pretty",
		"false",
		// tsgo requires --ignoreConfig when passing files on the command line
		// in the presence of a tsconfig.json, otherwise it errors with TS5112.
		...(useTsgo ? ["--ignoreConfig"] : []),
		"--esModuleInterop",
		"--module",
		"nodenext",
		"--moduleResolution",
		"nodenext",
		"--target",
		"es2022",
		"--skipLibCheck",
		filePath,
	];
	return runCompilerSync({ cmd, args, cwd, timeoutMs, resultFile: relative(cwd, filePath) });
}

/**
 * Async variant of `runTsc`. Used by `runChecksAsync` for true concurrent
 * execution under the limiter. Behaviorally identical to the sync runner —
 * same output parser, same standalone-fallback path — but uses
 * `child_process.spawn` instead of `spawnSync` so multiple language tools
 * can actually run concurrently rather than serially blocking the event
 * loop. Phase A.1 of the Free CLI Phase-2 roadmap.
 */
export async function runTscAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope, timeoutMs } = input;
	const tscRoot = findTsconfig(scope.projectRoot);
	const { cmd, args: cmdArgs } = tscCommandForAsyncRunner();

	if (!tscRoot) {
		if (scope.mode === "file" && scope.targetFile?.match(/\.tsx?$/)) {
			return runTscStandaloneAsync(scope.targetFile, scope.projectRoot, timeoutMs);
		}
		return [];
	}

	const parsed = await runProjectCheck(
		tscRoot,
		timeoutMs,
		cmd,
		cmdArgs,
		compilerResultFile(input, tscRoot),
	);

	if (scope.mode === "file" && scope.targetFile && scope.filterToFile) {
		if (compilerWasUnavailable(parsed)) return parsed;
		const rel = relative(tscRoot, scope.targetFile);
		const filtered = filterResultsToFile(parsed, rel);
		if (filtered.length === 0 && !isFileInTscScope(scope.targetFile, tscRoot)) {
			return runTscStandaloneAsync(scope.targetFile, tscRoot, timeoutMs);
		}
		return filtered;
	}
	return parsed;
}

async function runProjectCheck(
	tscRoot: string,
	timeoutMs: number,
	cmd: string,
	cmdArgs: string[],
	resultFile: string,
): Promise<CheckResult[]> {
	try {
		return await runWithProjectCompilerLease(tscRoot, async () => {
			const result = await runProcessAsync(
				cmd,
				[...cmdArgs, "--noEmit", "--pretty", "false"],
				{ cwd: tscRoot, timeout: timeoutMs },
			);
			return parseAsyncCompilerResult(result, resultFile);
		});
	} catch (error) {
		const reason =
			error instanceof ProjectCompilerUnavailableError
				? error.message
				: `compiler admission failed: ${errorMessage(error)}`;
		return unavailableFinding(resultFile, reason);
	}
}

async function runTscStandaloneAsync(
	filePath: string,
	cwd: string,
	timeoutMs: number,
): Promise<CheckResult[]> {
	const { cmd, args: cmdArgs, useTsgo } = tscCommandForAsyncRunner();
	const args = [
		...cmdArgs,
		"--noEmit",
		"--pretty",
		"false",
		...(useTsgo ? ["--ignoreConfig"] : []),
		"--esModuleInterop",
		"--module",
		"nodenext",
		"--moduleResolution",
		"nodenext",
		"--target",
		"es2022",
		"--skipLibCheck",
		filePath,
	];
	try {
		const result = await runWithProjectCompilerLease(cwd, () =>
			runProcessAsync(cmd, args, { cwd, timeout: timeoutMs }),
		);
		return parseAsyncCompilerResult(result, relative(cwd, filePath));
	} catch (error) {
		return unavailableFinding(
			relative(cwd, filePath),
			errorMessage(error),
		);
	}
}

/** Check if a file is included in the tsconfig's compilation scope. */
export function isFileInTscScope(filePath: string, tscRoot: string): boolean {
	try {
		// Quick heuristic: check if the file is under a directory referenced by tsconfig
		const rel = relative(tscRoot, filePath);
		// Files outside the tsconfig root (../) are definitely not in scope
		if (rel.startsWith("..")) return false;
		// Files in common non-source directories are likely not in scope
		if (
			rel.startsWith(".claude/") ||
			rel.startsWith(".interlinked/") ||
			rel.startsWith("scripts/")
		)
			return false;
		return true;
	} catch {
		return true;
	}
}
