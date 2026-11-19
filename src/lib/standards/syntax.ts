import type * as TS from "typescript";
import { hasParseErrors, parseTsSource, type ParsedTsSource } from "../../harness/checks/cyclomatic-ast.js";
import { executesAtModuleLoad } from "../../harness/checks/module-load-side-effects.js";

export interface SyntaxFinding {
	rule: string;
	kind: "ast_occurrence" | "semantic_candidate";
	line: number;
	column: number;
	endLine: number;
	startOffset: number;
	endOffset: number;
	text: string;
	detail: string | null;
}
export interface StandardsSyntax {
	state: "measured" | "unsupported" | "inconclusive";
	findings: SyntaxFinding[];
	notMeasured: string[];
}
interface Context extends ParsedTsSource { findings: SyntaxFinding[]; }

function expressionName(context: Context, node: TS.Expression): string {
	const { ts } = context;
	if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) return expressionName(context, node.expression);
	if (ts.isIdentifier(node)) return node.text;
	if (ts.isPropertyAccessExpression(node)) return `${expressionName(context, node.expression)}.${node.name.text}`;
	if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return `${expressionName(context, node.expression)}.${node.argumentExpression.text}`;
	return node.getText(context.sf);
}

const CANDIDATES = new Set(["boolean_state_bag_candidate", "discarded_parser_syntax", "module_collection_state_candidate", "module_init_effect", "transaction_api_candidate", "transaction_external_effect_candidate", "sensitive_sink_name_candidate", "secret_unwrap"]);
const EFFECT = /^(?:(?:fs|fsPromises|fsp|promises)\.)?(?:readFile|writeFile|appendFile|mkdir|rm|readdir|open|close|stat|access|realpath|rename|unlink|createReadStream|createWriteStream)(?:Sync)?$|^(?:(?:childProcess|cp)\.)?(?:spawn|exec|execFile|fork)(?:Sync)?$|^(?:fetch|setInterval|setTimeout)$|^(?:http|https|net)\.(?:createServer|connect|request|get)$|\.(?:listen|connect|on|addEventListener)$/;
const EXTERNAL_WAIT = /^(?:fetch|setTimeout|setInterval|sleep|delay)$|^(?:axios|http|https)\.(?:get|post|put|request|delete)$|^(?:exec|execFile|spawn)(?:Sync)?$/;
const SINK = /^(?:console|logger|log|telemetry|span|tracer)\.(?:log|info|warn|error|debug|trace|setAttribute|setAttributes|addEvent)$|^process\.(?:stdout|stderr)\.write$/;

function add(context: Context, rule: string, node: TS.Node, detail: string | null = null): void {
	const startOffset = node.getStart(context.sf), position = context.sf.getLineAndCharacterOfPosition(startOffset);
	context.findings.push({ rule, kind: CANDIDATES.has(rule) ? "semantic_candidate" : "ast_occurrence",
		line: position.line + 1, column: position.character + 1,
		endLine: context.sf.getLineAndCharacterOfPosition(Math.max(startOffset, node.end - 1)).line + 1,
		startOffset, endOffset: node.end, text: node.getText(context.sf).slice(0, 150), detail });
}

function modified(context: Context, node: TS.Node, kind: TS.SyntaxKind): boolean {
	return context.ts.canHaveModifiers(node) && !!context.ts.getModifiers(node)?.some(modifier => modifier.kind === kind);
}

function exportedDeclaration(context: Context, node: TS.Node): void {
	const { ts } = context;
	if (!modified(context, node, ts.SyntaxKind.ExportKeyword)) return;
	if (!(ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isVariableStatement(node))) return;
	add(context, "exported_declaration", node);
	if (!ts.getJSDocCommentsAndTags(node).length) add(context, "exported_without_jsdoc", node);
}

