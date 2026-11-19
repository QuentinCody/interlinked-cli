import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type * as TS from "typescript";
import type { InlineMatch } from "../check-registry/types.js";
import { resolveImportPath } from "../project-graph.js";
import { reportNotMeasured } from "./check-root.js";
import { getNumericZeroDefaultEvidence } from "./numeric-zero-default-evidence.js";
import { NUMERIC_ZERO_CHECK, numericBinding, numericMatches, numericModel, numericWrapper, type NumericModel, type NumericOrigin } from "./numeric-zero-default.js";
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
		if (!inside(root, path)) throw new Error("Module lies outside selected project root");
		const canonical = existsSync(path) ? realpathSync(path) : resolve(realpathSync(dirname(path)), relative(dirname(path), path));
		if (!inside(realpathSync(root), canonical)) throw new Error("Module resolves outside selected project root");
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

function exported(model: NumericModel, name: string): TS.Node | undefined {
	const { ts } = model;
	for (const statement of model.sf.statements) {
		const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
		const isExport = modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
		const isDefault = modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);
		if (ts.isFunctionDeclaration(statement) && isExport && (name === "default" ? isDefault : statement.name?.text === name && !isDefault)) return statement;
		if (ts.isVariableStatement(statement) && isExport) {
			for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration;
		}
		if (ts.isExportAssignment(statement) && name === "default" && ts.isIdentifier(statement.expression)) return numericBinding(model, statement.expression);
		if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
			for (const specifier of statement.exportClause.elements) {
				const local = specifier.propertyName ?? specifier.name;
				if (!statement.isTypeOnly && !specifier.isTypeOnly && specifier.name.text === name && ts.isIdentifier(local)) return numericBinding(model, local);
			}
		}
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

function exportedNumericWrappers(model: NumericModel): Array<{ node: TS.Node; name: string }> {
	const { ts } = model, result: Array<{ node: TS.Node; name: string }> = [];
	const add = (name: string): void => {
		const node = exported(model, name);
		if (node && numericWrapper(model, node).state === "numeric") result.push({ node, name });
	};
	for (const statement of model.sf.statements) {
		if (ts.isFunctionDeclaration(statement)) {
			if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) add("default");
			else if (statement.name) add(statement.name.text);
		}
		if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
			if (ts.isIdentifier(declaration.name)) add(declaration.name.text);
		}
		if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) for (const specifier of statement.exportClause.elements) add(specifier.name.text);
		if (ts.isExportAssignment(statement)) add("default");
	}
	return result;
}

export function scanNumericProject(view: NumericProjectView, model: NumericModel): InlineMatch[] {
	view.models.set(view.target, { content: model.sf.text, model });
	const matches = numericMatches(model, reason => view.gap(view.target, reason), (source, declaration) => importOrigin(view, source, declaration));
	const normalize = (): InlineMatch[] => {
		for (const match of matches) if (match.sourceEvidence) match.sourceEvidence = match.sourceEvidence.map(source => ({ ...source, file: relative(view.root, source.file) }));
		return matches;
	};
	if (view.fullScan) return normalize();
	const wrappers = exportedNumericWrappers(model);
	if (!wrappers.length) return normalize();
	for (const candidate of view.importers()) {
		const callerPath = resolve(view.root, candidate);
		if (callerPath === view.target) continue;
		const caller = moduleAt(view, callerPath);
		if (!caller) continue;
		const related = numericMatches(caller, reason => view.gap(callerPath, reason), (source, declaration) => {
			const target = importTarget(source, declaration);
			if (!target || !target.specifier.startsWith(".")) return OTHER;
			let resolved: string | null;
			try { resolved = resolveImportPath(source.sf.fileName, target.specifier); }
			catch (error) { view.gap(callerPath, `Reverse candidate import failed (${String(error)})`); return OTHER; }
			return resolved === view.target ? importOrigin(view, source, declaration) : OTHER;
		});
		for (const finding of related) {
			const wrapper = wrappers.find(item => finding.text.includes(`${relative(view.root, view.target)}:${model.sf.getLineAndCharacterOfPosition(item.node.getStart()).line + 1}`));
			if (wrapper) matches.push({ line: model.sf.getLineAndCharacterOfPosition(wrapper.node.getStart()).line + 1,
				startOffset: wrapper.node.getStart(), endOffset: wrapper.node.getEnd(), endLine: model.sf.getLineAndCharacterOfPosition(wrapper.node.getEnd()).line + 1,
				...(finding.sourceEvidence ? { sourceEvidence: finding.sourceEvidence } : {}), text: `Numeric helper consumer ${relative(view.root, callerPath)}:${finding.line}: ${finding.text}` });
		}
	}
	return normalize();
}
