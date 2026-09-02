// ===========================================
// dead_exports (generic variant) — with an evidence guard
// ===========================================
// Flags named exports no other file imports. Extracted from
// agent-safety-advanced.ts (at the line cap) to fix a live false-positive
// storm (mcp-client-bio, 2026-07-28): the detector flagged symbols that WERE
// imported — `describeUpstreamError` by two siblings, `registerSearch` by the
// package entry point — because a resolver miss made every comparison fail and
// the detector then flagged the file's entire surface.
//
// Three lessons are encoded here:
//   1. `.js` specifiers name `.ts` sources in ESM TypeScript, so path
//      comparison is EXTENSION-BLIND (the same class of bug this repo fixed in
//      mutation/local-deps.ts the same day).
//   2. `export … from` re-exports are consumption. A barrel republishing a
//      symbol makes its true consumers unknowable from here — a wildcard
//      re-export marks everything used.
//   3. THE EVIDENCE GUARD: if other files mention this module's basename but
//      not one of their edges resolves to it, the resolver — not their code —
//      is the likely failure. A heuristic with no evidence says nothing;
//      "genuinely orphaned" (nobody even mentions it) still reports.

import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { parseExports } from "../project-graph.js";
import { getGitSourceFiles } from "./export-ripple.js";
import { getExtension, type InlineMatch, isTestFile } from "./shared.js";

/** Injectable repo view so tests need neither git nor a real filesystem. */
export interface DeadExportsRepo {
	/** Repo-relative source files (the candidate importer set). */
	listFiles: () => string[];
	/** Contents by repo-relative path, or null when unreadable. */
	readFile: (relPath: string) => string | null;
}

export interface DeadExportsArgs {
	content: string;
	filePath: string;
	cwd?: string;
	/** Restrict the report to these export names. A delta caller (the
	 *  helper-hygiene check) names the exports one edit introduced, so the
	 *  MAX_FLAGGED cap counts only them and a file already carrying ten dead
	 *  exports cannot truncate the new one out of the result. */
	only?: ReadonlySet<string>;
}

const EXPORTABLE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const MAX_FLAGGED = 10;

/** `import`/`export … from` edges in one importer, named symbols + wildcards. */
const EDGE_RE =
	/\b(?:import|export)\s+(?:type\s+)?(\*(?:\s+as\s+\w+)?|\{[^}]*\}|[\w$]+(?:\s*,\s*\{[^}]*\})?)\s+from\s+["']([^"']+)["']/g;

/** The comparison key both sides reduce to: no extension, no trailing /index. */
function pathKey(p: string): string {
	return p.replace(/\.(?:[cm]?[jt]sx?|d\.ts)$/, "").replace(/\/index$/, "");
}

/** Original (pre-`as`) names from an import/export clause; "*" for wildcard. */
function symbolsOf(clause: string): string[] {
	if (clause.startsWith("*")) return ["*"];
	const inner = clause.match(/\{([^}]*)\}/)?.[1] ?? "";
	const named = inner
		.split(",")
		// `import { type Foo }` consumes Foo just as `import type { Foo }` does —
		// strip the inline specifier keyword or the consumption is invisible.
		.map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "")
		.filter((s) => s !== "");
	// A bare default-import clause consumes only `default`, which this detector
	// never flags — contribute nothing rather than a fake name.
	return named;
}

interface EdgeScan {
	mentions: number;
	resolvedEdges: number;
	allUsed: boolean;
	symbols: Set<string>;
}

/** Walk every candidate importer, collecting the symbols that resolve to us. */
function scanImporters(repo: DeadExportsRepo, selfRel: string, targetKey: string): EdgeScan {
	const base = basename(selfRel).replace(/\.[^.]*$/, "");
	const scan: EdgeScan = { mentions: 0, resolvedEdges: 0, allUsed: false, symbols: new Set() };
	for (const rel of repo.listFiles()) {
		if (rel === selfRel) continue;
		const content = repo.readFile(rel);
		if (content === null || !content.includes(base)) continue;
		scan.mentions++;
		collectEdges(content, rel, targetKey, scan);
		if (scan.allUsed) return scan;
	}
	return scan;
}

/** `import("spec")` / `require("spec")` — namespace access with no named
 *  clause, so a resolving edge marks the whole module consumed (this also
 *  covers `import("./mod").Foo` in type positions and lazy runtime loads). */
const DYNAMIC_EDGE_RE = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

