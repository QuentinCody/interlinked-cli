import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type * as TS from "typescript";
import type { InlineMatch } from "../check-registry/types.js";
import { resolveImportPath } from "../project-graph.js";
import { reportNotMeasured } from "./check-root.js";
import { getNumericZeroDefaultEvidence } from "./numeric-zero-default-evidence.js";
import { NUMERIC_ZERO_CHECK, numericBinding, numericMatches, numericModel, numericWrapper, type NumericModel, type NumericOrigin } from "./numeric-zero-default-model.js";
import { getProjectCheckEvidence, type ProjectCheckEvidence } from "./project-check-evidence.js";
import { proposedFileContent } from "./proposed-files.js";

interface CachedModule { content: string; model: NumericModel | undefined; }
interface NumericCache { models: Map<string, CachedModule>; imports: Map<string, string>; }
const caches = new WeakMap<ProjectCheckEvidence, NumericCache>();
export interface NumericProjectView {
	root: string;
	target: string;
	fullScan: boolean;
	models: Map<string, CachedModule>;
	imports: Map<string, string>;
	read: (file: string) => string;
	importers: () => readonly string[];
	gap: (file: string, reason: string) => void;
}
const OTHER: NumericOrigin = { state: "other" };

function inside(root: string, file: string): boolean {
	const path = relative(root, file);
	return path !== ".." && !path.startsWith("../") && !isAbsolute(path);
}

function checkModulePath(root: string, path: string): void {
	if (!inside(root, path)) throw new Error("Module lies outside selected project root");
	const canonical = existsSync(path) ? realpathSync(path) : resolve(realpathSync(dirname(path)), relative(dirname(path), path));
	if (!inside(realpathSync(root), canonical)) throw new Error("Module resolves outside selected project root");
}

/** Uses selected invocation snapshots or query-selected hook dependencies only. */
export function numericProjectView(content: string, file: string): NumericProjectView | undefined {
	const project = getProjectCheckEvidence(), supplied = getNumericZeroDefaultEvidence();
	if (!project && !supplied) return undefined;
	const root = project?.root ?? resolve(supplied!.root), target = resolve(root, file);
	if (!inside(root, target)) return undefined;
	const gap = (path: string, reason: string): void => {
		if (project) project.reportUnavailable(NUMERIC_ZERO_CHECK, path, reason);
		else if (supplied?.onUnavailable) supplied.onUnavailable({ file: path, reason });
		else reportNotMeasured(NUMERIC_ZERO_CHECK, `${path}: ${reason}`);
	};
	const cache = project ? caches.get(project) ?? { models: new Map<string, CachedModule>(), imports: new Map<string, string>() } : { models: new Map<string, CachedModule>(), imports: new Map<string, string>() };
	if (project) caches.set(project, cache);
	const reads = new Map<string, string>();
	const read = (path: string): string => {
		checkModulePath(root, path);
		if (path === target) return content;
		const proposed = proposedFileContent(path);
		if (proposed === null) throw new Error("Module was deleted in the current source proposal");
		if (proposed !== undefined) return proposed;
		const cached = reads.get(path);
		if (cached !== undefined) return cached;
		const source = project ? project.readFile(path) : supplied?.readFile?.(path) ?? readFileSync(path, "utf8");
		reads.set(path, source);
		return source;
	};
	return { root, target, fullScan: !!project, ...cache, read, gap, importers: () => {
		if (project) return [];
		const result = supplied!.importers(target);
		if (!result.complete) gap(target, `Reverse importer inventory is partial: ${result.reason ?? "candidate index does not establish complete coverage"}`);
		return result.files;
	} };
}

function moduleAt(view: NumericProjectView, file: string): NumericModel | undefined {
	try {
		const content = view.read(file), cached = view.models.get(file);
		if (cached?.content === content) return cached.model;
		const model = numericModel(content, file, reason => view.gap(file, reason));
		view.models.set(file, { content, model });
		return model;
	} catch (error) { view.gap(file, `Numeric helper source is unavailable (${String(error)})`); return undefined; }
}

interface NamedExport { name: string; node: TS.Node | undefined; }

/** Local runtime exports only. An explicitly exported alias with an unknown
 * binding still occupies its name, so a later statement cannot replace it. */
function* statementExports(model: NumericModel, statement: TS.Statement): Generator<NamedExport> {
	const { ts } = model;
	if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
		yield { name: "default", node: numericBinding(model, statement.expression) };
		return;
	}
	if (ts.isExportDeclaration(statement)) {
		yield* aliasExports(model, statement);
		return;
	}
	if (!ts.isFunctionDeclaration(statement) && !ts.isVariableStatement(statement)) return;
	if (!statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return;
	if (ts.isFunctionDeclaration(statement)) {
		const name = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword) ? "default" : statement.name?.text;
		if (name) yield { name, node: statement };
		return;
	}
	for (const declaration of statement.declarationList.declarations) {
		if (ts.isIdentifier(declaration.name)) yield { name: declaration.name.text, node: declaration };
	}
}

function* aliasExports(model: NumericModel, statement: TS.ExportDeclaration): Generator<NamedExport> {
	const { ts } = model;
	if (statement.moduleSpecifier || statement.isTypeOnly || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) return;
	for (const specifier of statement.exportClause.elements) {
		const local = specifier.propertyName ?? specifier.name;
		if (!specifier.isTypeOnly && ts.isIdentifier(local)) yield { name: specifier.name.text, node: numericBinding(model, local) };
	}
}

function exported(model: NumericModel, name: string): TS.Node | undefined {
	for (const statement of model.sf.statements) {
		for (const item of statementExports(model, statement)) if (item.name === name) return item.node;
	}
	return undefined;
}

