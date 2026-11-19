import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import type * as TS from "typescript";
import { checkRoot } from "./check-root.js";
import { isForegroundCheckScan } from "./check-scan-policy.js";
import { loadCheckTypescript } from "./check-typescript.js";
import { hasParseErrors, parseTsSourceWith } from "./cyclomatic-ast.js";
import { getProjectCheckEvidence, type ProjectCheckEvidence } from "./project-check-evidence.js";
import { proposedFileContent, proposedFileExists } from "./proposed-files.js";
import { JS_TS_EXTS } from "./shared.js";

export interface BarrelGap { file: string; reason: string; }
export interface ValueModuleImport { specifier: string; line: number; source: string; }
export interface BarrelReach {
	state: "reaches" | "unreachable" | "unknown";
	/** Actual resolved value-edge path, including the importing module. */
	witness: string[];
	gaps: BarrelGap[];
}
interface Edges { specifiers: string[]; gaps: string[]; }
interface Context {
	ts: typeof TS;
	root: string;
	evidence: ProjectCheckEvidence | undefined;
	selected: ReadonlySet<string>;
	edges: Map<string, Edges>;
	options: Map<string, { value: TS.CompilerOptions; gaps: BarrelGap[] }>;
}
const contexts = new WeakMap<ProjectCheckEvidence, Context>();
const RUNTIME_MODULES = 64;

function inside(root: string, path: string): boolean {
	return path === root || path.startsWith(`${root}${sep}`);
}

function contextFor(file: string): Context | null {
	const evidence = getProjectCheckEvidence();
	const cached = evidence && contexts.get(evidence);
	if (cached) return cached;
	const ts = loadCheckTypescript("import_from_own_barrel", "barrel value-edge reachability");
	if (!ts) return null;
	const activeRoot = resolve(checkRoot());
	const root = evidence?.root ?? (inside(activeRoot, file) ? activeRoot : dirname(file));
	const context: Context = { ts, root, evidence, selected: new Set(evidence?.listFiles().map(path => resolve(root, path))), edges: new Map(), options: new Map() };
	if (evidence) contexts.set(evidence, context);
	return context;
}

function fileExists(context: Context, file: string, importer: string): boolean {
	if (file === importer) return true;
	return proposedFileExists(file) ?? (context.selected.has(file) || existsSync(file));
}

function sourceText(context: Context, file: string): string {
	const proposed = proposedFileContent(file);
	if (proposed === null) throw new Error("Module is deleted in the proposed filesystem");
	if (proposed !== undefined) return proposed;
	if (existsSync(file) && !inside(realpathSync(context.root), realpathSync(file))) throw new Error("Module resolves outside the selected project root");
	return context.evidence ? context.evidence.readFile(file) : readFileSync(file, "utf8");
}

function typeOnly(ts: typeof TS, node: TS.ImportDeclaration | TS.ExportDeclaration): boolean {
	if (ts.isExportDeclaration(node)) {
		return node.isTypeOnly || !!node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every(element => element.isTypeOnly);
	}
	const clause = node.importClause;
	if (!clause) return false;
	if (clause.isTypeOnly) return true;
	const bindings = clause.namedBindings;
	return !clause.name && !!bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly);
}

function staticSpecifier(ts: typeof TS, node: TS.Node): string | null {
	if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
		return !typeOnly(ts, node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
	}
	if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
		const expression = node.moduleReference.expression;
		return expression && ts.isStringLiteralLike(expression) ? expression.text : null;
	}
	return null;
}

/** Parse consumer endpoints from declarations, preserving exact starting positions. */
export function ownBarrelConsumerImports(content: string, file: string): { imports: ValueModuleImport[]; gaps: string[] } {
	const ts = loadCheckTypescript("import_from_own_barrel", "actual consumer value imports");
	if (!ts) return { imports: [], gaps: ["Optional TypeScript parser unavailable"] };
	const source = parseTsSourceWith(ts, content, file);
	if (hasParseErrors(source)) return { imports: [], gaps: ["Consumer module syntax could not be parsed completely"] };
	const imports: ValueModuleImport[] = [], lines = content.split("\n");
	for (const statement of source.statements) {
		const specifier = staticSpecifier(ts, statement);
		if (specifier === null) continue;
		const position = source.getLineAndCharacterOfPosition(statement.getStart(source));
		const declaration = statement.getText(source);
		imports.push({ specifier, line: position.line + 1, source: declaration.includes("\n") ? declaration.replace(/\s+/g, " ") : lines[position.line] ?? declaration });
	}
	return { imports, gaps: [] };
}

function unsupportedLoading(ts: typeof TS, node: TS.Node): boolean {
	if (!ts.isCallExpression(node)) return false;
	return node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require";
}

function moduleEdges(context: Context, file: string): Edges {
	const cached = context.edges.get(file);
	if (cached) return cached;
	const { ts } = context;
	const source = parseTsSourceWith(ts, sourceText(context, file), file);
	const result: Edges = { specifiers: [], gaps: [] };
	if (hasParseErrors(source)) return { specifiers: [], gaps: ["Module syntax could not be parsed completely"] };
	const visit = (node: TS.Node): void => {
		const specifier = staticSpecifier(ts, node);
		if (specifier !== null) result.specifiers.push(specifier);
		if (unsupportedLoading(ts, node)) result.gaps.push("Dynamic import or require call needs binding and execution evidence beyond the static value-edge graph");
		ts.forEachChild(node, visit);
	};
	visit(source);
	context.edges.set(file, result);
	return result;
}

function metadataText(context: Context, file: string): string | undefined {
	const proposed = proposedFileContent(file);
	return proposed === null ? undefined : proposed ?? context.ts.sys.readFile(file);
}