function edgeResolvesTo(spec: string, importerRel: string, targetKey: string): boolean {
	if (!spec.startsWith(".")) return false;
	const resolved = pathKey(resolve("/", dirname(importerRel), spec)).replace(/^\/+/, "");
	return resolved === targetKey;
}

function collectEdges(content: string, importerRel: string, targetKey: string, scan: EdgeScan): void {
	EDGE_RE.lastIndex = 0;
	for (const m of content.matchAll(EDGE_RE)) {
		if (!edgeResolvesTo(m[2] ?? "", importerRel, targetKey)) continue;
		scan.resolvedEdges++;
		const syms = symbolsOf(m[1] ?? "");
		if (syms.includes("*")) {
			scan.allUsed = true;
			return;
		}
		for (const s of syms) scan.symbols.add(s);
	}
	DYNAMIC_EDGE_RE.lastIndex = 0;
	for (const m of content.matchAll(DYNAMIC_EDGE_RE)) {
		if (!edgeResolvesTo(m[1] ?? "", importerRel, targetKey)) continue;
		scan.resolvedEdges++;
		scan.allUsed = true;
		return;
	}
}

/** How far above an export a doc comment may sit and still cover it. */
const DOC_COMMENT_LOOKBACK_LINES = 12;

/** The documenting escape the finding text has always promised ("remove or
 *  document as public API"): a comment in the contiguous block directly above
 *  the export that says "public API" (any case) marks it deliberate. */
function hasPublicApiComment(lines: string[], exportLine: number): boolean {
	let walked = 0;
	for (let i = exportLine - 2; i >= 0 && walked < DOC_COMMENT_LOOKBACK_LINES; i--, walked++) {
		const text = lines[i]?.trim() ?? "";
		const isComment =
			text.startsWith("//") || text.startsWith("*") || text.startsWith("/*") || text === "*/";
		if (!isComment) return false;
		if (/public\s+api/i.test(text)) return true;
	}
	return false;
}

/**
 * The remedy fork the finding text carries. An unused export whose symbol is
 * still referenced inside its own file needs only the `export` keyword removed
 * (behavior-neutral); one with no references anywhere is a deletion candidate.
 * The distinction matters: 79% of real findings measured on this tree
 * (96/122, 2026-09-01) were the un-export class.
 */
function remedyFor(content: string, name: string): string {
	const wordRe = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
	let occurrences = 0;
	for (const _m of content.matchAll(wordRe)) occurrences++;
	// One occurrence is the declaration itself; a separate `export { name }`
	// clause adds a second occurrence that is also not a real use.
	let baseline = 1;
	const clauseRe = new RegExp(`export\\s+(?:type\\s+)?\\{[^}]*\\b${name}\\b[^}]*\\}`);
	if (clauseRe.test(content)) baseline++;
	return occurrences > baseline
		? `unused export '${name}' (still used inside this file) — remove the export keyword, or document as public API`
		: `unused export '${name}' (no references anywhere) — delete the declaration, or document as public API`;
}

/** Whole-file exclusions: unsupported extension, declaration file, test file,
 *  or barrel (`index`, intentionally wide). Checked before anything else is
 *  parsed. */
function isExcludedFile(filePath: string): boolean {
	const ext = getExtension(filePath);
	if (!EXPORTABLE_EXT.includes(ext)) return true;
	if (filePath.endsWith(".d.ts")) return true;
	if (isTestFile(filePath)) return true;
	const base = basename(filePath).replace(/\.[^.]*$/, "");
	return base === "index"; // barrel — intentionally wide
}

/** The candidate exports for one lane (value or type-only), pre-filtered to
 *  the kinds this detector can ever flag and to the caller's `only` set. */
function candidateExports(args: DeadExportsArgs, wantTypeOnly: boolean) {
	return parseExports(args.content).filter(
		(e) =>
			e.kind !== "default" &&
			e.kind !== "re-export" &&
			e.kind !== "namespace" &&
			e.isTypeOnly === wantTypeOnly &&
			(args.only === undefined || args.only.has(e.name)),
	);
}

/** Resolve `filePath` to a repo-relative path and scan every candidate
 *  importer for edges into it. Returns null when the whole-file result is
 *  already decided (outside the project root, or every use is accounted
 *  for) — the caller should report no findings in that case. */
