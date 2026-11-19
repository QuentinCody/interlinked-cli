// ===========================================
// Check Command — can the test layout rule judge this repository?
// ===========================================
// The layout rule finds tests by name and location (`test_*.py`, `*_test.py`, `*.test.*`, `*.spec.*`, test directories). When
// the repository sets its own test-discovery pattern, a file that the runner treats as a test may look like product code to the
// rule. The rule then reports that it cannot judge. Vitest uses the test.include path of its exported configuration.
// Unresolved Vitest settings, or discovery patterns outside the supported test/spec families, retain an unknown result.

import type * as TS from "typescript";
import { hasParseErrors, parseTsSource, type ParsedTsSource } from "../harness/checks/cyclomatic-ast.js";
import { maskComments, matchBracket, scanStrings } from "../lib/metrics/role-tool-config-text.js";

export type DiscoveryLanguage = "python" | "javascript";

const PYTHON_CONFIGS = new Set(["pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"]);
const JS_CONFIG = /^(?:jest\.config\.[cm]?[jt]s|jest\.config\.json|vitest\.config\.[cm]?[jt]s|vitest\.workspace\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s|package\.json)$/;
const NAMES_A_TEST = /test|spec/i;

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** The value text that follows a key match: a bracketed list, a quoted string, or the rest of the line plus indented continuation lines. */
function valueText(text: string, from: number): string {
	const first = text[from];
	if (first === "[") { const close = matchBracket(text, from); return text.slice(from, close === -1 ? from + 1 : close + 1); }
	if (first === '"' || first === "'" || first === "`") { const found = scanStrings(text, from, text.length)[0]; return found === undefined ? "" : text.slice(found.offset, found.end); }
	let end = text.indexOf("\n", from);
	while (end !== -1 && /^[ \t]+\S/.test(text.slice(end + 1, end + 80))) end = text.indexOf("\n", end + 1);
	return text.slice(from, end === -1 ? text.length : end).replace(/\s*\n\s*/g, " ").trim();
}

function patterns(value: string): string[] {
	return value.startsWith("[") || /^["'`]/.test(value) ? scanStrings(value, 0, value.length).map((found) => found.value) : value.split(/[\s,]+/).filter((token) => token !== "");
}

function pythonIssue(file: string, text: string): string | null {
	for (const match of text.matchAll(/^[ \t]*python_files[ \t]*[=:][ \t]*/gm)) {
		const value = valueText(text, match.index + match[0].length);
		if (patterns(value).some((pattern) => !/test/i.test(pattern))) return `${file}: python_files = ${value}`;
	}
	return null;
}

function vitestInclude(parsed: ParsedTsSource, value: TS.Expression): string | null {
	const { ts, sf } = parsed;
	if (ts.isArrayLiteralExpression(value) && value.elements.every(element => ts.isStringLiteralLike(element) && NAMES_A_TEST.test(element.text))) return null;
	return `include = ${value.getText(sf)}`;
}

type VitestScope = "root" | "test";
const CONFIG_KEYS = { root: new Set(["test"]), test: new Set(["include", "projects"]) };
const CONFIG_WRAPPERS = new Set(["defineConfig", "defineWorkspace", "defineProject"]);

function vitestPropertyIssue(parsed: ParsedTsSource, property: TS.ObjectLiteralElementLike, scope: VitestScope): string | null {
	const { ts } = parsed;
	if (ts.isSpreadAssignment(property)) return vitestConfigIssue(parsed, property.expression, scope);
	if (ts.isComputedPropertyName(property.name)) return `computed ${scope} configuration key`;
	const name = property.name.getText(parsed.sf).replace(/^["']|["']$/g, "");
	if (!CONFIG_KEYS[scope].has(name)) return null;
	if (!ts.isPropertyAssignment(property)) return `${name} is not a static property`;
	if (name === "include") return vitestInclude(parsed, property.initializer);
	return vitestConfigIssue(parsed, property.initializer, name === "test" ? "test" : "root");
}

/** Follow config objects only through runner-owned keys. Coverage, Vite plugins
 * and transforms may all use an unrelated property named include. */
function vitestConfigIssue(parsed: ParsedTsSource, value: TS.Expression, scope: VitestScope): string | null {
	const { ts } = parsed;
	const inspect = (expression: TS.Expression) => vitestConfigIssue(parsed, expression, scope);
	if (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) return inspect(value.expression);
	if (ts.isConditionalExpression(value)) return inspect(value.whenTrue) ?? inspect(value.whenFalse);
	if (ts.isArrayLiteralExpression(value) && scope === "root") return value.elements.map(inspect).find(issue => issue !== null) ?? null;
	if (scope === "root" && ts.isCallExpression(value) && CONFIG_WRAPPERS.has(value.expression.getText(parsed.sf))) {
		const [argument, extra] = value.arguments;
		if (argument && !extra) return inspect(argument);
	}
	if (!ts.isObjectLiteralExpression(value)) return `${scope} configuration is not a static object`;
	return value.properties.map(property => vitestPropertyIssue(parsed, property, scope)).find(issue => issue !== null) ?? null;
}

function vitestIssue(file: string, text: string): string | null {
	const parsed = parseTsSource(text, file);
	if (!parsed || hasParseErrors(parsed.sf)) return `${file}: could not parse test configuration`;
	const { ts, sf } = parsed;
	for (const statement of sf.statements) {
		let config: TS.Expression;
		if (ts.isExportAssignment(statement)) config = statement.expression;
		else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && statement.expression.left.getText(sf) === "module.exports") config = statement.expression.right;
		else continue;
		const issue = vitestConfigIssue(parsed, config, "root");
		return issue === null ? null : `${file}: ${issue}`;
	}
	return `${file}: could not resolve exported test configuration`;
}

function jsIssue(file: string, text: string): string | null {
	if (/^vite(?:st)?\./.test(baseName(file))) return vitestIssue(file, text);
	const masked = maskComments(text, "js");
	for (const match of masked.matchAll(/["']?\b(testMatch|testRegex)["']?\s*:\s*/g)) {
		const value = valueText(masked, match.index + match[0].length);
		if (patterns(value).some((pattern) => !NAMES_A_TEST.test(pattern))) return `${file}: ${match[1]} = ${value}`;
	}
	return null;
}

/** Why the rule cannot judge `language` in this repository (the first unsupported discovery setting), or null. */
export function discoveryIssue(language: DiscoveryLanguage, files: readonly string[], read: (path: string) => string | null): string | null {
	const wanted = files.filter((file) => (language === "python" ? PYTHON_CONFIGS.has(baseName(file)) : JS_CONFIG.test(baseName(file))));
	for (const file of wanted) {
		const text = read(file);
		const issue = text === null ? null : language === "python" ? pythonIssue(file, text) : jsIssue(file, text);
		if (issue !== null) return issue;
	}
	return null;
}
