import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type * as TS from "typescript";
import { resolveImportPath } from "../project-graph.js";
import { reportNotMeasured } from "./check-root.js";
import { getCommanderOptionEvidence } from "./commander-option-evidence.js";
import { getProjectCheckEvidence, type ProjectCheckEvidence } from "./project-check-evidence.js";
import { proposedFileContent } from "./proposed-files.js";
import { actionBody, analyzeCommanderModule, binding, fallbackReads, mutatedBinding, property, resolveCommand, type Action, type CommanderAnalysis, type CommandModel, type Context } from "./commander-option-attribute-model.js";
import type { InlineMatch } from "./shared.js";

const CHECK = "commander_option_attribute";
interface ModuleCache { content: string; analysis: CommanderAnalysis | undefined; }
interface ProjectCache { modules: Map<string, ModuleCache>; registrars?: string[]; }
const projectCaches = new WeakMap<ProjectCheckEvidence, ProjectCache>();
export interface CommanderView {
	root: string;
	target: string;
	fullScan: boolean;
	modules: Map<string, ModuleCache>;
	read: (file: string) => string;
	registrars: () => readonly string[];
	gap: (file: string, reason: string) => void;
}
interface Callable { file: string; name: string; }
interface ImportedSymbol { specifier: string; name: string; }
interface Link { command: CommandModel; target: Callable; parameter: number; aliases: number[]; site: TS.CallExpression; registrar: string; }