function resolveAndScan(args: DeadExportsArgs, repo: DeadExportsRepo): EdgeScan | null {
	const cwd = args.cwd ?? "";
	const selfRel = isAbsolute(args.filePath) ? relative(cwd || "/", args.filePath) : args.filePath;
	// A file OUTSIDE the project root has no candidate importers here, so "no
	// one imports it" would be vacuously true — say nothing instead. (Guard
	// carried over from the pre-extraction detector; its tests pin it.)
	if (selfRel.startsWith("..")) return null;
	const scan = scanImporters(repo, selfRel, pathKey(selfRel));
	if (scan.allUsed) return null;
	// The evidence guard (lesson 3): mentioned but never resolved ⇒ our
	// resolution failed somewhere, so silence beats a page of false debt.
	if (scan.mentions > 0 && scan.resolvedEdges === 0) return null;
	return scan;
}

/** Declaration keywords whose SIGNATURE text (not just its own export name)
 *  can gate a dead-type-export finding: return/param/member type positions of
 *  another exported declaration in the same file. Regex-only, matching this
 *  detector's existing style — not a parser. */
const SIGNATURE_START_RE =
	/^export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(function|const|let|var|class|interface|type)\s+\w+/;

/** Safety valve against an unterminated span (unbalanced brackets in input
 *  the regex scanner can't fully model) running off the end of a large file. */
const SIGNATURE_SPAN_LINE_CAP = 200;

interface SignatureSpan {
	/** 1-based start line — used to exclude a type's own declaration. */
	line: number;
	text: string;
}

/** `interface`/`type`/`class`: the reference can sit anywhere in the body
 *  (an interface field, a type-alias union member, a class member's type),
 *  so capture the whole brace-matched (or `;`-terminated, for a brace-less
 *  type alias) declaration. For `class` this is deliberately over-inclusive —
 *  it also sweeps in method BODIES, not just member signatures — trading a
 *  little precision for never false-blocking a real public-surface type;
 *  this check is advisory, so the safe failure direction is under-flagging. */
function extractBracedOrStatement(lines: string[], startIdx: number): string {
	let braceDepth = 0;
	let seenBrace = false;
	const out: string[] = [];
	for (let i = startIdx; i < lines.length && i - startIdx < SIGNATURE_SPAN_LINE_CAP; i++) {
		const line = lines[i] ?? "";
		out.push(line);
		for (const ch of line) {
			if (ch === "{") {
				braceDepth++;
				seenBrace = true;
			} else if (ch === "}") {
				braceDepth--;
			}
		}
		if (seenBrace && braceDepth <= 0) return out.join("\n");
		if (!seenBrace && /;\s*$/.test(line.trimEnd())) return out.join("\n");
	}
	return out.join("\n");
}

/** `function`/`const`/`let`/`var`: capture only the SIGNATURE — params and
 *  return-type annotation — stopping at the first `{` that opens the
 *  function body (tracked via paren depth, so an inline object-type param
 *  like `(x: { a: string })` doesn't trigger an early cutoff) or at a
 *  brace-less statement's terminating `;`. A referenced type inside the
 *  BODY is intentionally excluded — that is the "still used inside this
 *  file" un-export case, not a public-surface one. */
function extractSignaturePrefix(lines: string[], startIdx: number): string {
	let parenDepth = 0;
	const out: string[] = [];
	for (let i = startIdx; i < lines.length && i - startIdx < SIGNATURE_SPAN_LINE_CAP; i++) {
		const line = lines[i] ?? "";
		let cut = -1;
		for (let c = 0; c < line.length; c++) {
			const ch = line[c];
			if (ch === "(") parenDepth++;
			else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
			else if (ch === "{" && parenDepth === 0) {
				cut = c;
				break;
			}
		}
		if (cut >= 0) {
			out.push(line.slice(0, cut));
			return out.join("\n");
		}
		out.push(line);
		if (parenDepth === 0 && /;\s*$/.test(line.trimEnd())) return out.join("\n");
	}
	return out.join("\n");
}

/** Every exported declaration's signature span in the file, keyed by its
 *  start line so the type's own declaration can be excluded from its own
 *  evidence search. */
function collectExportedSignatureSpans(content: string): SignatureSpan[] {
	const lines = content.split("\n");
	const spans: SignatureSpan[] = [];
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i]?.trim() ?? "";
		const m = trimmed.match(SIGNATURE_START_RE);
		if (!m) continue;
		const keyword = m[1];
		const line = i + 1;
		const text =
			keyword === "interface" || keyword === "type" || keyword === "class"
				? extractBracedOrStatement(lines, i)
				: extractSignaturePrefix(lines, i);
		spans.push({ line, text });
	}
	return spans;
}

