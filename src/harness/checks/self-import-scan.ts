// ===========================================
// Self-import detection — AST pass, or NOT MEASURED
// ===========================================
// `self_import` is a deterministic `pre_block` check, so a false NEGATIVE is a
// hard rail that quietly does not exist, and a false POSITIVE is a refused
// edit with no recourse. The pre-2026-09-05 implementation read specifiers ONE
// SOURCE LINE at a time, so an ordinary multiline declaration —
//
//   import {
//   	x
//   } from "./widget.js";
//
// inside `widget.ts` produced no finding at all (Finding 4 [P2], reviewer
// reproduced). A line is the wrong unit for a module reference; a declaration is
// the right one, so this module reads declarations off the TypeScript AST.
//
// `typescript` is an `optionalDependency` (the AST-accurate cyclomatic gate uses
// it the same way). `parseTsSource` in `cyclomatic-ast.ts` owns the synchronous
// `createRequire` load and returns null when the dep is absent. Under
// `--omit=optional` this check is NOT MEASURED: it reports no findings and says
// so — at daemon startup (`server.ts`) and per JS/TS edit
// (`selfImportNotMeasuredWarning`, carried by the pre-block gate). The line
// scanner that used to run in that state was retired 2026-09-05 (sixth review
// pass, finding 1): it missed the multiline shape above AND flagged
// `import alias = Existing.Namespace; // from "./widget.js"` on the strength of
// a trailing comment — both directions wrong, and a `pre_block` check may block
// on neither. A guess is not a measurement.
//
// The OTHER half of a self-import decision — which file a specifier names — is
// resolution, and it now runs the importer's OWN compiler: see
// `self-import-resolve.ts`. Two reviewed defects came out of trying to answer it
// with a table. Comparing extension-STEMS called `"./widget.mjs"` inside
// `widget.ts` a self-import (Finding 4 [P1]); the ordered candidate TABLE that
// replaced it could not see `compilerOptions`, so with
// `moduleSuffixes: [".native", ""]` and a sibling `widget.native.ts` it blocked
// `export { x } from "./widget.js"` — an import that names a different module
// (review finding 1 [P1], seventh pass). Resolution is now
// `ts.resolveModuleName` under the discovered tsconfig, and an unparsable
// tsconfig is NOT MEASURED rather than a guessed configuration.
//
// Split out of `agent-safety-deps.ts` (the parent, which keeps the exported
// `checkSelfImport` entry point): the AST pass does not fit under the 500-line
// per-file cap alongside the dependency-hygiene checks.

import type * as TS from "typescript";
import { astComplexityAvailable, parseTsSource, type TsModule } from "./cyclomatic-ast.js";
import {
	type ExistsProbe,
	selfImportDirectoryVisible,
	selfImportOptionsResolution,
	selfImportResolverFor,
} from "./self-import-resolve.js";
import { getExtension, type InlineMatch, JS_TS_EXTS } from "./shared.js";

// The resolution half is a module of its own; these are its public names, kept
// re-exported here because this module is the check's entry point.
export type { ExistsProbe } from "./self-import-resolve.js";
export { resolvesToSelf } from "./self-import-resolve.js";

/** Findings reported for one file. A self-import is a bug, not a census. */
const MAX_MATCHES = 5;

/** The finding for a declaration starting at `line` (1-based), carrying that
 *  line's trimmed text — the START of a multiline declaration, so the agent is
 *  pointed at the `import {`, not at the `} from "…"` three lines down. */
function findingAt(originalLines: string[], line: number): InlineMatch {
	return { line, text: (originalLines[line - 1] ?? "").trim().slice(0, 150) };
}

/** Every module specifier this node itself declares, or undefined when the node
 *  is not a module reference. Covers the five shapes a self-import can take:
 *  `import … from`, side-effect `import "x"`, `export … from` / `export * from`,
 *  `import x = require("x")`, and dynamic `import("x")` with a literal argument.
 *  A non-literal dynamic argument is deliberately skipped — it is not decidable
 *  here, and `pre_block` gets no guesses. */
function specifierOf(ts: TsModule, node: TS.Node): TS.StringLiteralLike | undefined {
	if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
		const spec = node.moduleSpecifier;
		return spec !== undefined && ts.isStringLiteralLike(spec) ? spec : undefined;
	}
	if (ts.isImportEqualsDeclaration(node)) {
		const ref = node.moduleReference;
		return ts.isExternalModuleReference(ref) && ts.isStringLiteralLike(ref.expression)
			? ref.expression
			: undefined;
	}
	if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
		const arg = node.arguments[0];
		return arg !== undefined && ts.isStringLiteralLike(arg) ? arg : undefined;
	}
	return undefined;
}

/**
 * AST pass: walk every node, collect the declarations whose specifier resolves
 * back to `filePath`, and report each one at its own starting line. The resolver
 * is built ONCE per file (options discovery, host, module mode), so a file with
 * thirty relative imports pays that setup once.
 */