function declarationObservations(context: Context, node: TS.Node): void {
	const { ts } = context;
	exportedDeclaration(context, node);
	if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
		const booleans = node.members.filter(member => ts.isPropertySignature(member) && member.type?.kind === ts.SyntaxKind.BooleanKeyword);
		const optional = node.members.filter(member => ts.isPropertySignature(member) && !!member.questionToken);
		if (booleans.length >= 2 && optional.length) add(context, "boolean_state_bag_candidate", node, `${booleans.length} boolean members, ${optional.length} optional members`);
	}
	if (ts.isPropertyDeclaration(node) && !modified(context, node, ts.SyntaxKind.PrivateKeyword)
		&& !modified(context, node, ts.SyntaxKind.ProtectedKeyword) && !modified(context, node, ts.SyntaxKind.ReadonlyKeyword)
		&& !modified(context, node, ts.SyntaxKind.StaticKeyword) && !ts.isPrivateIdentifier(node.name)) add(context, "mutable_public_class_field", node);
	if (ts.isModuleDeclaration(node)) add(context, "typescript_namespace", node);
}

function typeObservations(context: Context, node: TS.Node): void {
	const { ts } = context;
	if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && node.type.getText(context.sf) !== "const") add(context, "type_assertion", node, node.type.getText(context.sf));
	if (node.kind === ts.SyntaxKind.AnyKeyword) add(context, "explicit_any", node);
	if (ts.isNonNullExpression(node)) add(context, "non_null_ast", node);
	if (ts.isTypeReferenceNode(node) && node.typeName.getText(context.sf) === "Partial") add(context, "partial_type", node);
	if (ts.isParameter(node) && node.type?.kind === ts.SyntaxKind.BooleanKeyword) add(context, "boolean_parameter", node);
}

function testingObservations(context: Context, node: TS.Node, name: string): void {
	if (/^(?:vi|jest)\.(?:mock|doMock|unstable_mockModule)$/.test(name)) add(context, "module_mock_call", node, name);
	if (/\.toHaveBeenCalled(?:With|Times|Once|ExactlyOnceWith)?$/.test(name)) add(context, "spy_assertion", node);
	if (/\.(?:toMatchSnapshot|toMatchInlineSnapshot|toThrowErrorMatchingSnapshot|toThrowErrorMatchingInlineSnapshot)$/.test(name)) add(context, "snapshot_assertion", node);
	if (/^(?:fc|fastCheck)\.(?:assert|check)$/.test(name)) add(context, "property_runner", node);
}

function parsingObservations(context: Context, node: TS.CallExpression | TS.NewExpression, name: string): void {
	const { ts } = context;
	if (name === "JSON.parse" || (name.endsWith(".json") && !node.arguments?.length)) add(context, "raw_json_parse", node, name);
	if (/\.safeParse(?:Async)?$/.test(name)) add(context, "fallible_schema_parse", node, name);
	if (!/\.safeParse(?:Async)?$|^(?:parse|validate|decode)[A-Z]/.test(name)) return;
	let parent: TS.Node = node;
	while (parent.parent && (ts.isAwaitExpression(parent.parent) || ts.isVoidExpression(parent.parent) || ts.isParenthesizedExpression(parent.parent))) parent = parent.parent;
	if (parent.parent && ts.isExpressionStatement(parent.parent)) add(context, "discarded_parser_syntax", node, name);
}

function sinkObservations(context: Context, node: TS.CallExpression | TS.NewExpression, name: string): void {
	if (/\b(?:Redacted|Secret)\.(?:value|unwrap|unsafeUnwrap)$/.test(name)) add(context, "secret_unwrap", node, name);
	if (!SINK.test(name)) return;
	add(context, "observability_sink", node, name);
	const symbols = new Set<string>();
	const visit = (child: TS.Node): void => {
		if (context.ts.isIdentifier(child) && /^(?:password|passwd|secret|apiKey|api_key|accessToken|access_token|authToken|auth_token|authorization|credentials|credential|token)$/i.test(child.text)) symbols.add(child.text);
		context.ts.forEachChild(child, visit);
	};
	for (const argument of node.arguments ?? []) visit(argument);
	if (symbols.size) add(context, "sensitive_sink_name_candidate", node, [...symbols].join(", "));
}

