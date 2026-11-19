// ===========================================
// Kill proof — static path resolution for the degenerate-test detector
// ===========================================
// Resolves a path-valued expression in a TEST file to a repo-relative POSIX path the
// way node would at run time: a bare literal is relative to process.cwd() (the
// project root, never the test file); `new URL(spec, import.meta.url)`,
// `require.resolve(spec)` and `import.meta.resolve(spec)` are test-relative;
// `join`/`resolve` glue segments, `+` and templates glue text; `__dirname`,
// `import.meta.dirname` name the test's directory; an identifier is followed to
// its `const` initializer (bounded depth). Anything dynamic resolves to null —
// UNCERTAIN, which the detector treats as silence. Also: which exports of a
// module are FUNCTIONS, so a coercion of an imported constant is not "source text".

import { posix } from "node:path";
import type * as TS from "typescript";
import type { loadTsModule } from "../mutation/differential-fuzz-deps.js";

export type Ts = NonNullable<ReturnType<typeof loadTsModule>>;

/** `moduleSpec`: came from a module resolver (compare without extension); `viaNodeModules`: the route went
 *  down into node_modules and back up — from a copy that is the LIVE tree. */
export interface ResolvedPath { path: string; moduleSpec: boolean; viaNodeModules: boolean; }

const MAX_BINDING_DEPTH = 4;
const plain = (path: string, extra: Partial<ResolvedPath> = {}): ResolvedPath => ({ path, moduleSpec: false, viaNodeModules: false, ...extra });
const isResolved = (p: ResolvedPath | null): p is ResolvedPath => p !== null;
const markRealpath = (p: ResolvedPath): ResolvedPath => ({ ...p, viaNodeModules: p.viaNodeModules || p.path.split("/").includes("node_modules") });

/** Unary path functions: the result is a function of the first argument's resolution. */
const UNARY: Record<string, (p: ResolvedPath) => ResolvedPath> = {
	dirname: p => ({ ...p, path: posix.dirname(p.path) }),
	fileURLToPath: p => p,
	normalize: p => p,
	toNamespacedPath: p => p,
	realpathSync: markRealpath,
	realpath: markRealpath,
	native: markRealpath,
};

/** `node_modules` followed later by `..`: the lexical route out of the copy into the live tree. */
function escapesViaNodeModules(raw: string): boolean {
	const segments = raw.split("/"), nm = segments.indexOf("node_modules");
	return nm >= 0 && segments.slice(nm + 1).includes("..");
}

export function calleeText(call: TS.CallExpression, sf: TS.SourceFile): string {
	return call.expression.getText(sf).replace(/\s+/g, "");
}

/** `readFileSync` / `fs.readFileSync` / `fs.promises.readFile` → the trailing name; null for a computed callee. */
export function calleeName(ts: Ts, call: TS.CallExpression): string | null {
	const callee = call.expression;
	if (ts.isIdentifier(callee)) return callee.text;
	return ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
}

/** `const x = <init>` anywhere in the file, first declaration wins. */
export function collectBindings(ts: Ts, root: TS.Node): Map<string, TS.Expression> {
	const bindings = new Map<string, TS.Expression>();
	const visit = (node: TS.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && !bindings.has(node.name.text)) bindings.set(node.name.text, node.initializer);
		ts.forEachChild(node, visit);
	};
	visit(root);
	return bindings;
}

export class PathResolver {
	constructor(
		private readonly ts: Ts,
		private readonly sf: TS.SourceFile,
		readonly testDir: string,
		private readonly bindings: ReadonlyMap<string, TS.Expression>,
	) {}

	/** Static resolution; null when any part is dynamic. */
	resolve(expr: TS.Expression, depth = 0): ResolvedPath | null {
		const { ts } = this;
		const node = this.unwrap(expr);
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return plain(posix.normalize(node.text));
		if (ts.isTemplateExpression(node)) return this.resolveTemplate(node, depth);
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return this.combine([this.resolve(node.left, depth), this.resolve(node.right, depth)], "");
		if (ts.isIdentifier(node)) return this.resolveIdentifier(node.text, depth);
		if (ts.isNewExpression(node)) return this.resolveUrl(node, depth);
		if (ts.isCallExpression(node)) return this.resolveCall(node, depth);
		return this.rootLike(node);
	}

