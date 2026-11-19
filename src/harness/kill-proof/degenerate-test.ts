// ===========================================
// Kill proof — degenerate killing tests (docs/reviews/kill-proof-gaming.md)
// ===========================================
// CLASS: a test that produces a `killed` verdict without exercising the mutated
// behaviour. prove-kill judges "failed by its own check under the mutant"; a test
// that reads the mutated file as TEXT (`readFileSync` of a path resolving to it),
// snapshots or hashes that text, or asserts on `fn.toString()` of an import from
// the mutated module fails on ANY byte change — the lexeme gate, not the behaviour.
// Once the receipt is a training signal that is the optimal policy (CLAUDE.md:
// "once gates are a training signal, gaming them is the optimal policy").
//
// FIRES WHEN (every rule needs the MUTATED file's identity — the same test is not
// degenerate for a mutant in a module it never reads):
//   k1 `source-read`     a file-content read whose path resolves to the mutated file
//                        (`degenerate-test-paths.ts`: literal, `new URL(…, import.meta.url)`,
//                        `join`/`resolve` over `process.cwd()` / `__dirname` /
//                        `import.meta.dirname`, `+` or template concatenation,
//                        `require.resolve` / `import.meta.resolve`, or a bound identifier);
//                        also every `expect(<value derived from that read>)`.
//   k2 `source-snapshot` `expect(<derived>).toMatch*Snapshot(…)`.
//   k3 `source-hash`     `expect(<createHash/digest/sha… over the read>)`.
//   k4 `function-source` `.toString()` / `String()` / template or `+ ""` coercion /
//                        `Function.prototype.toString.call` on an import from the mutated
//                        module that IS a function (declared so in `mutatedContent`, or
//                        called as one in the test; an interpolated constant is a value).
//   k5 `live-tree-read`  the read path escapes the copy through `node_modules/..`
//                        (`realpathSync(node_modules)` and back up): the LIVE twin.
//   k6 `vcs-probe`       `git diff|status|show|log|stash|ls-files` spawned with no `-C`
//                        and no `cwd` option: a probe of the project's own work tree.
// DOES NOT FIRE: a read of a fixture, a snapshot, or any file that is not the mutated
// one; a `toMatchSnapshot` of a function RESULT; spawning the CLI under test or `git`
// with `-C <fixture>`; an import from the mutated module that is CALLED (that is the
// behavioural test); `fn.name` / `fn.length` / `Object.keys(module)` (shape, not source;
// such a test survives a body mutant anyway); a read through a dynamic path the AST
// cannot resolve (UNCERTAIN ⇒ silent: a block-grade signal must not guess).
// CALIBRATION: repo census in the review doc (first cut: 92/92 `function-source` hits
// were interpolated constants — hence the function-kind evidence). KNOWN GAPS: a path
// assembled at runtime (`readdirSync` + filter, `glob`), a helper module that reads the
// file for the test, `statSync(...).size`, a read of a BUILT twin (`dist/x.js`), the
// `.interlinked/` state (not in the copy: the product defeats it), an even-run counter
// outside the copy (no static trace). HOW TO EXTEND: a resolver arm in
// `PathResolver.resolve`, a kind here, and a P/N pair in `degenerate-test.test.ts`.
//
// Pure: (test content, test path, mutated path[, mutated source]) → findings.
// NOT wired into the verdict (a product decision; see the doc's recommendation).

import { posix } from "node:path";
import type * as TS from "typescript";
import { parseTsSourceWith } from "../checks/cyclomatic-ast.js";
import { loadTsModule } from "../mutation/differential-fuzz-deps.js";
import { calleeName, calleeText, collectBindings, functionExportsOf, PathResolver, type ResolvedPath, type Ts } from "./degenerate-test-paths.js";

export type DegenerateKind = "source-read" | "source-snapshot" | "source-hash" | "function-source" | "live-tree-read" | "vcs-probe";

export interface DegenerateFinding {
	/** 1-based line of the read / assertion / spawn. */
	line: number;
	kind: DegenerateKind;
	/** What the rule saw, for the receipt / nudge line. */
	detail: string;
}

export interface DegenerateInput {
	/** The test file's source. */
	content: string;
	/** Repo-relative POSIX path of the test file. */
	testPath: string;
	/** Repo-relative POSIX path of the mutated source file. */
	mutatedFile: string;
	/** The mutated module's source, when the caller has it (prove-kill does): decides which of its exports are
	 *  FUNCTIONS. Absent, only a binding the test itself CALLS counts as a function. */
	mutatedContent?: string;
}