function importTarget(model: NumericModel, declaration: TS.Node): { specifier: string; name: string } | undefined {
	const { ts } = model;
	if (!ts.isImportSpecifier(declaration) && !ts.isImportClause(declaration)) return undefined;
	let parent: TS.Node | undefined = declaration;
	while (parent && !ts.isImportDeclaration(parent)) parent = parent.parent;
	if (!parent || !ts.isImportDeclaration(parent) || !ts.isStringLiteral(parent.moduleSpecifier)) return undefined;
	return { specifier: parent.moduleSpecifier.text, name: ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : "default" };
}

function importOrigin(view: NumericProjectView, model: NumericModel, declaration: TS.Node): NumericOrigin {
	const target = importTarget(model, declaration);
	if (!target || !target.specifier.startsWith(".")) return OTHER;
	const importKey = `${model.sf.fileName}\0${target.specifier}\0${target.name}`;
	let file: string | null;
	try { file = resolveImportPath(model.sf.fileName, target.specifier); }
	catch (error) { return { state: "unknown", reason: `Numeric candidate helper resolution failed (${String(error)})` }; }
	if (!file) return view.imports.has(importKey) ? { state: "unknown", reason: "Previously resolved numeric helper is missing from the current source view" } : OTHER;
	if (!inside(view.root, file)) return { state: "unknown", reason: "Numeric candidate helper lies outside selected project root" };
	const helper = moduleAt(view, file);
	if (!helper) return { state: "unknown", reason: "Numeric candidate helper could not be inspected" };
	const binding = exported(helper, target.name);
	if (!binding) return OTHER;
	const origin = numericWrapper(helper, binding);
	if (origin.state !== "numeric") { view.imports.delete(importKey); return origin; }
	view.imports.set(importKey, file);
	if (model.writes.has(declaration)) return { state: "unknown", reason: "Imported numeric helper binding is reassigned" };
	if (model.globalWrites.has(origin.source.split(".")[0]!)) return { state: "unknown", reason: "Numeric parser receiver is mutated in its caller" };
	return { ...origin, source: `${relative(view.root, file)}:${helper.sf.getLineAndCharacterOfPosition(binding.getStart()).line + 1} (${origin.source})` };
}

function candidateNames(model: NumericModel, statement: TS.Statement): string[] {
	const { ts } = model;
	if (ts.isFunctionDeclaration(statement)) {
		if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return ["default"];
		return statement.name ? [statement.name.text] : [];
	}
	if (ts.isVariableStatement(statement)) {
		return statement.declarationList.declarations.flatMap(declaration => ts.isIdentifier(declaration.name) ? [declaration.name.text] : []);
	}
	if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) return statement.exportClause.elements.map(specifier => specifier.name.text);
	return ts.isExportAssignment(statement) ? ["default"] : [];
}

function exportedNumericWrappers(model: NumericModel): TS.Node[] {
	const wrappers: TS.Node[] = [];
	for (const statement of model.sf.statements) {
		for (const name of candidateNames(model, statement)) {
			const node = exported(model, name);
			if (node && numericWrapper(model, node).state === "numeric") wrappers.push(node);
		}
	}
	return wrappers;
}

/** A reverse-import candidate is relevant only if its relative import resolves
 * to this helper. Preserve its evidence while locating the finding on the helper. */
function consumerFindings(view: NumericProjectView, caller: NumericModel, callerPath: string, model: NumericModel, wrappers: readonly TS.Node[]): InlineMatch[] {
	const related = numericMatches(caller, reason => view.gap(callerPath, reason), (source, declaration) => {
		const target = importTarget(source, declaration);
		if (!target || !target.specifier.startsWith(".")) return OTHER;
		let resolved: string | null;
		try { resolved = resolveImportPath(source.sf.fileName, target.specifier); }
		catch (error) { view.gap(callerPath, `Reverse candidate import failed (${String(error)})`); return OTHER; }
		return resolved === view.target ? importOrigin(view, source, declaration) : OTHER;
	});
	const matches: InlineMatch[] = [];
	const target = relative(view.root, view.target);
	const line = (offset: number) => model.sf.getLineAndCharacterOfPosition(offset).line + 1;
	for (const finding of related) {
		const wrapper = wrappers.find(node => finding.text.includes(`${target}:${line(node.getStart())}`));
		if (wrapper) matches.push({ line: line(wrapper.getStart()), startOffset: wrapper.getStart(), endOffset: wrapper.getEnd(),
			endLine: line(wrapper.getEnd()), ...(finding.sourceEvidence ? { sourceEvidence: finding.sourceEvidence } : {}),
			text: `Numeric helper consumer ${relative(view.root, callerPath)}:${finding.line}: ${finding.text}` });
	}
	return matches;
}

export function scanNumericProject(view: NumericProjectView, model: NumericModel): InlineMatch[] {
	view.models.set(view.target, { content: model.sf.text, model });
	const matches = numericMatches(model, reason => view.gap(view.target, reason), (source, declaration) => importOrigin(view, source, declaration));
	const wrappers = view.fullScan ? [] : exportedNumericWrappers(model);
	const candidates = wrappers.length ? view.importers() : [];
	for (const candidate of candidates) {
		const path = resolve(view.root, candidate);
		if (path === view.target) continue;
		const caller = moduleAt(view, path);
		if (!caller) continue;
		for (const finding of consumerFindings(view, caller, path, model, wrappers)) matches.push(finding);
	}
	for (const match of matches) {
		if (match.sourceEvidence) match.sourceEvidence = match.sourceEvidence.map(source => ({ ...source, file: relative(view.root, source.file) }));
	}
	return matches;
}