	private unwrap(node: TS.Expression): TS.Expression {
		const { ts } = this;
		let current = node;
		while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) || ts.isAwaitExpression(current)) current = current.expression;
		return current;
	}

	/** Glue resolved parts with `sep` ("/" for join/resolve, "" for concatenation); null if any part is dynamic. */
	private combine(parts: readonly (ResolvedPath | null)[], sep: string): ResolvedPath | null {
		if (!parts.every(isResolved)) return null;
		const raw = parts.map(p => p.path).join(sep);
		return { path: posix.normalize(raw), moduleSpec: parts.some(p => p.moduleSpec), viaNodeModules: parts.some(p => p.viaNodeModules) || escapesViaNodeModules(raw) };
	}

	private resolveTemplate(node: TS.TemplateExpression, depth: number): ResolvedPath | null {
		const parts: (ResolvedPath | null)[] = [plain(node.head.text)];
		for (const span of node.templateSpans) parts.push(this.resolve(span.expression, depth), plain(span.literal.text));
		return this.combine(parts, "");
	}

	private resolveIdentifier(name: string, depth: number): ResolvedPath | null {
		if (name === "__dirname") return plain(this.testDir);
		if (name === "__filename") return plain(posix.join(this.testDir, "x"));
		const init = this.bindings.get(name);
		return init === undefined || depth >= MAX_BINDING_DEPTH ? null : this.resolve(init, depth + 1);
	}

	/** `import.meta.dirname` → test dir; `import.meta.url` / `.filename` → a file in it (so `dirname()` works). */
	private rootLike(node: TS.Node): ResolvedPath | null {
		const text = node.getText(this.sf).replace(/\s+/g, "");
		if (text === "import.meta.dirname") return plain(this.testDir);
		if (text === "import.meta.url" || text === "import.meta.filename") return plain(posix.join(this.testDir, "x"));
		return null;
	}

	/** `new URL(spec, base)`: spec relative to the base file's directory. */
	private resolveUrl(node: TS.NewExpression, depth: number): ResolvedPath | null {
		const { ts } = this;
		const [spec, base] = node.arguments ?? [];
		if (!ts.isIdentifier(node.expression) || node.expression.text !== "URL" || spec === undefined) return null;
		const specPath = this.resolve(spec, depth);
		if (specPath === null || base === undefined) return specPath;
		const basePath = this.resolve(base, depth);
		if (basePath === null) return null;
		const rel = ts.isStringLiteralLike(spec) ? spec.text : specPath.path;
		return plain(posix.normalize(posix.join(posix.dirname(basePath.path), rel)), { viaNodeModules: basePath.viaNodeModules });
	}

	/** A module specifier (`./x`, `../x`) resolved from the test's directory; compared without extension. */
	private resolveSpecifier(arg: TS.Expression | undefined): ResolvedPath | null {
		const { ts } = this;
		if (arg === undefined || !ts.isStringLiteralLike(arg) || !(arg.text.startsWith("./") || arg.text.startsWith("../"))) return null;
		return plain(posix.normalize(posix.join(this.testDir, arg.text)), { moduleSpec: true });
	}

	private resolveCall(call: TS.CallExpression, depth: number): ResolvedPath | null {
		const text = calleeText(call, this.sf);
		if (text === "require.resolve" || text === "import.meta.resolve") return this.resolveSpecifier(call.arguments[0]);
		if (text === "process.cwd") return plain(".");
		const name = calleeName(this.ts, call), first = call.arguments[0];
		if (name === "join" || name === "resolve") return this.combine(call.arguments.map(a => this.resolve(a, depth)), "/");
		const unary = name === null ? undefined : UNARY[name];
		if (unary === undefined || first === undefined) return null;
		const inner = this.resolve(first, depth);
		return inner === null ? null : unary(inner);
	}
}

// ---- which exports of the mutated module are functions ----------------------

const hasModifier = (ts: Ts, node: TS.Node, kind: TS.SyntaxKind): boolean =>
	ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(m => m.kind === kind);
const isFnInit = (ts: Ts, init: TS.Expression | undefined): boolean =>
	init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isClassExpression(init));

type NamedFunction = [name: string, exported: boolean];

function declaredFunctions(ts: Ts, stmt: TS.Statement): NamedFunction[] {
	const exported = hasModifier(ts, stmt, ts.SyntaxKind.ExportKeyword);
	if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
		const name = hasModifier(ts, stmt, ts.SyntaxKind.DefaultKeyword) ? "default" : stmt.name?.text;
		return name === undefined ? [] : [[name, exported]];
	}
	if (!ts.isVariableStatement(stmt)) return [];
	return stmt.declarationList.declarations.flatMap((d): NamedFunction[] => (ts.isIdentifier(d.name) && isFnInit(ts, d.initializer) ? [[d.name.text, exported]] : []));
}

/** `export { f, g as h }` of locally declared functions, and `export default f` / `export default () => …`. */
function reexportedFunctions(ts: Ts, stmt: TS.Statement, declared: ReadonlySet<string>): string[] {
	if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause) && stmt.moduleSpecifier === undefined) {
		return stmt.exportClause.elements.filter(el => declared.has((el.propertyName ?? el.name).text)).map(el => el.name.text);
	}
	if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
		const fn = ts.isIdentifier(stmt.expression) ? declared.has(stmt.expression.text) : isFnInit(ts, stmt.expression);
		return fn ? ["default"] : [];
	}
	return [];
}

/** Exported names a module declares as functions or classes. */
export function functionExportsOf(ts: Ts, sf: TS.SourceFile): Set<string> {
	const declared = new Set<string>(), exported = new Set<string>();
	for (const stmt of sf.statements) {
		for (const [name, isExport] of declaredFunctions(ts, stmt)) (isExport ? exported : declared).add(name);
		for (const name of reexportedFunctions(ts, stmt, declared)) exported.add(name);
	}
	return exported;
}
