import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type * as TS from "typescript";
import { parseTsSource } from "../../harness/checks/cyclomatic-ast.js";
import { withCheckRoot } from "../../harness/checks/check-root.js";
import { withForegroundCheckScan } from "../../harness/checks/check-scan-policy.js";
import { checkUnvalidatedJsonBoundary } from "../../harness/checks/agent-safety-advanced-style.js";
import { detectResourceHandleLeak } from "../../harness/checks/error-context.js";
import { findTopLevelSideEffects } from "../../harness/checks/module-load-side-effects.js";
import { wireArray, wireObject, wireString } from "../value-validation.js";
import type { InventoryOptions } from "../metrics/inventory-paths.js";
import type { FindingCase, FindingSource } from "./finding-evidence.js";
import { digest } from "./store.js";
import { semanticShapeCandidates, type ShapeCandidate } from "./finding-shapes.js";

const planShape = wireObject({ files: wireArray(wireString) });
const detectors = [
	{ family: "parser_result", name: "unvalidated-json", run: checkUnvalidatedJsonBoundary },
	{ family: "resource_ownership", name: "resource-ownership", run: detectResourceHandleLeak },
	{ family: "module_initialization", name: "module-initialization", run: findTopLevelSideEffects },
];

function projectFile(root: string, path: string): boolean {
	const rel = relative(root, path);
	return !!rel && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

function sourcePath(root: string, file: string): string {
	const path = resolve(root, file);
	if (isAbsolute(file) || !projectFile(root, path)) throw new Error("Discovery sources must be confined to the project");
	if (existsSync(path) && !projectFile(root, realpathSync(path))) throw new Error("Discovery symlinks must be confined to the project");
	return path;
}

function evidenceSource(root: string, sf: TS.SourceFile, node: TS.Node, id = "implementation"): FindingSource {
	return { id, file: relative(root, sf.fileName), expectedHash: digest(sf.text), purpose: "complete containing declaration; inspect called helpers before interpreting a candidate", startLine: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, endLine: sf.getLineAndCharacterOfPosition(node.end).line + 1 };
}

/** This is only a candidate recognizer; a failure-shaped return is not an adopted must-use contract. */
function failureShape(checker: TS.TypeChecker, type: TS.Type, at: TS.Node): boolean {
	if (!type.isUnion()) return false;
	for (const key of ["ok", "success", "_tag", "kind", "tag"]) {
		const names = type.types.map(part => {
			const property = part.getProperty(key);
			return property ? checker.typeToString(checker.getTypeOfSymbolAtLocation(property, at)).replaceAll('"', "").toLowerCase() : "";
		});
		if (names.includes("true") && names.includes("false")) return true;
		if (names.some(name => /^(err|error|failure|left)$/.test(name)) && names.some(name => /^(ok|success|right)$/.test(name))) return true;
	}
	return false;
}

/** Local, explicit source-list discovery. Does not run models, edit code or install policy. */
export function discoverFindings(root: string, value: unknown, options: Pick<InventoryOptions, "resourcePolicy"> = {}): { cases: FindingCase[]; notMeasured: string[]; files: number; unresolvedCalls: number } {
	if (!planShape(value) || options.resourcePolicy !== "foreground-survey" && value.files.length > 10_000) throw new Error("Discovery needs an explicit files array of at most 10000 paths in runtime policy");
	root = realpathSync(root);
	const { files, notMeasured } = discoveryFiles(root, value.files, options);
	const parsed = parseTsSource("", "discovery.ts");
	if (!parsed) return { cases: [], notMeasured: [...notMeasured, "TypeScript compiler unavailable"], files: 0, unresolvedCalls: 0 };
	const { ts } = parsed;
	// Project compiler settings supply module resolution. A diagnostic does not become a clean result.
	const configPath = ts.findConfigFile(root, ts.sys.fileExists);
	const config = configPath ? ts.getParsedCommandLineOfConfigFile(configPath, { noEmit: true }, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => notMeasured.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")) }) : undefined;
	for (const error of config?.errors ?? []) notMeasured.push(ts.flattenDiagnosticMessageText(error.messageText, " "));
	const program = ts.createProgram(files, { ...config?.options, strict: true, allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true });
	const cases: FindingCase[] = [];
	let unresolvedCalls = 0;
	for (const file of files) {
		const sf = program.getSourceFile(file);
		if (!sf) { notMeasured.push(`${relative(root, file)}: compiler source unavailable`); continue; }
		for (const diagnostic of program.getSyntacticDiagnostics(sf)) notMeasured.push(`${relative(root, file)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
		const result = options.resourcePolicy === "foreground-survey"
			? withForegroundCheckScan(() => discoverSource(root, program, sf, ts))
			: discoverSource(root, program, sf, ts);
		for (const candidate of result.cases) cases.push(candidate);
		for (const reason of result.notMeasured) notMeasured.push(reason);
		unresolvedCalls += result.unresolvedCalls;
	}
	return { cases, notMeasured, files: files.length, unresolvedCalls };
}

function discoveryFiles(root: string, requested: string[], options: Pick<InventoryOptions, "resourcePolicy">): { files: string[]; notMeasured: string[] } {
	const notMeasured: string[] = [], files: string[] = [];
	for (const file of new Set(requested)) {
		const path = sourcePath(root, file);
		if (!existsSync(path) || options.resourcePolicy !== "foreground-survey" && statSync(path).size > 1_000_000) notMeasured.push(`${file}: unavailable source`);
		else files.push(path);
	}
	return { files, notMeasured };
}

function findingCase(root: string, sf: TS.SourceFile, ts: typeof TS, candidate: ShapeCandidate): FindingCase {
	const { family, name, node, claim, declaration } = candidate;
	let scope = node;
	while (scope.parent && scope.parent !== sf && !ts.isFunctionLike(scope)) scope = scope.parent;
	const sources = [evidenceSource(root, sf, scope)];
	const callee = declaration?.getSourceFile();
	if (declaration && callee && callee !== sf && projectFile(root, callee.fileName)) {
		sources.push(evidenceSource(root, callee, declaration, "callee-contract"));
	}
	return { id: `${name}-${digest({ file: sf.fileName, start: node.getStart(sf), claim }).slice(0, 16)}`, family, origin: "detector", claim, sources, missing: [] };
}

/** Keep source-scoped type resolution and lexical candidates together for provenance. */
function discoverSource(root: string, program: TS.Program, sf: TS.SourceFile, ts: typeof TS) {
	const checker = program.getTypeChecker(), file = sf.fileName, cases: FindingCase[] = [];
	let unresolvedCalls = 0;
	const visit = (node: TS.Node): void => {
		for (const candidate of semanticShapeCandidates(node, checker, ts)) cases.push(findingCase(root, sf, ts, candidate));
		const expression = discardedCall(node, ts);
		if (expression) {
			const result = discardedOutcome(expression, checker, ts);
			if (result === "unresolved") unresolvedCalls++;
			else if (result) cases.push(findingCase(root, sf, ts, result));
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	const scanned = withCheckRoot(root, () => detectors.flatMap(detector => detector.run(sf.text, file).map(match => ({ detector, match }))));
	for (const { detector, match } of scanned.result) {
		const position = sf.getPositionOfLineAndCharacter(match.line - 1, 0);
		const statement = sf.statements.find(node => node.end >= position);
		if (statement) cases.push(findingCase(root, sf, ts, { family: detector.family, name: detector.name, node: statement, claim: `${detector.name} candidate at line ${match.line}: ${match.text}. This is heuristic evidence, not a proven violation.` }));
	}
	return { cases, notMeasured: scanned.notMeasured, unresolvedCalls };
}

function discardedOutcome(expression: TS.CallExpression, checker: TS.TypeChecker, ts: typeof TS): ShapeCandidate | "unresolved" | null {
	const signature = checker.getResolvedSignature(expression), raw = signature && checker.getReturnTypeOfSignature(signature);
	const type = raw && (checker.getAwaitedType(raw) ?? raw);
	if (!type || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return "unresolved";
	if (!failureShape(checker, type, expression)) return null;
	return { family: "error_handling", name: "discarded-outcome", node: expression, claim: `The return value of ${expression.expression.getText()} has failure-shaped type ${checker.typeToString(type)} and is discarded; review whether this loses required failure handling.`, ...(signature?.declaration ? { declaration: signature.declaration } : {}) };
}

function discardedCall(node: TS.Node, ts: typeof TS): TS.CallExpression | null {
	if (!ts.isExpressionStatement(node)) return null;
	let expression = node.expression;
	while (ts.isAwaitExpression(expression) || ts.isVoidExpression(expression) || ts.isParenthesizedExpression(expression)) expression = expression.expression;
	return ts.isCallExpression(expression) ? expression : null;
}
