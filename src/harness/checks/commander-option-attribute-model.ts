// CLASS: Commander flag spelling used as an options-object attribute.
// FIRES WHEN: resolved Commander declarations and a directly bound options read disagree
// about a dashed or negated option's canonical attribute name.
// DOES NOT FIRE: unrelated libraries, normalized copies, compatibility fallbacks,
// custom/dynamic options, mutated options objects or unresolved action bodies.
// CALIBRATION: advisory, with a separate real-repository census recorded in the audit.
// KNOWN GAPS: cross-module forwarding, CommonJS, JSDoc-only registrar types and custom factories.
// HOW TO EXTEND: add resolved binding/normalization evidence with independent controls.
import type * as TS from "typescript";
import { reportNotMeasured } from "./check-root.js";
import { hasParseErrors, parseTsSource, type ParsedTsSource } from "./cyclomatic-ast.js";
import type { InlineMatch } from "./shared.js";

const CHECK = "commander_option_attribute";
const FLUENT = new Set(["option", "requiredOption", "addOption", "argument", "arguments", "description", "summary", "name", "alias", "aliases", "version", "usage", "helpOption", "addHelpText", "configureHelp", "configureOutput", "showHelpAfterError", "showSuggestionAfterError", "allowUnknownOption", "allowExcessArguments", "enablePositionalOptions", "passThroughOptions", "exitOverride", "hook", "action", "parse", "storeOptionsAsProperties"]);
const OPTION_FLUENT = new Set(["argParser", "choices", "conflicts", "default", "env", "hideHelp", "implies", "makeOptionMandatory", "preset"]);
export type Action = TS.ArrowFunction | TS.FunctionExpression | TS.FunctionDeclaration;
export interface CommandModel {
	node: TS.Node;
	parent: CommandModel | undefined;
	options: Map<string, string>;
	arguments: number;
	unsafe: boolean;
}
export interface Context extends ParsedTsSource {
	scopes: Map<TS.Node, Map<string, TS.Node>>;
	models: Map<TS.Node, CommandModel>;
	commandParameters: Map<TS.Node, CommandModel>;
	reportMissing: boolean;
	reportUnavailable: (reason: string) => void;
}

function isScope(ctx: ParsedTsSource, node: TS.Node): boolean {
	const { ts } = ctx;
	return ts.isSourceFile(node) || ts.isBlock(node) || ts.isFunctionLike(node) || ts.isCatchClause(node);
}

/** Resolve lexical declarations, so unrelated/shadowed identifiers cannot supply library evidence. */
function collectScopes(ctx: Context): void {
	const { ts, sf, scopes } = ctx;
	const register = (scope: TS.Node, name: string, declaration: TS.Node): void => {
		const names = scopes.get(scope) ?? new Map<string, TS.Node>();
		names.set(name, declaration);
		scopes.set(scope, names);
	};
	const visit = (node: TS.Node, scope: TS.Node): void => {
		if (ts.isFunctionDeclaration(node) && node.name) register(scope, node.name.text, node);
		const next = isScope(ctx, node) ? node : scope;
		if ((ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isParameter(node) || ts.isImportSpecifier(node)
			|| ts.isNamespaceImport(node) || ts.isImportClause(node)) && node.name && ts.isIdentifier(node.name)) register(next, node.name.text, node);
		ts.forEachChild(node, child => visit(child, next));
	};
	visit(sf, sf);
}

export function binding(ctx: Context, identifier: TS.Identifier): TS.Node | undefined {
	let scope: TS.Node | undefined = identifier;
	while (scope) {
		const declaration = ctx.scopes.get(scope)?.get(identifier.text);
		if (declaration) return declaration;
		scope = scope.parent;
	}
	return undefined;
}