function inside(root: string, file: string): boolean {
	const rel = relative(root, file);
	return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

/** No standalone repository fallback. Hook candidates come from a supplied
 * index, while foreground reads use the caller's selected evidence. */
export function commanderProjectView(content: string, filePath: string): CommanderView | undefined {
	const project = getProjectCheckEvidence(), supplied = getCommanderOptionEvidence();
	if (!project && !supplied) return undefined;
	const root = project?.root ?? resolve(supplied!.root), target = resolve(root, filePath);
	if (!inside(root, target)) return undefined;
	const gap = (file: string, reason: string): void => {
		if (project) project.reportUnavailable(CHECK, file, reason);
		else if (supplied?.onUnavailable) supplied.onUnavailable({ file, reason });
		else reportNotMeasured(CHECK, `${file}: ${reason}`);
	};
	const cache: ProjectCache = project ? projectCaches.get(project) ?? { modules: new Map() } : { modules: new Map<string, ModuleCache>() };
	if (project) projectCaches.set(project, cache);
	const read = (file: string): string => {
		if (!inside(root, file)) throw new Error("Module lies outside selected project root");
		const canonical = existsSync(file) ? realpathSync(file) : resolve(realpathSync(dirname(file)), relative(dirname(file), file));
		if (!inside(realpathSync(root), canonical)) throw new Error("Module resolves outside selected project root");
		if (file === target) return content;
		const proposed = proposedFileContent(file);
		if (proposed === null) throw new Error("Module was deleted in the active changeset");
		return proposed ?? (project ? project.readFile(file) : supplied?.readFile?.(file) ?? readFileSync(file, "utf8"));
	};
	return { root, target, fullScan: !!project, modules: cache.modules, read, gap, registrars: () => {
		if (!project) {
			const inventory = supplied!.importers(target);
			if (!inventory.complete) gap(target, `Reverse importer inventory is partial: ${inventory.reason ?? "supplied index does not prove complete discovery"}`);
			return inventory.files;
		}
		return projectRegistrarFiles(project, cache, root, read, gap);
	} };
}

function projectRegistrarFiles(project: ProjectCheckEvidence, cache: ProjectCache, root: string, read: CommanderView["read"], gap: CommanderView["gap"]): string[] {
	if (cache.registrars) return cache.registrars;
	cache.registrars = [];
	for (const file of project.listFiles()) {
		const abs = resolve(root, file);
		try { if (read(abs).includes("commander")) cache.registrars.push(abs); }
		catch (error) { gap(abs, `Registrar inventory source could not be read (${String(error)})`); }
	}
	return cache.registrars;
}

function moduleAt(view: CommanderView, file: string): CommanderAnalysis | undefined {
	try {
		const content = view.read(file), cached = view.modules.get(file);
		if (cached?.content === content) return cached.analysis;
		const analysis = analyzeCommanderModule(content, file, false, reason => view.gap(file, reason));
		view.modules.set(file, { content, analysis });
		return analysis;
	} catch (error) { view.gap(file, `Module could not be read (${String(error)})`); return undefined; }
}

function reassigned(ctx: Context, declaration: TS.Node): boolean {
	let changed = false;
	const visit = (node: TS.Node): void => {
		if (mutatedBinding(ctx, node) === declaration) changed = true;
		ctx.ts.forEachChild(node, visit);
	};
	visit(ctx.sf);
	return changed;
}

function staticSymbol(ctx: Context, declaration: TS.Node): ImportedSymbol | undefined {
	const { ts } = ctx;
	if (!ts.isImportSpecifier(declaration) && !ts.isImportClause(declaration)) return undefined;
	let parent: TS.Node | undefined = declaration;
	while (parent && !ts.isImportDeclaration(parent)) parent = parent.parent;
	if (!parent || !ts.isImportDeclaration(parent) || !ts.isStringLiteral(parent.moduleSpecifier)) return undefined;
	return { specifier: parent.moduleSpecifier.text, name: ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : "default" };
}

function dynamicSymbol(ctx: Context, declaration: TS.Node): ImportedSymbol | undefined {
	const { ts } = ctx;
	if (!ts.isBindingElement(declaration) || !ts.isObjectBindingPattern(declaration.parent) || !ts.isVariableDeclaration(declaration.parent.parent)) return undefined;
	const variable = declaration.parent.parent;
	if (!ts.isVariableDeclarationList(variable.parent) || (variable.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
	let value = variable.initializer;
	if (value && ts.isAwaitExpression(value)) value = value.expression;
	if (!value || !ts.isCallExpression(value) || value.expression.kind !== ts.SyntaxKind.ImportKeyword || value.arguments.length !== 1) return undefined;
	const specifier = value.arguments[0], symbol = declaration.propertyName ?? declaration.name;
	if (!specifier || !ts.isStringLiteral(specifier) || !ts.isIdentifier(symbol)) return undefined;
	return { specifier: specifier.text, name: symbol.text };
}

function importedTarget(view: CommanderView, ctx: Context, declaration: TS.Node | undefined): Callable | undefined {
	if (!declaration || reassigned(ctx, declaration)) return undefined;
	const symbol = staticSymbol(ctx, declaration) ?? dynamicSymbol(ctx, declaration);
	if (!symbol) return undefined;
	const { specifier, name } = symbol;
	if (!specifier.startsWith(".")) { view.gap(ctx.sf.fileName, "Imported action uses unsupported package or alias module resolution"); return undefined; }
	try {
		const file = resolveImportPath(ctx.sf.fileName, specifier);
		if (file && inside(view.root, file)) return { file, name };
		view.gap(ctx.sf.fileName, `Action module ${JSON.stringify(specifier)} is unresolved or outside selected root`);
	} catch (error) { view.gap(ctx.sf.fileName, `Action module resolution failed (${String(error)})`); }
	return undefined;
}

function callable(view: CommanderView, ctx: Context, expression: TS.Expression): Callable | undefined {
	return ctx.ts.isIdentifier(expression) ? importedTarget(view, ctx, binding(ctx, expression)) : undefined;
}

function boundReference(ctx: Context, node: TS.Node, parameter: TS.Node): boolean {
	return ctx.ts.isIdentifier(node) && binding(ctx, node) === parameter;
}

function rawEscape(ctx: Context, node: TS.Node, parameter: TS.Node, ignoredCall?: TS.CallExpression): boolean {
	const { ts } = ctx;
	if (!boundReference(ctx, node, parameter)) return false;
	const parent = node.parent;
	if (ts.isPropertyAccessExpression(parent)) return false;
	if (ts.isElementAccessExpression(parent) && parent.expression === node) return false;
	if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
	return parent !== ignoredCall;
}

function callEscapes(ctx: Context, node: TS.Node, parameter: TS.Node, ignoredCall?: TS.CallExpression): boolean {
	const { ts } = ctx;
	if (!ts.isCallExpression(node) || node === ignoredCall) return false;
	if (node.arguments.some(argument => boundReference(ctx, argument, parameter))) return true;
	if (!ts.isPropertyAccessExpression(node.expression) && !ts.isElementAccessExpression(node.expression)) return false;
	return boundReference(ctx, node.expression.expression, parameter);
}

/** Nested closures and mutation/escape events are unknown. Source order is
 * used only within a single function body, never inside a deferred closure. */
function firstUnsafe(ctx: Context, fn: Action, parameter: TS.Node, ignoredCall?: TS.CallExpression): number {
	const { ts } = ctx;
	let first = Infinity;
	const visit = (node: TS.Node): void => {
		if (node !== fn && ts.isFunctionLike(node)) {
			const captures = (child: TS.Node): boolean => boundReference(ctx, child, parameter) || !!ts.forEachChild(child, captures);
			if (ts.forEachChild(node, captures)) first = 0;
			return;
		}
		if (mutatedBinding(ctx, node) === parameter) first = Math.min(first, node.getStart(ctx.sf));
		if (rawEscape(ctx, node, parameter, ignoredCall)) first = Math.min(first, node.getStart(ctx.sf));
		if (callEscapes(ctx, node, parameter, ignoredCall)) first = Math.min(first, node.getStart(ctx.sf));
		ts.forEachChild(node, visit);
	};
	if (fn.body) ts.forEachChild(fn.body, visit);
	return first;
}

function custom(command: CommandModel): boolean { return command.unsafe || !!command.parent && custom(command.parent); }

function actionLinks(view: CommanderView, analysis: CommanderAnalysis): Link[] {
	const { ctx, calls } = analysis, { ts, sf } = ctx;
	const links: Link[] = [];
	for (const site of calls) {
		if (!ts.isPropertyAccessExpression(site.expression) || site.expression.name.text !== "action" || !site.arguments[0]) continue;
		const command = resolveCommand(ctx, site.expression.expression);
		if (!command) continue;
		if (custom(command)) { view.gap(sf.fileName, "Custom or dynamic Commander option/argument configuration is unsupported"); continue; }
		const direct = callable(view, ctx, site.arguments[0]);
		if (direct) { links.push({ command, target: direct, parameter: command.arguments, aliases: [command.arguments], site, registrar: sf.fileName }); continue; }
		const fn = actionBody(ctx, site.arguments[0]), parameter = fn?.parameters[command.arguments];
		if (!fn || !parameter || !ts.isIdentifier(parameter.name) || !fn.body) { view.gap(sf.fileName, "Action callable or options parameter is unresolved"); continue; }
		const visit = (node: TS.Node): void => {
			if (ts.isFunctionLike(node)) return;
			if (ts.isCallExpression(node)) links.push(...forwardedLinks(view, ctx, fn, parameter, node, command, site));
			ts.forEachChild(node, visit);
		};
		visit(fn.body);
	}
	return links;
}

/** Evaluate every argument before invoking the imported handler. Aliased
 * raw parameters remain one mutation scope in the receiving function. */
function forwardedLinks(view: CommanderView, ctx: Context, fn: Action, parameter: TS.ParameterDeclaration, call: TS.CallExpression, command: CommandModel, site: TS.CallExpression): Link[] {
	const positions = call.arguments.flatMap((argument, index) => boundReference(ctx, argument, parameter) ? [index] : []);
	if (!positions.length) return [];
	const target = callable(view, ctx, call.expression);
	if (!target || firstUnsafe(ctx, fn, parameter, call) < call.end) {
		view.gap(ctx.sf.fileName, "Options forwarding has an unresolved callable or prior mutation/escape"); return [];
	}
	return positions.map(index => ({ command, target, parameter: index, aliases: positions, site, registrar: ctx.sf.fileName }));
}

function stableAction(ctx: Context, expression: TS.Expression): Action | undefined {
	const { ts } = ctx;
	if (ts.isIdentifier(expression)) {
		const declaration = binding(ctx, expression);
		if (!declaration || reassigned(ctx, declaration)) return undefined;
		if (ts.isVariableDeclaration(declaration) && (!ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0)) return undefined;
	}
	return actionBody(ctx, expression);
}

function statementAction(ctx: Context, statement: TS.Statement, name: string): Action | undefined {
	const { ts } = ctx;
	if (name === "default" && ts.isExportAssignment(statement)) return stableAction(ctx, statement.expression);
	if (ts.isFunctionDeclaration(statement)) return functionExport(ctx, statement, name);
	if (ts.isVariableStatement(statement)) return variableExport(ctx, statement, name);
	if (ts.isExportDeclaration(statement)) return namedExport(ctx, statement, name);
	return undefined;
}

function functionExport(ctx: Context, statement: TS.FunctionDeclaration, name: string): Action | undefined {
	const { ts } = ctx;
	if (!statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return undefined;
	const selected = statement.name?.text === name || name === "default" && statement.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);
	return selected && !reassigned(ctx, statement) ? statement : undefined;
}

function variableExport(ctx: Context, statement: TS.VariableStatement, name: string): Action | undefined {
	const { ts } = ctx;
	if (!statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return undefined;
	for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return stableAction(ctx, declaration.name);
	return undefined;
}

function namedExport(ctx: Context, statement: TS.ExportDeclaration, name: string): Action | undefined {
	const { ts } = ctx;
	if (statement.moduleSpecifier || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) return undefined;
	for (const specifier of statement.exportClause.elements) if (specifier.name.text === name) return stableAction(ctx, specifier.propertyName ?? specifier.name);
	return undefined;
}

function exportedAction(analysis: CommanderAnalysis, name: string): Action | undefined {
	for (const statement of analysis.ctx.sf.statements) {
		const action = statementAction(analysis.ctx, statement, name);
		if (action) return action;
	}
	return undefined;
}

function handlerMatches(view: CommanderView, link: Link, analysis: CommanderAnalysis): InlineMatch[] {
	const { ctx } = analysis, { ts } = ctx;
	const fn = exportedAction(analysis, link.target.name), parameter = fn?.parameters[link.parameter];
	if (!fn || !fn.body || !parameter || !ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken) {
		view.gap(link.target.file, "Exported handler or plain options parameter is unresolved"); return [];
	}
	const aliasParameters = link.aliases.flatMap(index => fn.parameters[index] ? [fn.parameters[index]!] : []);
	const unsafe = Math.min(...aliasParameters.map(alias => firstUnsafe(ctx, fn, alias))), matches: InlineMatch[] = [];
	const visit = (node: TS.Node): void => {
		if (ts.isFunctionLike(node)) {
			const captured = (child: TS.Node): boolean => {
				const access = property(ctx, child);
				return !!access && link.command.options.has(access.key) && binding(ctx, access.receiver) === parameter || !!ts.forEachChild(child, captured);
			};
			if (ts.forEachChild(node, captured)) view.gap(link.target.file, "Deferred closure captures options; read execution and mutation order are unknown");
			return;
		}
		const match = linkedRead(view, link, ctx, node, parameter, unsafe);
		if (match) matches.push(match);
		ts.forEachChild(node, visit);
	};
	visit(fn.body);
	return matches;
}

function linkedRead(view: CommanderView, link: Link, ctx: Context, node: TS.Node, parameter: TS.ParameterDeclaration, unsafe: number): InlineMatch | undefined {
	const access = property(ctx, node), canonical = access && link.command.options.get(access.key);
	if (!access || !canonical || binding(ctx, access.receiver) !== parameter || fallbackReads(ctx, node, parameter, canonical)) return undefined;
	if (node.getStart(ctx.sf) >= unsafe) {
		view.gap(link.target.file, `Read of ${JSON.stringify(access.key)} follows an unknown options mutation/escape`); return undefined;
	}
	return { line: ctx.sf.getLineAndCharacterOfPosition(node.getStart(ctx.sf)).line + 1,
		text: `${CHECK}: Commander stores --${access.key} as "${canonical}"; raw options reach this handler from ${relative(view.root, link.registrar)}:${link.site.getSourceFile().getLineAndCharacterOfPosition(link.site.getStart()).line + 1}` };
}

export function commanderProjectMatches(view: CommanderView, analysis: CommanderAnalysis, filePath: string, registrar: boolean, incoming = true): InlineMatch[] {
	const current = resolve(view.root, filePath), matches: InlineMatch[] = [];
	view.modules.set(current, { content: view.read(current), analysis });
	const candidates = new Set([...(registrar ? [current] : []), ...(incoming ? view.registrars() : [])]);
	for (const candidate of candidates) {
		const registration = candidate === current ? analysis : moduleAt(view, candidate);
		if (!registration) continue;
		for (const link of actionLinks(view, registration)) matches.push(...locatedLinkFindings(view, analysis, current, candidate, link));
	}
	return matches.filter((match, index) => matches.findIndex(other => other.line === match.line && other.text === match.text) === index);
}

/** Findings use the currently evaluated file's coordinate system. Foreground
 * reports own the handler location once, while a registrar-only hook names it
 * from an action-site finding in that registrar. */
function locatedLinkFindings(view: CommanderView, analysis: CommanderAnalysis, current: string, candidate: string, link: Link): InlineMatch[] {
	const handlerHere = link.target.file === current;
	if (!handlerHere && (candidate !== current || view.fullScan)) return [];
	const target = handlerHere ? analysis : moduleAt(view, link.target.file);
	if (!target) return [];
	const matches = handlerMatches(view, link, target);
	if (handlerHere) return matches;
	return matches.map(match => ({ line: analysis.ctx.sf.getLineAndCharacterOfPosition(link.site.getStart()).line + 1,
		text: `${match.text}; handler read at ${relative(view.root, link.target.file)}:${match.line}` }));
}
