// ===========================================
// Undefined Environment Variable Detection
// ===========================================
// Flags process.env.FOO references whose keys are not declared in the
// project's .env.example / .env.sample / .env.template file.

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type * as TS from "typescript";
import { nonNull } from "../../lib/non-null.js";
import { parseTsSource, type TsModule } from "../checks/cyclomatic-ast.js";
import type { HarnessEvent, StructuralCheckResult } from "../types.js";
import { readEnvExampleFromDir } from "./env-loader.js";

function isWriteOnly(ts: TsModule, node: TS.Node): boolean {
	while (ts.isParenthesizedExpression(node.parent) || ts.isNonNullExpression(node.parent)) {
		node = node.parent;
	}
	const parent = node.parent;
	return ts.isDeleteExpression(parent) ||
		(ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken);
}

function readEnvKey(ts: TsModule, node: TS.Node): string | undefined {
	if (!ts.isPropertyAccessExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
	const owner = node.expression;
	if (owner.name.text !== "env" || !ts.isIdentifier(owner.expression) || owner.expression.text !== "process") return;
	return /^[A-Z_][A-Z0-9_]*$/.test(node.name.text) && !isWriteOnly(ts, node) ? node.name.text : undefined;
}

/** Direct reads of Node's process.env.KEY in the selected source range. */
function collectEnvVarRefs(text: string, filePath: string, start = 0, end = text.length): Set<string> {
	const vars = new Set<string>();
	if (!text.includes("process")) return vars;
	const parsed = parseTsSource(text, filePath);
	if (!parsed) {
		// Minimal installations without the optional compiler retain the lexical scan.
		for (const match of text.slice(start, end).matchAll(/\bprocess\.env\.([A-Z_][A-Z0-9_]*)\b/g)) vars.add(nonNull(match[1]));
		return vars;
	}
	const { ts, sf } = parsed;
	function visit(node: TS.Node): void {
		const key = readEnvKey(ts, node);
		if (key && node.getStart(sf) >= start && node.end <= end) vars.add(key);
		ts.forEachChild(node, visit);
	}
	visit(sf);
	return vars;
}

/**
 * A unique edit range keeps its surrounding JS syntax. If its position is
 * ambiguous or the snapshot has changed, intersect the edit's and file's reads.
 */
function envReadsForEdit(content: string, filePath: string, event: HarnessEvent | undefined): Set<string> {
	const editContent =
		(typeof event?.tool_input?.new_string === "string" && event.tool_input.new_string) ||
		(typeof event?.tool_input?.content === "string" && event.tool_input.content);
	if (!editContent) return collectEnvVarRefs(content, filePath);
	if (!editContent.includes("process")) return new Set();
	const at = content.indexOf(editContent);
	if (at >= 0 && at === content.lastIndexOf(editContent)) {
		return collectEnvVarRefs(content, filePath, at, at + editContent.length);
	}
	const editVars = collectEnvVarRefs(editContent, filePath);
	return new Set([...collectEnvVarRefs(content, filePath)].filter((key) => editVars.has(key)));
}

/**
 * Find the nearest .env.example (or .env.sample/.env.template) walking up
 * from `startDir`, bounded to 10 hops.
 */
function findEnvExampleVars(startDir: string): Set<string> | null {
	let dir = startDir;
	for (let i = 0; i < 10; i++) {
		const found = readEnvExampleFromDir(dir);
		if (found) return found;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

/**
 * Public API — consumed by structural-checks.runStructuralChecks.
 *
 * Detect process.env.FOO references whose key isn't in .env.example.
 * Diff-aware: when an event.tool_input.new_string is present, only report
 * keys that appear in the new slice, not keys that already existed.
 */
export function checkUndefinedEnvVars(
	filePath: string,
	relPath: string,
	event?: HarnessEvent,
): StructuralCheckResult[] {
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return [];
	}

	const usedVars = envReadsForEdit(content, filePath, event);
	if (usedVars.size === 0) return [];

	const envExampleVars = findEnvExampleVars(dirname(filePath));
	if (!envExampleVars) return []; // No .env.example found

	// Common standard env vars to skip
	const standardVars = new Set([
		"NODE_ENV",
		"PATH",
		"HOME",
		"USER",
		"SHELL",
		"TERM",
		"CI",
		"PORT",
		"HOST",
		"HOSTNAME",
		"TZ",
		"LANG",
		"LC_ALL",
		"PWD",
		"DEBUG",
		"VERBOSE",
		"LOG_LEVEL",
	]);

	const declared = envExampleVars;
	const undefinedVars = [...usedVars].filter((v) => !declared.has(v) && !standardVars.has(v));

	if (undefinedVars.length === 0) return [];

	return [
		{
			check: "undefined_env_vars",
			severity: "info",
			message: `${relPath} references ${undefinedVars.length} env var(s) not in .env.example: ${undefinedVars.slice(0, 5).join(", ")}${undefinedVars.length > 5 ? ` +${undefinedVars.length - 5} more` : ""}. Add them to .env.example for documentation.`,
			file: filePath,
		},
	];
}