function commanderImport(ctx: Context, node: TS.Node | undefined, exported: string): boolean {
	const { ts } = ctx;
	if (!node) return false;
	let declaration: TS.Node | undefined = node;
	while (declaration && !ts.isImportDeclaration(declaration)) declaration = declaration.parent;
	if (!declaration || !ts.isImportDeclaration(declaration) || !ts.isStringLiteral(declaration.moduleSpecifier)
		|| declaration.moduleSpecifier.text !== "commander") return false;
	return ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === exported;
}

function libraryMember(ctx: Context, expression: TS.Expression, member: string): boolean {
	const { ts } = ctx;
	if (ts.isIdentifier(expression)) return commanderImport(ctx, binding(ctx, expression), member);
	if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== member || !ts.isIdentifier(expression.expression)) return false;
	const namespace = binding(ctx, expression.expression);
	return !!namespace && ts.isNamespaceImport(namespace) && ts.isImportDeclaration(namespace.parent.parent)
		&& ts.isStringLiteral(namespace.parent.parent.moduleSpecifier) && namespace.parent.parent.moduleSpecifier.text === "commander";
}

function model(ctx: Context, node: TS.Node, parent?: CommandModel, argumentCount = 0): CommandModel {
	let result = ctx.models.get(node);
	if (!result) {
		result = { node, parent, options: new Map(), arguments: argumentCount, unsafe: false };
		ctx.models.set(node, result);
	}
	return result;
}

export function resolveCommand(ctx: Context, expression: TS.Expression, seen = new Set<TS.Node>()): CommandModel | undefined {
	const { ts } = ctx;
	if (seen.has(expression)) return undefined;
	seen.add(expression);
	if (ts.isParenthesizedExpression(expression)) return resolveCommand(ctx, expression.expression, seen);
	if (libraryMember(ctx, expression, "program")) {
		const identifier = ts.isPropertyAccessExpression(expression) ? expression.expression : expression;
		return model(ctx, ts.isIdentifier(identifier) ? binding(ctx, identifier) ?? expression : expression);
	}
	if (ts.isNewExpression(expression) && libraryMember(ctx, expression.expression, "Command")) return model(ctx, expression);
	if (ts.isIdentifier(expression)) {
		return commandBinding(ctx, expression, seen);
	}
	if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return undefined;
	const method = expression.expression.name.text;
	const receiver = resolveCommand(ctx, expression.expression.expression, seen);
	if (!receiver) return undefined;
	if (method === "command") {
		return childCommand(ctx, expression, receiver);
	}
	return FLUENT.has(method) ? receiver : undefined;
}

function childCommand(ctx: Context, call: TS.CallExpression, parent: CommandModel): CommandModel {
	const synopsis = literal(ctx, call.arguments[0]);
	const result = model(ctx, call, parent, synopsis?.match(/<[^>]+>|\[[^\]]+\]/g)?.length ?? 0);
	if (synopsis === undefined) result.unsafe = true;
	return result;
}

/** Only immutable aliases and Commander-typed registrar parameters carry command identity. */
function commandBinding(ctx: Context, expression: TS.Identifier, seen: Set<TS.Node>): CommandModel | undefined {
	const { ts } = ctx, declaration = binding(ctx, expression);
	if (!declaration) return undefined;
	const parameter = ctx.commandParameters.get(declaration);
	if (parameter) return parameter;
	if (ts.isParameter(declaration) && declaration.type && ts.isTypeReferenceNode(declaration.type)
		&& ts.isIdentifier(declaration.type.typeName) && commanderImport(ctx, binding(ctx, declaration.type.typeName), "Command")) return model(ctx, declaration);
	if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isVariableDeclarationList(declaration.parent)
		&& (declaration.parent.flags & ts.NodeFlags.Const) !== 0) return resolveCommand(ctx, declaration.initializer, seen);
	return undefined;
}

function literal(ctx: Context, node: TS.Node | undefined): string | undefined {
	return node && ctx.ts.isStringLiteralLike(node) ? node.text : undefined;
}

