// Enclosing-scope declared-type lookup for the exhaustiveness check.
//
// Given an identifier reference, walk outward through enclosing
// parameter/variable scopes to find where its type was declared. AST-only —
// no type checker — so only inline type annotations are found.

type TsModule = typeof import("typescript");

/**
 * Walk up from `ident` to find a parameter/variable declaration with a type.
 * Each enclosing scope is checked for a matching parameter first, then a
 * matching variable declaration — the two searches are extracted below
 * because the node kinds they match are mutually exclusive (a node is never
 * both a function-like and a block/source-file/module-block), so trying both
 * per scope and taking whichever hits reproduces the original nested-if
 * behavior exactly.
 */
export function findDeclaredTypeForIdentifier(
	ts: TsModule,
	ident: import("typescript").Identifier,
): import("typescript").TypeNode | null {
	const name = ident.text;
	// TS's own `.d.ts` declares `Node.parent` as non-optional (`Node`), but at
	// runtime the root `SourceFile` node (and any unbound synthetic node) has
	// `parent === undefined` — the declared type lies. Widen it back to
	// `Node | undefined` here so the loop guard below stays real.
	// SAFETY: correcting a known-inaccurate .d.ts type, not suppressing a
	// real type error — `parent` really can be undefined at the AST root.
	let current = ident.parent as import("typescript").Node | undefined;
	while (current) {
		const paramType = findParamType(ts, current, name);
		if (paramType) return paramType;
		const varType = findVarType(ts, current, name);
		if (varType) return varType;
		current = current.parent;
	}
	return null;
}

/**
 * Node kinds `findDeclaredTypeForIdentifier` treats as a parameter scope: any
 * function-like declaration whose parameter list may declare `name`.
 */
type ParamScopeNode =
	| import("typescript").FunctionDeclaration
	| import("typescript").FunctionExpression
	| import("typescript").ArrowFunction
	| import("typescript").MethodDeclaration
	| import("typescript").ConstructorDeclaration
	| import("typescript").GetAccessorDeclaration
	| import("typescript").SetAccessorDeclaration;

function isParamScopeNode(
	ts: TsModule,
	node: import("typescript").Node,
): node is ParamScopeNode {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	);
}

/** Search a function-like node's own parameter list for `name`'s declared type. */
function findParamType(
	ts: TsModule,
	node: import("typescript").Node,
	name: string,
): import("typescript").TypeNode | null {
	if (!isParamScopeNode(ts, node)) return null;
	for (const param of node.parameters) {
		if (ts.isIdentifier(param.name) && param.name.text === name && param.type) {
			return param.type;
		}
	}
	return null;
}

/**
 * Node kinds `findDeclaredTypeForIdentifier` treats as a variable-statement
 * scope: block bodies, module (namespace) bodies, and the source file itself.
 */
type StatementScopeNode =
	| import("typescript").Block
	| import("typescript").SourceFile
	| import("typescript").ModuleBlock;

function isStatementScopeNode(
	ts: TsModule,
	node: import("typescript").Node,
): node is StatementScopeNode {
	return ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node);
}

/** Search a block/module/source-file's own statement list for `name`'s declared type. */
function findVarType(
	ts: TsModule,
	node: import("typescript").Node,
	name: string,
): import("typescript").TypeNode | null {
	if (!isStatementScopeNode(ts, node)) return null;
	for (const stmt of node.statements) {
		if (!ts.isVariableStatement(stmt)) continue;
		for (const decl of stmt.declarationList.declarations) {
			if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.type) {
				return decl.type;
			}
		}
	}
	return null;
}