function collectSelfImports(
	parsed: { ts: TsModule; sf: TS.SourceFile },
	content: string,
	resolves: (specifier: string, usage: TS.StringLiteralLike) => boolean,
): InlineMatch[] {
	const { ts, sf } = parsed;
	const originalLines = content.split("\n");
	const lines: number[] = [];

	const visit = (node: TS.Node): void => {
		const specifier = specifierOf(ts, node);
		if (specifier?.text.startsWith(".") === true && resolves(specifier.text, specifier)) {
			lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);

	// Source order: statements arrive in order, but a dynamic import nested in a
	// later statement's body can be visited before a sibling declaration's.
	lines.sort((a, b) => a - b);
	return lines.slice(0, MAX_MATCHES).map((line) => findingAt(originalLines, line));
}

/**
 * Report every module reference in `content` that resolves back to `filePath`,
 * or null when the check is NOT MEASURED — `typescript` is unresolvable, or the
 * tsconfig governing the file cannot be parsed. There is no second-best scan:
 * `null` is the whole answer, and the caller treats it as "no findings" plus a
 * disclosure, never as "clean".
 *
 * `exists` decides which sibling files the resolver can see; it defaults to the
 * real filesystem and is injectable so a test can describe a virtual tree.
 * `options` pins the compiler options instead of discovering them — the
 * differential test uses it to sweep configurations.
 */
export function scanSelfImports(
	content: string,
	filePath: string,
	exists?: ExistsProbe,
	options?: TS.CompilerOptions,
): InlineMatch[] | null {
	const parsed = parseTsSource(content, filePath);
	if (!parsed) return null;
	const resolves = selfImportResolverFor(filePath, exists, options);
	if (resolves === null) return null;
	return collectSelfImports(parsed, content, resolves);
}

/** True when the AST pass can run, i.e. `self_import` actually measures. The
 *  same probe the cyclomatic gate reports at daemon startup. */
export function selfImportMeasurable(): boolean {
	return astComplexityAvailable();
}

const NOT_MEASURED_PREFIX = "[interlinked:self_import] NOT MEASURED for ";

/**
 * The per-edit disclosure for a file `self_import` WOULD have scanned but
 * could not: null when the check is measurable or the file is outside its
 * extension set, otherwise one `[interlinked:self_import]` warning naming the
 * file, the cause, and the repair. Carried on the write-gate decision, so the
 * agent sees "not measured" on the edit itself rather than only in the daemon
 * log. THREE causes, because there are three ways to lose the measurement: no
 * compiler, no tree to resolve in, or no readable configuration to run it under.
 */
export function selfImportNotMeasuredWarning(filePath: string): string | null {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return null;
	if (!selfImportMeasurable()) {
		return (
			`${NOT_MEASURED_PREFIX}${filePath}: \`typescript\` is not resolvable, ` +
			"so the self-import pre-block check ran no scan (it never guesses from a line scanner). " +
			"A self-import in this edit was neither found nor cleared. Reinstall without " +
			"`--omit=optional` to restore it."
		);
	}
	if (!selfImportDirectoryVisible(filePath)) {
		return (
			`${NOT_MEASURED_PREFIX}${filePath}: its directory is not on disk yet, so module ` +
			"resolution had no tree to run in (it never invents one). A self-import in this edit was " +
			"neither found nor cleared; the check re-runs on the next edit, once the directory exists."
		);
	}
	const resolution = selfImportOptionsResolution(filePath);
	if (resolution === null || resolution.ok) return null;
	if (resolution.reason === "graph_truncated" || resolution.reason === "project_orphan") {
		return (
			`${NOT_MEASURED_PREFIX}${filePath}: ${resolution.detail}, so the owning project — and its ` +
			"compiler options — could not be established and module resolution did not run (it never " +
			"picks a project by guess). A self-import in this edit was neither found nor cleared. " +
			"List the file in its project's `files`/`include`, or shorten the reference graph, to restore it."
		);
	}
	if (resolution.reason === "project_ambiguous") {
		return (
			`${NOT_MEASURED_PREFIX}${filePath}: ${resolution.detail} (walked from ${resolution.configPath}), so no ` +
			"single set of compiler options governs it and module resolution did not run (it never picks " +
			"one project by guess). A self-import in this edit was neither found nor cleared. Make one " +
			"referenced project own the file to restore it."
		);
	}
	return (
		`${NOT_MEASURED_PREFIX}${filePath}: the governing TypeScript config ` +
		`(${resolution.configPath}, or a config it extends or references) could not be parsed, so module ` +
		"resolution could not run under this project's options (it never guesses a candidate list). " +
		"A self-import in this edit was neither found nor cleared. Repair that config to restore it."
	);
}