/** Accept standard Option construction while leaving overrides/custom builders unresolved. */
function optionFlags(ctx: Context, expression: TS.Expression | undefined): string | undefined {
	const { ts } = ctx;
	if (!expression) return undefined;
	if (ts.isNewExpression(expression) && libraryMember(ctx, expression.expression, "Option")) return literal(ctx, expression.arguments?.[0]);
	if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
		&& OPTION_FLUENT.has(expression.expression.name.text)) return optionFlags(ctx, expression.expression.expression);
	return undefined;
}

function declareOption(command: CommandModel, flags: string | undefined): void {
	const flag = flags?.match(/--([\w-]+)/)?.[1];
	if (!flag) { command.unsafe = true; return; }
	const attribute = flag.replace(/^no-/, "").replace(/-([\w])/g, (_, letter: string) => letter.toUpperCase());
	if (flag !== attribute) command.options.set(flag, attribute);
}

function collectDeclarations(ctx: Context, calls: TS.CallExpression[]): void {
	const { ts, sf } = ctx;
	const lastOption = new Map<CommandModel, number>();
	const visit = (node: TS.Node): void => {
		if (ts.isCallExpression(node)) calls.push(node);
		ts.forEachChild(node, visit);
	};
	visit(sf);
	// Inner fluent calls must be collected before outer actions use the resulting model.
	for (const call of [...calls].reverse()) {
		if (!ts.isPropertyAccessExpression(call.expression)) continue;
		const command = resolveCommand(ctx, call.expression.expression);
		if (!command) {
			if (["option", "requiredOption", "addOption", "action"].includes(call.expression.name.text)) {
				ctx.reportUnavailable("Commander-like receiver requires cross-module, JSDoc or custom-factory binding evidence");
			}
			continue;
		}
		const method = call.expression.name.text;
		applyDeclaration(ctx, command, call, method);
		if (["option", "requiredOption", "addOption"].includes(method)) lastOption.set(command, Math.max(lastOption.get(command) ?? 0, call.end));
	}
	markLateDeclarations(ctx, calls, lastOption);
}

function applyDeclaration(ctx: Context, command: CommandModel, call: TS.CallExpression, method: string): void {
	const argument = literal(ctx, call.arguments[0]);
	if (method === "argument" || method === "arguments") {
		command.arguments += argument?.match(/<[^>]+>|\[[^\]]+\]/g)?.length ?? 0;
		if (argument === undefined) command.unsafe = true;
	} else if (method === "option" || method === "requiredOption") declareOption(command, argument);
	else if (method === "addOption") declareOption(command, optionFlags(ctx, call.arguments[0]));
	else if (["storeOptionsAsProperties", "hook", "setOptionValue", "setOptionValueWithSource", "addArgument"].includes(method)) command.unsafe = true;
}

/** Textual dispatch ambiguity invalidates evidence, rather than guessing when
 * separately declared callbacks and commands execute. */
function markLateDeclarations(ctx: Context, calls: TS.CallExpression[], lastOption: Map<CommandModel, number>): void {
	const { ts } = ctx;
	for (const call of calls) {
		if (!ts.isPropertyAccessExpression(call.expression) || !["parse", "parseAsync"].includes(call.expression.name.text)) continue;
		const command = resolveCommand(ctx, call.expression.expression);
		if (command) for (const [configured, end] of lastOption) {
			let ancestor: CommandModel | undefined = configured;
			while (ancestor && ancestor !== command) ancestor = ancestor.parent;
			if (ancestor === command && end > call.end) configured.unsafe = true;
		}
	}
}

function missingBinding(ctx: Context, reason: string): void {
	if (ctx.reportMissing) ctx.reportUnavailable(reason);
}

export function actionBody(ctx: Context, expression: TS.Expression | undefined): Action | undefined {
	const { ts } = ctx;
	if (!expression) return undefined;
	if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
	if (!ts.isIdentifier(expression)) return undefined;
	const declaration = binding(ctx, expression);
	if (declaration && ts.isFunctionDeclaration(declaration)) return declaration;
	if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) return actionBody(ctx, declaration.initializer);
	return undefined;
}

