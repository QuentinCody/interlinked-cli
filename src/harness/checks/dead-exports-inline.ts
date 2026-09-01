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

/** Core detector over an injectable repo view. */
export function findDeadExports(args: DeadExportsArgs, repo: DeadExportsRepo): InlineMatch[] {
	const ext = getExtension(args.filePath);
	if (!EXPORTABLE_EXT.includes(ext)) return [];
	if (args.filePath.endsWith(".d.ts")) return [];
	if (isTestFile(args.filePath)) return [];
	const base = basename(args.filePath).replace(/\.[^.]*$/, "");
	if (base === "index") return []; // barrel — intentionally wide

	const exports = parseExports(args.content).filter(
		(e) => e.kind !== "default" && e.kind !== "re-export" && e.kind !== "namespace" && !e.isTypeOnly,
	);
	if (exports.length === 0) return [];

	const cwd = args.cwd ?? "";
	const selfRel = isAbsolute(args.filePath) ? relative(cwd || "/", args.filePath) : args.filePath;
	// A file OUTSIDE the project root has no candidate importers here, so "no
	// one imports it" would be vacuously true — say nothing instead. (Guard
	// carried over from the pre-extraction detector; its tests pin it.)
	if (selfRel.startsWith("..")) return [];
	const scan = scanImporters(repo, selfRel, pathKey(selfRel));
	if (scan.allUsed) return [];
	// The evidence guard (lesson 3): mentioned but never resolved ⇒ our
	// resolution failed somewhere, so silence beats a page of false debt.
	if (scan.mentions > 0 && scan.resolvedEdges === 0) return [];

	const lines = args.content.split("\n");
	const matches: InlineMatch[] = [];
	for (const exp of exports) {
		if (scan.symbols.has(exp.name)) continue;
		if (hasPublicApiComment(lines, exp.line)) continue;
		matches.push({ line: exp.line, text: `unused export '${exp.name}' — remove or document as public API` });
		if (matches.length >= MAX_FLAGGED) break;
	}
	return matches;
}

/** Registry-facing wrapper: real git file listing + real filesystem. */
export function checkDeadExports(content: string, filePath: string, cwd: string): InlineMatch[] {
	const repo: DeadExportsRepo = {
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
	return findDeadExports({ content, filePath, cwd }, repo);
}
