// `child_process_exec_user_input` — split out of js-security-checks.ts
// (500-line cap) by the 2026-10-21 adversarial review that added the
// trusted-program-expression gate. Re-exported from the parent entry so
// every existing importer is unchanged.

import { nonNull } from "../../../lib/non-null.js";
import { getExtension, type InlineMatch, isTestFile, stripCommentsAndStrings } from "../shared.js";
import { stripCommentsPreservingStrings } from "./_shared.js";
import {
	aliasesBoundToRegExp,
	expressionAt,
	isTrustedProgramExpr,
	type SourceView,
	sourceView,
	templateInterpolationsTrusted,
} from "./js-security-checks-trust.js";

/**
 * `child_process_exec_user_input` — Node's `child_process.exec(userInput)`
 * family with a non-literal first argument. Command-injection vector.
 * pre_block / error.
 *
 * Complements `ubs_subprocess_shell_true` (Python-only) and
 * `ubs_eval_input_tainted` (which catches bare `exec(x)` after destructuring
 * but skips namespaced forms because of the negative-lookbehind on `.`).
 *
 * Detects the namespaced shapes:
 *   child_process.exec(userInput)
 *   cp.execSync(req.body)
 *   childProcess.spawn(input, args, { shell: true })   (when first arg is a var)
 *
 * The `(?!["'\`])` excludes string literals — a hardcoded command string is
 * not the user-input form. Skips test files because fixtures stress this.
 *
 * 2026-10-21 adversarial review (pre_block ⇒ ~zero FP): a first argument the
 * PROCESS controls is not user input — `process.execPath` / `__dirname` /
 * operator env, a same-file `const` string (or literal ternary, or
 * `require.resolve(...)`), and a template whose every interpolation is one
 * of those. A `cp` / `childProcess` the file binds to a RegExp is a compiled
 * pattern, not a shell-out.
 */
export function checkChildProcessExecUserInput(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const isJs = ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs";
	const isTs = ext === ".ts" || ext === ".tsx";
	if (!isJs && !isTs) return [];
	if (isTestFile(filePath)) return [];

	const view = sourceView(stripCommentsPreservingStrings(content));
	const scan: ChildProcessScan = {
		stripped: stripCommentsAndStrings(content),
		view,
		regexAliases: aliasesBoundToRegExp(view),
		originalLines: content.split("\n"),
		matches: [],
		matchedLines: new Set<number>(),
	};
	collectIdentifierArgCalls(scan);
	collectTemplateArgCalls(scan);
	return scan.matches;
}

interface ChildProcessScan {
	stripped: string;
	view: SourceView;
	regexAliases: Set<string>;
	originalLines: string[];
	matches: InlineMatch[];
	matchedLines: Set<number>;
}

const CP_CALL_HEAD = String.raw`\b(child_process|childProcess|cp)\.(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(\s*`;
// `(child_process|cp|childProcess).<fn>(<identifier>` — must be namespaced
// AND first arg must be an identifier (not a string literal). The
// `(?!["'\`])` after the open-paren excludes literal-only invocations.
const CP_IDENT_ARG_RE = new RegExp(`${CP_CALL_HEAD}(?!["'\`])([A-Za-z_$]\\w*)`, "g");
const CP_TEMPLATE_ARG_RE = new RegExp(
	`${CP_CALL_HEAD}(\`(?:\\\\[\\s\\S]|[^\`\\\\])*?\\$\\{(?:\\\\[\\s\\S]|[^\`\\\\])*?\`)`,
	"g",
);

function pushChildProcessMatch(scan: ChildProcessScan, lineNum: number): void {
	scan.matchedLines.add(lineNum);
	scan.matches.push({
		line: lineNum,
		text: nonNull(scan.originalLines[lineNum - 1]).trim().slice(0, 150),
	});
}

/** Identifier-first-argument calls, per line, minus trusted program expressions. */
function collectIdentifierArgCalls(scan: ChildProcessScan): void {
	const strippedLines = scan.stripped.split("\n");
	const codeLines = scan.view.code.split("\n");
	const blankedLines = scan.view.blanked.split("\n");
	for (let i = 0; i < strippedLines.length; i++) {
		if (scan.matches.length >= 10) break;
		CP_IDENT_ARG_RE.lastIndex = 0;
		const m = CP_IDENT_ARG_RE.exec(nonNull(strippedLines[i]));
		if (!m) continue;
		if (scan.regexAliases.has(m[1] ?? "")) continue;
		if (firstArgTrusted(nonNull(codeLines[i]), nonNull(blankedLines[i]), scan.view)) continue;
		pushChildProcessMatch(scan, i + 1);
	}
}

/** The call's first argument on this line, read with strings intact, is process-controlled. */
function firstArgTrusted(codeLine: string, blankedLine: string, view: SourceView): boolean {
	CP_IDENT_ARG_RE.lastIndex = 0;
	const m = CP_IDENT_ARG_RE.exec(blankedLine);
	if (!m) return false; // the two strippers disagree: keep the conservative fire
	const argStart = m.index + m[0].length - nonNull(m[2]).length;
	return isTrustedProgramExpr(expressionAt({ code: codeLine, blanked: blankedLine }, argStart), view);
}

/** Interpolated-template-first-argument calls, minus templates built only from trusted expressions. */
function collectTemplateArgCalls(scan: ChildProcessScan): void {
	for (const m of scan.view.code.matchAll(CP_TEMPLATE_ARG_RE)) {
		if (scan.matches.length >= 10) break;
		if (scan.regexAliases.has(m[1] ?? "")) continue;
		if (templateInterpolationsTrusted(m[2] ?? "", scan.view)) continue;
		const lineNum = scan.view.code.slice(0, m.index).split("\n").length;
		if (scan.matchedLines.has(lineNum)) continue;
		pushChildProcessMatch(scan, lineNum);
	}
}