function collectOptions(ctx: Context, calls: TS.CallExpression[]): Map<TS.Node, CommandModel> {
	const { ts } = ctx, options = new Map<TS.Node, CommandModel>();
	for (const call of calls) {
		if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "action") continue;
		const command = resolveCommand(ctx, call.expression.expression);
		if (!command) continue;
		const action = actionBody(ctx, call.arguments[0]);
		if (!action) { missingBinding(ctx, "action body requires cross-module or dynamic resolution"); continue; }
		const opts = action.parameters[command.arguments], cmd = action.parameters[command.arguments + 1];
		if (opts && ts.isIdentifier(opts.name)) options.set(opts, command);
		if (cmd && ts.isIdentifier(cmd.name)) ctx.commandParameters.set(cmd, command);
	}
	for (const call of calls) {
		if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "opts") continue;
		const command = resolveCommand(ctx, call.expression.expression);
		if (command && ts.isVariableDeclaration(call.parent) && ts.isIdentifier(call.parent.name)) options.set(call.parent, command);
	}
	return options;
}

export function property(ctx: Context, node: TS.Node): { receiver: TS.Identifier; key: string } | undefined {
	const { ts } = ctx;
	if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) return { receiver: node.expression, key: node.name.text };
	if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
		const key = literal(ctx, node.argumentExpression);
		if (key !== undefined) return { receiver: node.expression, key };
	}
	return undefined;
}

