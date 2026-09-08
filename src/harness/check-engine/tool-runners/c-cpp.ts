// ===========================================
// Tool Runners — C/C++ (gcc/clang syntax check, clang-tidy)
// ===========================================

import { spawnSync } from "node:child_process";
import { hasErrorCode } from "../tool-errors.js";
import { parseClangTidyOutput, parseGccOutput } from "../output-parsers.js";
import type { CheckResult, ToolRunnerInput } from "../types.js";

const C_EXTENSIONS = /\.[chm](pp|xx|c|m)?$/;

/** Detect available C/C++ compiler (gcc preferred, clang fallback). */
function detectCompiler(): string | null {
	for (const cmd of ["gcc", "clang"]) {
		try {
			const result = spawnSync(cmd, ["--version"], {
				timeout: 3_000,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			if (!result.error) return cmd;
		} catch (_err) {
			void 0; /* intentional: spawn failed — continue to next compiler candidate */
		}
	}
	return null;
}

// -------------------------------------------
// C/C++ compile check (gcc/clang -fsyntax-only)
// -------------------------------------------

export function runCCompile(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	// Syntax-only checks require a specific file in file mode.
	// Project-wide compilation is too complex without a build system.
	if (scope.mode !== "file" || !scope.targetFile) return [];
	if (!C_EXTENSIONS.test(scope.targetFile)) return [];

	const compiler = detectCompiler();
	if (!compiler) return [];

	try {
		const result = spawnSync(compiler, ["-fsyntax-only", "-Wall", scope.targetFile], {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (hasErrorCode(result.error, "ENOENT")) {
			return [];
		}
		if (result.status === 0) return [];

		// gcc/clang errors go to stderr
		const output = (result.stderr || "") + (result.stdout || "");
		return parseGccOutput(output);
	} catch {
		return [];
	}
}

// -------------------------------------------
// clang-tidy
// -------------------------------------------

export function runClangTidy(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	// clang-tidy requires specific files, no practical project-wide mode
	if (scope.mode !== "file" || !scope.targetFile) return [];
	if (!C_EXTENSIONS.test(scope.targetFile)) return [];

	try {
		const result = spawnSync("clang-tidy", [scope.targetFile, "--quiet"], {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (hasErrorCode(result.error, "ENOENT")) {
			return [];
		}
		if (result.status === 0) return [];

		const output = (result.stdout || "") + (result.stderr || "");
		return parseClangTidyOutput(output);
	} catch {
		return [];
	}
}