/** True when `typeName` names the type position of some OTHER exported
 *  declaration's signature — i.e. TS declaration emit needs it nameable
 *  regardless of whether any file imports it by name (the
 *  `public_api_leaks_internal_type` contradiction this guard exists to
 *  resolve). */
function isTypeUsedInExportedSignature(spans: SignatureSpan[], typeName: string, ownLine: number): boolean {
	const wordRe = new RegExp(`\\b${typeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
	for (const span of spans) {
		if (span.line === ownLine) continue;
		if (wordRe.test(span.text)) return true;
	}
	return false;
}

/** One export's escape checks: import consumption, the "public API" doc
 *  comment, and (type-only exports only) the same-file exported-signature
 *  escape. Split out of {@link buildMatches} to keep its own branch count
 *  under the per-edit cyclomatic sub-cap. */
function isExemptExport(
	exp: ReturnType<typeof candidateExports>[number],
	lines: string[],
	scan: EdgeScan,
	signatureSpans: SignatureSpan[],
): boolean {
	if (scan.symbols.has(exp.name)) return true;
	if (hasPublicApiComment(lines, exp.line)) return true;
	if (exp.isTypeOnly && isTypeUsedInExportedSignature(signatureSpans, exp.name, exp.line)) return true;
	return false;
}

/** Turn the resolved scan + candidate exports into findings, honoring the
 *  public-API escape, the same-file exported-signature escape, and the
 *  MAX_FLAGGED cap. */
function buildMatches(args: DeadExportsArgs, exports: ReturnType<typeof candidateExports>, scan: EdgeScan): InlineMatch[] {
	const lines = args.content.split("\n");
	// Only type-only exports need the signature scan — for value exports
	// `exp.isTypeOnly` is always false (candidateExports already filtered on
	// it), so the guard inside isExemptExport is a no-op there without
	// threading a flag.
	const signatureSpans = exports.some((e) => e.isTypeOnly)
		? collectExportedSignatureSpans(args.content)
		: [];
	const matches: InlineMatch[] = [];
	for (const exp of exports) {
		if (isExemptExport(exp, lines, scan, signatureSpans)) continue;
		matches.push({ line: exp.line, text: remedyFor(args.content, exp.name) });
		if (matches.length >= MAX_FLAGGED) break;
	}
	return matches;
}

/** Shared body for the value-export and type-export detectors. */
function findDeadExportsCore(
	args: DeadExportsArgs,
	repo: DeadExportsRepo,
	wantTypeOnly: boolean,
): InlineMatch[] {
	if (isExcludedFile(args.filePath)) return [];

	const exports = candidateExports(args, wantTypeOnly);
	if (exports.length === 0) return [];

	const scan = resolveAndScan(args, repo);
	if (scan === null) return [];

	return buildMatches(args, exports, scan);
}

/** Core detector over an injectable repo view — VALUE exports only. */
export function findDeadExports(args: DeadExportsArgs, repo: DeadExportsRepo): InlineMatch[] {
	return findDeadExportsCore(args, repo, false);
}

/**
 * TYPE-only exports (interfaces, type aliases, `export type {…}` clauses) no
 * other file imports. Split from the value detector because the remedy differs
 * — a dead type is erased at compile time, so deleting it can never change
 * runtime behavior; only external (published/vendored) consumers gate it. The
 * consumption scan is shared, and after the 2026-09-01 parser fixes it counts
 * `import type {…}`, inline `{ type X }` specifiers, and dynamic imports.
 */
export function findDeadTypeExports(args: DeadExportsArgs, repo: DeadExportsRepo): InlineMatch[] {
	return findDeadExportsCore(args, repo, true);
}

/** Real repo view: git file listing + filesystem reads. */
function liveRepo(cwd: string): DeadExportsRepo {
	return {
		listFiles: () => getGitSourceFiles(cwd),
		readFile: (rel) => {
			try {
				return readFileSync(resolve(cwd, rel), "utf-8");
			} catch {
				// Unreadable candidate importers contribute no evidence either way.
				return null;
			}
		},
	};
}

/** Registry-facing wrapper: real git file listing + real filesystem. */
export function checkDeadExports(content: string, filePath: string, cwd: string): InlineMatch[] {
	return findDeadExports({ content, filePath, cwd }, liveRepo(cwd));
}

/** Registry-facing wrapper for the TYPE lane (see findDeadTypeExports). */
export function checkDeadTypeExports(
	content: string,
	filePath: string,
	cwd: string,
): InlineMatch[] {
	return findDeadTypeExports({ content, filePath, cwd }, liveRepo(cwd));
}