const READ_FUNCTIONS = new Set(["readFileSync", "readFile", "createReadStream", "openSync", "open", "readSync"]);
const FS_OBJECTS = /^(?:fs|fsp|promises|fsPromises|node_fs|nodeFs)$/i;
const SNAPSHOT_MATCHERS = new Set(["toMatchSnapshot", "toMatchInlineSnapshot", "toMatchFileSnapshot", "toThrowErrorMatchingSnapshot", "toThrowErrorMatchingInlineSnapshot"]);
const HASH_NAMES = /^(?:createHash|createHmac|digest|sha\d*|md5|hash|checksum)$/i;
const SPAWN_FUNCTIONS = new Set(["execSync", "execFileSync", "spawnSync", "exec", "execFile", "spawn", "execa", "execaSync"]);
const GIT_PROBES = new Set(["diff", "status", "show", "log", "stash", "ls-files"]);
const EXT_RE = /\.(?:[cm]?[jt]sx?)$/;

/** Available only with the optional `typescript` dependency; false = NOT MEASURED, never "no findings". */
export function degenerateDetectorAvailable(): boolean {
	return loadTsModule() !== null;
}

/** `../src/math` ≡ `src/math.ts` ≡ `src/math.js` (ESM specifiers name the emitted file). */
const sameModule = (a: string, b: string): boolean => a.replace(EXT_RE, "") === b.replace(EXT_RE, "");

/** `import d, { a as b } from …` / `import * as ns from …` → local name → exported name ("*" for a namespace). */
function bindImportClause(ts: Ts, clause: TS.ImportClause, out: Map<string, string>): void {
	const bindings = clause.namedBindings;
	if (clause.name) out.set(clause.name.text, "default");
	if (bindings && ts.isNamespaceImport(bindings)) out.set(bindings.name.text, "*");
	if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) out.set(el.name.text, (el.propertyName ?? el.name).text);
}

/** Local import names bound to the mutated module → exported name. */
function importBindingsOf(ts: Ts, sf: TS.SourceFile, namesMutated: (spec: string) => boolean): Map<string, string> {
	const out = new Map<string, string>();
	for (const stmt of sf.statements) {
		if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier) || !namesMutated(stmt.moduleSpecifier.text)) continue;
		if (stmt.importClause) bindImportClause(ts, stmt.importClause, out);
	}
	return out;
}

class Analyzer {
	private readonly mutated: string;
	private readonly paths: PathResolver;
	private readonly imports: Map<string, string>;
	/** Exported names the mutated module declares as functions/classes; null = unknown (no content given). */
	private readonly functionExports: Set<string> | null;
	/** Import keys (`add`, `m.add`) the test file CALLS — evidence the binding is a function. */
	private readonly called = new Set<string>();
	/** Identifiers whose value derives from a read of the mutated file. */
	private readonly tainted = new Set<string>();
	readonly findings: DegenerateFinding[] = [];

	constructor(private readonly ts: Ts, private readonly sf: TS.SourceFile, testPath: string, mutatedFile: string, mutatedContent: string | undefined) {
		this.mutated = posix.normalize(mutatedFile);
		const bindings = collectBindings(ts, sf);
		this.paths = new PathResolver(ts, sf, posix.dirname(testPath), bindings);
		this.imports = importBindingsOf(ts, sf, spec => this.specifierNamesMutated(spec));
		for (const [name, init] of bindings) if (this.isRequireOfMutated(init)) this.imports.set(name, "*");
		this.functionExports = mutatedContent === undefined ? null : functionExportsOf(ts, parseTsSourceWith(ts, mutatedContent, mutatedFile));
		this.collectCalls(sf);
	}

	run(): DegenerateFinding[] {
		this.walk(this.sf);
		return this.findings.sort((a, b) => a.line - b.line);
	}

	private push(node: TS.Node, kind: DegenerateKind, detail: string): void {
		const line = this.sf.getLineAndCharacterOfPosition(node.getStart(this.sf)).line + 1;
		if (!this.findings.some(f => f.line === line && f.kind === kind)) this.findings.push({ line, kind, detail });
	}

	// ---- imports from the mutated module ----------------------------------

	private specifierNamesMutated(spec: string): boolean {
		if (!spec.startsWith("./") && !spec.startsWith("../")) return false;
		return sameModule(posix.normalize(posix.join(this.paths.testDir, spec)), this.mutated);
	}