export function fallbackReads(ctx: Context, node: TS.Node, declaration: TS.Node, canonical: string): boolean {
	const { ts } = ctx;
	let current: TS.Node = node;
	while (current.parent && !ts.isStatement(current.parent) && !ts.isFunctionLike(current.parent)) {
		current = current.parent;
		if (!ts.isBinaryExpression(current) || ![ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(current.operatorToken.kind)) continue;
		const visit = (child: TS.Node): boolean => {
			const access = property(ctx, child);
			return !!access && access.key === canonical && binding(ctx, access.receiver) === declaration || !!ts.forEachChild(child, visit);
		};
		if (visit(current)) return true;
	}
	return false;
}

/** Identify operations that change the object or replace its binding. */
export function mutatedBinding(ctx: Context, node: TS.Node): TS.Node | undefined {
	const { ts } = ctx, access = property(ctx, node);
	const identifier = access?.receiver ?? (ts.isIdentifier(node) ? node : undefined);
	if (!identifier) return undefined;
	const target = assignmentTarget(ctx, node);
	const parent = target.parent;
	if (ts.isBinaryExpression(parent) && parent.left === target
		&& parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
		&& parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return binding(ctx, identifier);
	if (ts.isPostfixUnaryExpression(parent) || ts.isDeleteExpression(parent)) return binding(ctx, identifier);
	if (ts.isPrefixUnaryExpression(parent) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator)) return binding(ctx, identifier);
	return undefined;
}

/** Ascend through assignment-pattern containers without treating object-literal
 * reads as writes. The enclosing assignment is checked by the caller. */
function assignmentTarget(ctx: Context, node: TS.Node): TS.Node {
	const { ts } = ctx;
	let target = node;
	while (target.parent && (ts.isArrayLiteralExpression(target.parent) || ts.isObjectLiteralExpression(target.parent)
		|| ts.isPropertyAssignment(target.parent) || ts.isSpreadAssignment(target.parent) || ts.isSpreadElement(target.parent)
		|| ts.isParenthesizedExpression(target.parent))) target = target.parent;
	return target;
}

function collectUnsafeBindings(ctx: Context, options: Map<TS.Node, CommandModel>): Set<TS.Node> {
	const { ts, sf } = ctx, unsafe = new Set<TS.Node>();
	const visit = (node: TS.Node): void => {
		const changed = mutatedBinding(ctx, node);
		if (changed && options.has(changed)) unsafe.add(changed);
		if (ts.isIdentifier(node) && ts.isVariableDeclaration(node.parent) && node.parent.initializer === node) {
			const aliased = binding(ctx, node);
			if (aliased && options.has(aliased)) {
				unsafe.add(aliased);
				missingBinding(ctx, "aliased options object requires mutation and normalization evidence");
			}
		}
		if (ts.isCallExpression(node)) {
			for (const forwarded of calledOptionsBindings(ctx, node, options)) {
				unsafe.add(forwarded);
				missingBinding(ctx, "options forwarded to another callable; handler mapping requires additional evidence");
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	if (unsafe.size > 0) missingBinding(ctx, "escaped or modified options bindings require mutation and normalization evidence");
	return unsafe;
}

/** Raw argument forwarding and same-object methods can both normalize options. */
function calledOptionsBindings(ctx: Context, call: TS.CallExpression, options: Map<TS.Node, CommandModel>): TS.Node[] {
	const { ts } = ctx;
	const expressions = [...call.arguments];
	if (ts.isPropertyAccessExpression(call.expression) || ts.isElementAccessExpression(call.expression)) expressions.push(call.expression.expression);
	const result: TS.Node[] = [];
	for (const expression of expressions) {
		const declaration = ts.isIdentifier(expression) ? binding(ctx, expression) : undefined;
		if (declaration && options.has(declaration)) result.push(declaration);
	}
	return result;
}

export interface CommanderAnalysis { ctx: Context; calls: TS.CallExpression[]; options: Map<TS.Node, CommandModel>; }

export function analyzeCommanderModule(content: string, filePath: string, reportMissing = true, onUnavailable?: (reason: string) => void): CommanderAnalysis | undefined {
	const reportUnavailable = onUnavailable ?? (reason => reportNotMeasured(CHECK, reason));
	const parsed = parseTsSource(content, filePath);
	if (!parsed || hasParseErrors(parsed.sf)) {
		reportUnavailable("Commander AST unavailable or source has parse errors");
		return undefined;
	}
	const ctx: Context = { ...parsed, scopes: new Map(), models: new Map(), commandParameters: new Map(), reportMissing, reportUnavailable };
	collectScopes(ctx);
	const calls: TS.CallExpression[] = [];
	collectDeclarations(ctx, calls);
	return { ctx, calls, options: collectOptions(ctx, calls) };
}

export function sameFileCommanderMatches({ ctx, options }: CommanderAnalysis): InlineMatch[] {
	const unsafe = collectUnsafeBindings(ctx, options), matches: InlineMatch[] = [];
	const { ts, sf } = ctx;
	const visit = (node: TS.Node): void => {
		const access = property(ctx, node), declaration = access && binding(ctx, access.receiver);
		const command = declaration && options.get(declaration);
		if (command && access && declaration) {
			const canonical = command.options.get(access.key);
			if (mutatedBinding(ctx, node) !== declaration && !(canonical && fallbackReads(ctx, node, declaration, canonical))) {
				let current: CommandModel | undefined = command, custom = false;
				while (current) { custom ||= current.unsafe; current = current.parent; }
				if (canonical && unsafe.has(declaration)) ctx.reportUnavailable(`Read of ${JSON.stringify(access.key)} has unresolved options mutation or escape`);
				else if (custom) ctx.reportUnavailable("custom or dynamic Commander option configuration requires attribute mapping");
				else if (canonical) matches.push({
					line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
					text: `${CHECK}: Commander stores --${access.key} as "${canonical}"; read that attribute or explicitly normalize the options object`,
				});
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return matches;
}

/** This AST filter removes quoted/comment examples before reverse-index work. */
export function potentialCommanderHandlerRead({ ctx }: CommanderAnalysis): boolean {
	const visit = (node: TS.Node): boolean => {
		const access = property(ctx, node), declaration = access && binding(ctx, access.receiver);
		return !!access && access.key.includes("-") && !!declaration && ctx.ts.isParameter(declaration)
			|| !!ctx.ts.forEachChild(node, visit);
	};
	return visit(ctx.sf);
}
