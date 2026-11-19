// CLASS: Optional inputs whose position is omitted by every visible direct call.
// FIRES WHEN: a top-level private ES module function has direct calls and all omit the slot.
// DOES NOT FIRE: exports, overloads, callbacks, spread calls, ambiguous names or scripts.
// CALIBRATION: advisory evidence only; no cross-project precision threshold has been established.
// KNOWN GAPS: methods, arrows, explicit undefined and callers outside ordinary module semantics.
// HOW TO EXTEND: add binding evidence and negative controls before widening the supported shapes.
import type * as TS from "typescript";
import { reportNotMeasured } from "./check-root.js";
import { checkMatchLimit } from "./check-scan-policy.js";
import { hasParseErrors, parseTsSource, type ParsedTsSource, type TsModule } from "./cyclomatic-ast.js";
import { getExtension, isTestSourcePath, JS_TS_EXTS, type InlineMatch } from "./shared.js";

interface Candidate {
	fn: TS.FunctionDeclaration;
	calls: number;
	maxArgs: number;
}

function privateFunctions({ ts, sf }: ParsedTsSource): Map<string, Candidate> {
	const candidates = new Map<string, Candidate>();
	for (const fn of sf.statements) {
		if (!ts.isFunctionDeclaration(fn) || !fn.body || !fn.name) continue;
		if (fn.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) continue;
		if (fn.parameters.some(p => p.questionToken || p.initializer)) {
			candidates.set(fn.name.text, { fn, calls: 0, maxArgs: 0 });
		}
	}
	return candidates;
}

function recordReference(ts: TsModule, node: TS.Identifier, candidates: Map<string, Candidate>): void {
	const entry = candidates.get(node.text);
	if (!entry || node === entry.fn.name) return;
	const parent = node.parent;
	if (!ts.isCallExpression(parent) || parent.expression !== node || parent.arguments.some(ts.isSpreadElement)) {
		candidates.delete(node.text);
		return;
	}
	entry.calls++;
	entry.maxArgs = Math.max(entry.maxArgs, parent.arguments.length);
}

// A name collision or non-call use removes the candidate. This trades recall for
// a single syntax walk without loading the consumer's type checker or import graph.
function collectCalls({ ts, sf }: ParsedTsSource, candidates: Map<string, Candidate>): void {
	const visit = (node: TS.Node): void => {
		if (!candidates.size) return;
		if (ts.isIdentifier(node)) {
			if (node.text === "eval") { candidates.clear(); return; }
			recordReference(ts, node, candidates);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
}

function omittedInputs(parsed: ParsedTsSource, candidates: Map<string, Candidate>): InlineMatch[] {
	const { ts, sf } = parsed;
	const matches: InlineMatch[] = [];
	const limit = checkMatchLimit(10);
	for (const [name, { fn, calls, maxArgs }] of candidates) {
		if (!calls) continue;
		const params = fn.parameters.filter(p => !(ts.isIdentifier(p.name) && p.name.text === "this"));
		for (const p of params.slice(maxArgs)) {
			if (!(p.questionToken || p.initializer) || !ts.isIdentifier(p.name)) continue;
			const line = sf.getLineAndCharacterOfPosition(p.name.getStart(sf)).line + 1;
			matches.push({ line, text: `${name}: optional parameter ${p.name.text} omitted at ${calls} direct call${calls === 1 ? "" : "s"}. Review whether the helper needs this input.` });
			if (matches.length >= limit) return matches;
		}
	}
	return matches;
}

export function detectOmittedPrivateParameter(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_EXTS.has(ext) || isTestSourcePath(filePath) || !content.includes("function")) return [];
	if (!content.includes("?") && !content.includes("=")) return [];
	const parsed = parseTsSource(content, filePath);
	if (!parsed || hasParseErrors(parsed.sf)) {
		reportNotMeasured("omitted_private_parameter", "Valid JS/TS syntax and the TypeScript parser are required");
		return [];
	}
	const { ts, sf } = parsed;
	if (sf.isDeclarationFile || !(ts.isExternalModule(sf) || ext === ".mjs" || ext === ".mts")) return [];
	const candidates = privateFunctions(parsed);
	collectCalls(parsed, candidates);
	return omittedInputs(parsed, candidates);
}
