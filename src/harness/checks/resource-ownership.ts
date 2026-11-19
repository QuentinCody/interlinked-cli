// Advisory ownership evidence: recognize visible release wrappers and acquisition gaps.
// A discovered close call is not proof of all-path cleanup; aliases and async ownership need review.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type * as TS from "typescript";
import { checkRoot, reportNotMeasured } from "./check-root.js";
import { parseTsSource, type ParsedTsSource } from "./cyclomatic-ast.js";
import type { InlineMatch } from "./shared.js";

function localReleases(parsed: ParsedTsSource): Set<string> {
	const { ts, sf } = parsed;
	const names = new Set<string>();
	for (const statement of sf.statements) {
		if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
		const parameter = statement.parameters[0]?.name;
		if (!parameter || !ts.isIdentifier(parameter)) continue;
		const name = statement.name.text;
		const visit = (node: TS.Node): void => {
			if (ts.isFunctionLike(node)) return;
			if (ts.isCallExpression(node) && /^(?:fs\.)?close(?:Sync)?$/.test(node.expression.getText(sf))
				&& node.arguments[0]?.getText(sf) === parameter.text) names.add(name);
			ts.forEachChild(node, visit);
		};
		visit(statement.body);
	}
	return names;
}

function importedReleases(parsed: ParsedTsSource, filePath: string, names: Set<string>): void {
	const { ts, sf } = parsed;
	for (const statement of sf.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const specifier = statement.moduleSpecifier.text;
		const bindings = statement.importClause?.namedBindings;
		if (!specifier.startsWith(".") || !bindings || !ts.isNamedImports(bindings)) continue;
		const source = readReleaseModule(resolve(checkRoot(), dirname(filePath), specifier));
		if (!source) continue;
		const releases = localReleases(source);
		for (const binding of bindings.elements) if (releases.has((binding.propertyName ?? binding.name).text)) names.add(binding.name.text);
	}
}

/** Bound cross-file reads and reject escapes; missing evidence keeps the original candidate. */
function readReleaseModule(base: string): ParsedTsSource | null {
	try {
		const target = [base.replace(/\.js$/, ".ts"), base].find(path => existsSync(path));
		if (!target) return null;
		const rel = relative(realpathSync(checkRoot()), realpathSync(target));
		if (isAbsolute(rel) || rel.startsWith("..") || statSync(target).size > 64_000) return null;
		return parseTsSource(readFileSync(target, "utf8"), target);
	} catch { return null; }
}

/** Names are taken from visible function bodies, never inferred from a cleanup-like spelling alone. */
export function resourceReleaseHelpers(content: string, filePath: string): string[] {
	const parsed = parseTsSource(content, filePath);
	if (!parsed) {
		reportNotMeasured("resource_handle_leak", "cleanup-helper and acquisition-gap AST evidence unavailable; lexical scan only");
		return [];
	}
	const names = localReleases(parsed);
	importedReleases(parsed, filePath, names);
	return [...names];
}

/** Detect a call between acquiring a descriptor and entering its subsequent finally protection. */
export function resourceAcquisitionGaps(content: string, filePath: string, releases: readonly string[]): InlineMatch[] {
	const parsed = parseTsSource(content, filePath);
	if (!parsed) return [];
	const { ts, sf } = parsed;
	const matches: InlineMatch[] = [];
	const closes = (node: TS.Node, name: string): boolean => {
		let found = false;
		const visit = (child: TS.Node): void => {
			if (ts.isFunctionLike(child)) return;
			if (ts.isCallExpression(child) && child.arguments[0]?.getText(sf) === name
				&& (/^(?:fs\.)?close(?:Sync)?$/.test(child.expression.getText(sf)) || releases.includes(child.expression.getText(sf)))) found = true;
			ts.forEachChild(child, visit);
		};
		visit(node);
		return found;
	};
	const hasCall = (node: TS.Node): boolean => {
		if (ts.isFunctionLike(node)) return false;
		return ts.isCallExpression(node) || ts.isNewExpression(node) || !!ts.forEachChild(node, hasCall);
	};
	const visit = (node: TS.Node): void => {
		ts.forEachChild(node, visit);
		if (!ts.isVariableStatement(node) || (!ts.isBlock(node.parent) && !ts.isSourceFile(node.parent))) return;
			const siblings = node.parent.statements;
			for (const declaration of node.declarationList.declarations) {
				if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isCallExpression(declaration.initializer)
					|| !/^(?:fs\.)?openSync$/.test(declaration.initializer.expression.getText(sf))) continue;
				const later = siblings.slice(siblings.indexOf(node) + 1);
				const protection = later.findIndex(statement => ts.isTryStatement(statement) && !!statement.finallyBlock && closes(statement.finallyBlock, declaration.name.getText(sf)));
				if (protection > 0 && later.slice(0, protection).some(hasCall)) {
					matches.push({ line: sf.getLineAndCharacterOfPosition(declaration.getStart(sf)).line + 1,
						text: `resource_handle_leak: ${declaration.name.text} has a potentially throwing call before its cleanup region; protect each acquisition immediately` });
				}
			}
	};
	visit(sf);
	return matches;
}