function compilerOptions(context: Context, directory: string): { value: TS.CompilerOptions; gaps: BarrelGap[] } {
	const cached = context.options.get(directory);
	if (cached) return cached;
	const { ts } = context;
	const value: TS.CompilerOptions = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowJs: true };
	const result = { value, gaps: [] as BarrelGap[] };
	let current = directory;
	let config: string | undefined;
	while (inside(context.root, current)) {
		const candidate = join(current, "tsconfig.json");
		if (proposedFileExists(candidate) ?? existsSync(candidate)) { config = candidate; break; }
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	if (config) {
		const host: TS.ParseConfigFileHost = { ...ts.sys, readDirectory: () => [], getCurrentDirectory: () => context.root,
			readFile: file => metadataText(context, file),
			onUnRecoverableConfigFileDiagnostic: diagnostic => result.gaps.push({ file: config, reason: ts.flattenDiagnosticMessageText(diagnostic.messageText, " ") }) };
		const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, host);
		if (parsed) {
			Object.assign(value, parsed.options);
			for (const diagnostic of parsed.errors) {
				if (diagnostic.code !== 18003) result.gaps.push({ file: config, reason: ts.flattenDiagnosticMessageText(diagnostic.messageText, " ") });
			}
		}
	}
	context.options.set(directory, result);
	return result;
}

function resolveEdge(context: Context, from: string, specifier: string, importer: string, gaps: BarrelGap[]): string | null {
	if (specifier.startsWith("node:")) return null;
	const config = compilerOptions(context, dirname(from));
	for (const gap of config.gaps) gaps.push(gap);
	if (config.gaps.length) return null;
	const host: TS.ModuleResolutionHost = { fileExists: file => fileExists(context, resolve(file), importer),
		readFile: file => metadataText(context, file), directoryExists: context.ts.sys.directoryExists,
		...(context.ts.sys.realpath ? { realpath: context.ts.sys.realpath } : {}), getCurrentDirectory: () => context.root };
	const target = context.ts.resolveModuleName(specifier, from, config.value, host).resolvedModule?.resolvedFileName;
	if (target) return resolve(target);
	gaps.push({ file: from, reason: `Module target "${specifier}" could not be resolved from the selected configuration` });
	return null;
}

function witnessPath(predecessors: ReadonlyMap<string, string | null>, from: string, importer: string): string[] {
	const path = [importer];
	let current: string | null = from;
	while (current !== null) { path.push(current); current = predecessors.get(current) ?? null; }
	return path.reverse();
}

function followEdges(context: Context, from: string, importer: string, edges: Edges, predecessors: Map<string, string | null>, queue: string[], result: BarrelReach): void {
	const scope = dirname(importer);
	for (const reason of edges.gaps) result.gaps.push({ file: from, reason });
	for (const specifier of edges.specifiers) {
		if (specifier.startsWith(".") && !inside(scope, resolve(dirname(from), specifier))) continue;
		let target: string | null;
		try { target = resolveEdge(context, from, specifier, importer, result.gaps); }
		catch (error) { result.gaps.push({ file: from, reason: error instanceof Error ? error.message : String(error) }); continue; }
		if (!target || !inside(scope, target) || !JS_TS_EXTS.has(extname(target))) continue;
		if (/\.d\.(?:ts|mts|cts)$/.test(target)) { result.gaps.push({ file: target, reason: "Declaration-only resolution does not establish a value dependency on executable source" }); continue; }
		if (target === importer) { result.state = "reaches"; result.witness = witnessPath(predecessors, from, importer); continue; }
		if (!predecessors.has(target)) { predecessors.set(target, from); queue.push(target); }
	}
}

function startingModule(context: Context, importer: string, specifier: string, result: BarrelReach): string | null {
	let target: string | null;
	try { target = resolveEdge(context, importer, specifier, importer, result.gaps); }
	catch (error) { result.gaps.push({ file: importer, reason: error instanceof Error ? error.message : String(error) }); return null; }
	if (!target) return null;
	if (!inside(dirname(importer), target) || /\.d\.(?:ts|mts|cts)$/.test(target)) {
		result.gaps.push({ file: target, reason: "Forward index target does not identify executable source inside the scoped directory" });
		return null;
	}
	return target;
}

/** Traverse only the sibling index's scoped value dependencies, retaining incomplete evidence. */
export function inspectOwnBarrelReach(filePath: string, consumerSpecifier = "./index"): BarrelReach {
	const importer = resolve(getProjectCheckEvidence()?.root ?? checkRoot(), filePath);
	const context = contextFor(importer);
	if (!context) return { state: "unknown", witness: [], gaps: [{ file: importer, reason: "Optional TypeScript parser unavailable" }] };
	const result: BarrelReach = { state: "unreachable", witness: [], gaps: [] };
	const start = startingModule(context, importer, consumerSpecifier, result);
	if (!start) return { ...result, state: "unknown" };
	if (start === importer) return { ...result, state: "reaches", witness: [importer] };
	const queue = [start], predecessors = new Map<string, string | null>([[start, null]]);
	const limit = isForegroundCheckScan() ? Number.POSITIVE_INFINITY : RUNTIME_MODULES;
	for (let index = 0; index < queue.length; index++) {
		const file = queue[index];
		if (!file) continue;
		if (index >= limit) { result.gaps.push({ file, reason: "Runtime barrel traversal exhausted its 64-module budget" }); break; }
		let edges: Edges;
		try { edges = moduleEdges(context, file); }
		catch (error) { result.gaps.push({ file, reason: error instanceof Error ? error.message : String(error) }); continue; }
		followEdges(context, file, importer, edges, predecessors, queue, result);
	}
	if (result.state !== "reaches" && result.gaps.length) result.state = "unknown";
	return result;
}