	private isRequireOfMutated(init: TS.Expression): boolean {
		const { ts } = this;
		const call = ts.isAwaitExpression(init) ? init.expression : init;
		if (!ts.isCallExpression(call) || calleeName(ts, call) !== "require") return false;
		const arg = call.arguments[0];
		return arg !== undefined && ts.isStringLiteral(arg) && this.specifierNamesMutated(arg.text);
	}

	private collectCalls(node: TS.Node): void {
		if (this.ts.isCallExpression(node)) {
			const key = this.importKey(node.expression);
			if (key !== null) this.called.add(key);
		}
		this.ts.forEachChild(node, child => this.collectCalls(child));
	}

	/** `add` or `m.add` when bound to an import from the mutated module. */
	private importKey(node: TS.Expression): string | null {
		const { ts } = this;
		if (ts.isIdentifier(node) && this.imports.has(node.text)) return node.text;
		if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && this.imports.get(node.expression.text) === "*") return `${node.expression.text}.${node.name.text}`;
		return null;
	}

	/** The import key when the expression is an imported FUNCTION: declared so in the module, or called here. */
	private importedFunction(node: TS.Expression): string | null {
		const key = this.importKey(node);
		if (key === null) return null;
		if (this.called.has(key)) return key;
		if (this.functionExports === null) return null;
		const [local = "", member] = key.split(".");
		const exported = member ?? this.imports.get(local);
		return exported !== undefined && this.functionExports.has(exported) ? key : null;
	}

	// ---- reads of the mutated file ------------------------------------------

	/** A content read whose first argument resolves to the mutated file. */
	private readOfMutated(call: TS.CallExpression): ResolvedPath | null {
		const { ts } = this;
		const name = calleeName(ts, call), first = call.arguments[0];
		if (name === null || !READ_FUNCTIONS.has(name) || first === undefined) return null;
		const object = ts.isPropertyAccessExpression(call.expression) ? call.expression.expression.getText(this.sf).split(".")[0] ?? "" : "";
		if (object !== "" && !FS_OBJECTS.test(object)) return null;
		const resolved = this.paths.resolve(first);
		if (resolved === null) return null;
		const path = resolved.path.replace(/^\.\//, "");
		const same = resolved.moduleSpec ? sameModule(path, this.mutated) : path === this.mutated;
		return same ? resolved : null;
	}

	private contains(node: TS.Node, predicate: (n: TS.Node) => boolean): boolean {
		if (predicate(node)) return true;
		let found = false;
		this.ts.forEachChild(node, child => {
			if (!found && this.contains(child, predicate)) found = true;
		});
		return found;
	}

	/** True when the expression contains a read of the mutated file or a tainted identifier. */
	private derivesFromRead(node: TS.Node): boolean {
		const { ts } = this;
		return this.contains(node, n => (ts.isIdentifier(n) && this.tainted.has(n.text)) || (ts.isCallExpression(n) && this.readOfMutated(n) !== null));
	}

	private mentionsHash(node: TS.Node): boolean {
		return this.contains(node, n => this.ts.isIdentifier(n) && HASH_NAMES.test(n.text));
	}

	// ---- rules ------------------------------------------------------------

	private isExpectCall(node: TS.Node): node is TS.CallExpression {
		return this.ts.isCallExpression(node) && this.ts.isIdentifier(node.expression) && node.expression.text === "expect";
	}

	/** `expect(subject)…matcher(…)`: the subject's provenance decides the kind. */
	private checkAssertion(call: TS.CallExpression): void {
		const { ts } = this;
		if (!ts.isPropertyAccessExpression(call.expression)) return;
		const matcher = call.expression.name.text;
		let subject: TS.Node = call.expression.expression;
		while (ts.isPropertyAccessExpression(subject) || (ts.isCallExpression(subject) && !this.isExpectCall(subject))) subject = subject.expression;
		const arg = this.isExpectCall(subject) ? subject.arguments[0] : undefined;
		if (arg === undefined || !this.derivesFromRead(arg)) return;
		if (SNAPSHOT_MATCHERS.has(matcher)) this.push(call, "source-snapshot", `${matcher} of the mutated file's source text`);
		else if (this.mentionsHash(arg) || this.mentionsHash(call)) this.push(call, "source-hash", "assertion on a digest of the mutated file's bytes");
		else this.push(call, "source-read", `assertion (${matcher}) on the mutated file's source text`);
	}

	/** `x.toString()`, `String(x)`, `Function.prototype.toString.call(x)` on an imported function → [key, form]. */
	private callCoercion(call: TS.CallExpression): [string, string] | null {
		const { ts } = this;
		const callee = call.expression, arg = call.arguments[0];
		if (ts.isPropertyAccessExpression(callee) && callee.name.text === "toString") {
			const key = this.importedFunction(callee.expression);
			return key === null ? null : [key, `${key}.toString()`];
		}
		if (arg === undefined) return null;
		const text = calleeText(call, this.sf);
		const key = text === "String" || text === "Function.prototype.toString.call" ? this.importedFunction(arg) : null;
		return key === null ? null : [key, `${text}(${key})`];
	}

	/** `` `${x}` `` and `x + ""` / `"" + x` on an imported function. */
	private textCoercion(node: TS.Node): [string, string] | null {
		const { ts } = this;
		if (ts.isTemplateExpression(node)) {
			for (const span of node.templateSpans) {
				const key = this.importedFunction(span.expression);
				if (key !== null) return [key, `\`\${${key}}\``];
			}
			return null;
		}
		if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return null;
		const operands = [node.left, node.right];
		const other = operands.find(n => !ts.isStringLiteralLike(n));
		const key = other === undefined || operands.every(n => !ts.isStringLiteralLike(n)) ? null : this.importedFunction(other);
		return key === null ? null : [key, `${key} + ""`];
	}

	private checkFunctionSource(node: TS.Node): void {
		const hit = this.ts.isCallExpression(node) ? this.callCoercion(node) : this.textCoercion(node);
		if (hit !== null) this.push(node, "function-source", `${hit[1]} — the source text of an import from the mutated module`);
	}

	/** `git diff|status|…` spawned against the project's own tree (no `-C`, no `cwd`). */
	private checkVcsProbe(call: TS.CallExpression): void {
		const { ts } = this;
		const name = calleeName(ts, call);
		const [cmd, rest, opts] = call.arguments;
		if (name === null || !SPAWN_FUNCTIONS.has(name) || cmd === undefined || !ts.isStringLiteralLike(cmd)) return;
		const words = cmd.text.trim().split(/\s+/);
		if (words[0] !== "git") return;
		if (rest !== undefined && ts.isArrayLiteralExpression(rest)) words.push(...rest.elements.map(el => (ts.isStringLiteralLike(el) ? el.text : "?")));
		const sub = words.slice(1).find(w => !w.startsWith("-") && w !== "?");
		if (words.includes("-C") || sub === undefined || !GIT_PROBES.has(sub)) return;
		const options = [rest, opts].find((a): a is TS.ObjectLiteralExpression => a !== undefined && ts.isObjectLiteralExpression(a));
		if (options?.properties.some(p => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === "cwd")) return;
		this.push(call, "vcs-probe", `git ${sub} run against the project's own work tree`);
	}

	private checkRead(call: TS.CallExpression): void {
		const read = this.readOfMutated(call);
		if (read === null) return;
		const fn = calleeName(this.ts, call);
		if (read.viaNodeModules) this.push(call, "live-tree-read", `${fn} of the mutated file through node_modules/.. (the live, unmutated twin)`);
		else this.push(call, "source-read", `${fn} of the mutated file ${this.mutated}`);
	}

	private walk(node: TS.Node): void {
		const { ts } = this;
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && this.derivesFromRead(node.initializer)) this.tainted.add(node.name.text);
		if (ts.isCallExpression(node)) {
			this.checkRead(node);
			this.checkAssertion(node);
			this.checkVcsProbe(node);
		}
		this.checkFunctionSource(node);
		ts.forEachChild(node, child => this.walk(child));
	}
}

/**
 * Findings for ONE (test file, mutated file) pair. An empty array with the `typescript`
 * dependency absent means NOT MEASURED — check `degenerateDetectorAvailable()` first.
 */
export function detectDegenerateKillTest(input: DegenerateInput): DegenerateFinding[] {
	const ts = loadTsModule();
	if (ts === null) return [];
	const testPath = posix.normalize(input.testPath.replace(/\\/g, "/"));
	const mutated = input.mutatedFile.replace(/\\/g, "/").replace(/^\.\//, "");
	return new Analyzer(ts, parseTsSourceWith(ts, input.content, testPath), testPath, mutated, input.mutatedContent).run();
}

/** The one-line nudge a receipt or PostToolUse surface would print; null when clean. */
export function formatDegenerateFindings(testPath: string, findings: readonly DegenerateFinding[]): string | null {
	const first = findings[0];
	if (first === undefined) return null;
	const kinds = [...new Set(findings.map(f => f.kind))].join(", ");
	return `[interlinked:kill-proof] ${testPath}: this killing test reads the mutated SOURCE rather than exercising it (${kinds}; ${testPath}:${first.line} ${first.detail}) — a kill by lexeme, not by behaviour`;
}
