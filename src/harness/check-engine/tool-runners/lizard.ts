// ===========================================
// Tool Runners — lizard (polyglot cyclomatic complexity)
// ===========================================
//
// `lizard` is a single dependency-free CLI that computes cyclomatic
// complexity (CCN) across ~10 languages (C/C++, Java, Go, Rust, Swift,
// JavaScript, Python, Ruby, …). We wire it in as a PostToolUse advisory
// check for the languages that lack a dedicated complexity gate — Go, Rust,
// C/C++, Swift, Java. TS/JS keep the AST cyclomatic gate
// (`checks/cyclomatic-ast.ts`) and Python keeps `radon`, so lizard is NOT
// registered for those extensions (it would double-report).
//
// The CCN threshold tracks the repo's CONFIGURED cap (`maxCyclomaticFor` —
// `.interlinked/metric-caps.json` via `interlinked caps set cyclomatic <n>`,
// falling back to `DEFAULT_MAX_CYCLOMATIC`) so the complexity bar is the same
// number in every language AND matches the rest of the harness. Length and
// argument thresholds are pushed out of range so only CCN triggers a
// warning. Like every tool-runner this degrades to `[]` when `lizard` is not
// installed (ENOENT) — never an error.

import { spawnSync } from "node:child_process";
import { hasErrorCode } from "../tool-errors.js";
import { nonNull } from "../../../lib/non-null.js";
import { maxCyclomaticFor } from "../../metric-caps.js";
import { filterResultsToFile } from "../output-parsers.js";
import { runProcessAsync } from "../spawn-async.js";
import type { CheckResult, ToolRunnerInput } from "../types.js";

/**
 * Parse `lizard --warnings_only` output. Each warning line names a function
 * that exceeded a threshold. We tolerate metric-order differences across
 * lizard versions: file/line/function are pulled from the front and the CCN
 * from wherever `<n> CCN` appears in the rest of the line. The runner pushes
 * length/argument thresholds out of range, so every warning is a
 * cyclomatic-complexity violation.
 *
 *   src/main.go:42: warning: handleRequest has 31 CCN and 4 params (88 NLOC, 410 token)
 */
export function parseLizardOutput(output: string): CheckResult[] {
	const results: CheckResult[] = [];
	for (const raw of output.split("\n")) {
		const m = raw.match(/^(.+?):(\d+):\s*warning:\s*(.+?)\s+has\b.*?\b(\d+)\s*CCN\b/i);
		if (!m) continue;
		const fn = nonNull(m[3]).trim();
		results.push({
			tool: "lizard",
			severity: "warning",
			file: nonNull(m[1]),
			line: Number.parseInt(nonNull(m[2]), 10),
			message: `Function \`${fn}\` has cyclomatic complexity ${m[4]} — consider decomposing it.`,
			ruleId: "lizard/cyclomatic",
		});
	}
	return results;
}

/** Build lizard's argv. `--warnings_only` prints one line per over-threshold
 *  function; `-L`/`-a` are set out of range so only CCN (`-C`) fires. */
function lizardArgs(input: ToolRunnerInput): string[] {
	const { scope } = input;
	const target = scope.mode === "file" && scope.targetFile ? scope.targetFile : ".";
	// Honor the repo's configured cyclomatic cap (.interlinked/metric-caps.json,
	// via `interlinked caps set cyclomatic <n>`) so lizard uses the SAME bar as the
	// TS AST gate + radon, not a hardcoded 25 (finding 2026-06). maxCyclomaticFor
	// falls back to the shipped DEFAULT_MAX_CYCLOMATIC when no override is set.
	const ccn = String(maxCyclomaticFor(scope.projectRoot));
	return ["--warnings_only", "-C", ccn, "-L", "100000", "-a", "1000", target];
}

/** Filter project-wide output down to the edited file in file mode. */
function scoped(results: CheckResult[], input: ToolRunnerInput): CheckResult[] {
	const { scope } = input;
	if (scope.mode === "file" && scope.targetFile && scope.filterToFile) {
		return filterResultsToFile(results, scope.targetFile);
	}
	return results;
}

export function runLizard(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;
	try {
		const result = spawnSync("lizard", lizardArgs(input), {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (hasErrorCode(result.error, "ENOENT")) {
			return [];
		}
		return scoped(parseLizardOutput(result.stdout || ""), input);
	} catch {
		return [];
	}
}

export async function runLizardAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope, timeoutMs } = input;
	const result = await runProcessAsync("lizard", lizardArgs(input), {
		cwd: scope.projectRoot,
		timeout: timeoutMs,
	});
	return scoped(parseLizardOutput(result.stdout || ""), input);
}