function transactionObservations(context: Context, node: TS.CallExpression | TS.NewExpression, name: string): void {
	if (!/\.transaction$|\b(?:withTransaction|inTransaction|dataTransaction|runVersionedMigration|transactionSync)$/.test(name)) return;
	add(context, "transaction_api_candidate", node, name);
	for (const callback of node.arguments ?? []) {
		if (!context.ts.isArrowFunction(callback) && !context.ts.isFunctionExpression(callback)) continue;
		const visit = (child: TS.Node): void => {
			if (context.ts.isCallExpression(child) && EXTERNAL_WAIT.test(expressionName(context, child.expression)) && executesAtModuleLoad(child, context, callback)) add(context, "transaction_external_effect_candidate", child, name);
			context.ts.forEachChild(child, visit);
		};
		visit(callback.body);
	}
}

function callObservations(context: Context, node: TS.CallExpression | TS.NewExpression): void {
	const { ts } = context, name = expressionName(context, node.expression);
	testingObservations(context, node, name);
	parsingObservations(context, node, name);
	sinkObservations(context, node, name);
	transactionObservations(context, node, name);
	if (/^(?:Date\.now|performance\.now|Math\.random|crypto\.randomUUID|randomUUID|randomBytes)$/.test(name)
		|| (ts.isNewExpression(node) && name === "Date" && !node.arguments?.length)) add(context, "ambient_clock_random", node, name);
	if (EFFECT.test(name) && executesAtModuleLoad(node, context)) add(context, "module_init_effect", node, name);
	if (ts.isCallExpression(node)) {
		for (const argument of node.arguments) if (argument.kind === ts.SyntaxKind.TrueKeyword || argument.kind === ts.SyntaxKind.FalseKeyword) add(context, "positional_boolean_argument", argument, name);
	}
}

function collectionObservations(context: Context, node: TS.Node): void {
	const { ts } = context;
	if (!ts.isVariableDeclaration(node) || !node.initializer || !executesAtModuleLoad(node, context)) return;
	let initializer = node.initializer;
	while (ts.isParenthesizedExpression(initializer) || ts.isAsExpression(initializer) || ts.isNonNullExpression(initializer)) initializer = initializer.expression;
	if (ts.isNewExpression(initializer) && /^(?:Map|Set|WeakMap|WeakSet)$/.test(initializer.expression.getText(context.sf))) add(context, "module_collection_state_candidate", node);
}

function valueImport(context: Context, node: TS.ImportDeclaration): boolean {
	const clause = node.importClause;
	if (!clause) return true;
	if (clause.isTypeOnly) return false;
	if (clause.name) return true;
	const bindings = clause.namedBindings;
	return !!bindings && (context.ts.isNamespaceImport(bindings) || bindings.elements.some(element => !element.isTypeOnly));
}

function remainingObservations(context: Context, node: TS.Node): void {
	const { ts } = context;
	if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && expressionName(context, node) === "process.env") add(context, "process_env_access", node);
	if (ts.isThrowStatement(node)) add(context, "throw_statement", node);
	if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(context, "reexport_declaration", node);
	if (ts.isImportDeclaration(node) && valueImport(context, node)) add(context, "value_import_declaration", node);
	collectionObservations(context, node);
}

/** Collect explicit AST patterns and labeled name-based candidates without interpreting policy compliance. */
export function scanStandardsSyntax(content: string, file: string, parser: typeof parseTsSource = parseTsSource): StandardsSyntax {
	const parsed = parser(content, file);
	if (!parsed) return { state: "unsupported", findings: [], notMeasured: ["Optional TypeScript parser unavailable"] };
	if (hasParseErrors(parsed.sf)) return { state: "inconclusive", findings: [], notMeasured: ["Complete JS/TS syntax unavailable"] };
	const context: Context = { ...parsed, findings: [] };
	const visit = (node: TS.Node): void => {
		declarationObservations(context, node);
		typeObservations(context, node);
		remainingObservations(context, node);
		if (context.ts.isCallExpression(node) || context.ts.isNewExpression(node)) callObservations(context, node);
		context.ts.forEachChild(node, visit);
	};
	visit(context.sf);
	return { state: "measured", findings: context.findings, notMeasured: [] };
}
