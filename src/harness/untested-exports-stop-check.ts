// ===========================================
// Untested-exports Stop nudge (backlog item 3D)
// ===========================================
// docs/design/stop-event-checks.md §3D: a source file written this session
// whose exported symbols no test file references. Cross-references the
// session's `files_written` against the project graph (dependents + exports)
// and scans each test dependent's content for word-boundary references.
//
// Everything here is pure given its injected collaborators: `getGraph`
// supplies the graph view (production: the daemon's cached ProjectGraph via
// getGraphForFile; tests: an in-memory fake) and `readFile` supplies test
// file contents. No fs, no timers, no clock reads in this module itself.
//
// FP posture (why this is a Stop-time REMINDER, never a block): in early TDD
// an exported symbol legitimately has no test yet — the test may be the very
// next thing the agent writes. Every "can't tell" path fails open to silence:
// file not in the graph (stale graph / unindexed), no named exports, a test
// dependent whose content is unreadable, or a graph provider that throws.

import { relative, resolve } from "node:path";
import { isStrictTestFile } from "./checks/shared.js";
import { escapeRegex } from "./structural-checks/helpers.js";

// ─── Shapes ──────────────────────────────────────────────────────────────────

/** One exported symbol as the graph reports it. Structurally satisfied by
 *  `ExportedSymbol` (types/graph.ts) — `kind` widens to string and the
 *  `isTypeOnly` field is simply not read here. */
interface ExportGraphSymbol {
	name: string;
	kind: string;
	line: number;
}

/** The slice of `ProjectGraph` this detector reads. `ProjectGraph` satisfies
 *  it structurally (hasFile / getDependents / getExports); tests build an
 *  in-memory fake. */
export interface ExportGraphView {
	hasFile(path: string): boolean;
	getDependents(path: string): string[];
	getExports(path: string): ExportGraphSymbol[];
}

/** One written source file with the exported symbols no test references. */
export interface UntestedExportHit {
	sourcePath: string;
	symbols: string[];
}

interface DetectUntestedExportsOpts {
	/** `session.files_written` — may hold BOTH the raw and resolved-absolute
	 *  form of the same path (session-state.ts convention); deduped here. */
	filesWritten: ReadonlySet<string>;
	cwd: string;
	/** Lazy graph provider — only invoked when the session wrote at least one
	 *  eligible code file, so read-only Stops never pay graph-build cost. */
	getGraph: () => ExportGraphView;
	/** Content reader for test dependents; null = unreadable (fail open). */
	readFile: (path: string) => string | null;
}

// ─── Eligibility ─────────────────────────────────────────────────────────────

/** Source extensions the project graph indexes — the only files whose
 *  exports this nudge can reason about. */
const GRAPH_CODE_FILE_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;

/** Export names that are not independently-testable named symbols. */
const NON_SYMBOL_EXPORT_NAMES = new Set(["default", "*"]);

/** A written file this nudge can grade: graph-indexable source code that is
 *  not itself a test file and not a declaration file. */
function isEligibleSourceFile(path: string): boolean {
	if (path.endsWith(".d.ts")) return false;
	if (!GRAPH_CODE_FILE_RE.test(path)) return false;
	return !isStrictTestFile(path);
}

/** Dedupe raw + resolved forms by resolving every path against cwd. */
function eligibleWrittenFiles(filesWritten: ReadonlySet<string>, cwd: string): string[] {
	const resolved = new Set<string>();
	for (const path of filesWritten) {
		if (isEligibleSourceFile(path)) resolved.add(resolve(cwd, path));
	}
	return [...resolved];
}

// ─── Detector ────────────────────────────────────────────────────────────────

/**
 * Public — Stop-time detector for backlog item 3D. For each eligible source
 * file written this session and present in the graph, report the named
 * exports that no test-file dependent references. Fails open (returns [])
 * whenever the evidence is incomplete — see the module header.
 */
export function detectUntestedExports(opts: DetectUntestedExportsOpts): UntestedExportHit[] {
	const candidates = eligibleWrittenFiles(opts.filesWritten, opts.cwd);
	if (candidates.length === 0) return [];

	let graph: ExportGraphView;
	try {
		graph = opts.getGraph();
	} catch {
		return []; // graph unavailable → can't tell → silent
	}

	const hits: UntestedExportHit[] = [];
	for (const sourcePath of candidates) {
		const symbols = untestedSymbolsFor(graph, sourcePath, opts.readFile);
		if (symbols !== null && symbols.length > 0) hits.push({ sourcePath, symbols });
	}
	return hits;
}

/** The named exports of `sourcePath` no test dependent references, or null
 *  when the file can't be graded (not in graph / unreadable dependent). */
function untestedSymbolsFor(
	graph: ExportGraphView,
	sourcePath: string,
	readFile: (path: string) => string | null,
): string[] | null {
	if (!graph.hasFile(sourcePath)) return null; // stale/unknown → can't tell

	const names = graph
		.getExports(sourcePath)
		.map((e) => e.name)
		.filter((name) => !NON_SYMBOL_EXPORT_NAMES.has(name));
	if (names.length === 0) return null; // nothing gradeable

	const testDependents = graph.getDependents(sourcePath).filter((p) => isStrictTestFile(p));
	if (testDependents.length === 0) return names; // no test touches the module

	const contents: string[] = [];
	for (const dependent of testDependents) {
		const content = readFile(dependent);
		if (content === null) return null; // unreadable → can't tell → fail open
		contents.push(content);
	}
	const combined = contents.join("\n");
	return names.filter((name) => !new RegExp(`\\b${escapeRegex(name)}\\b`).test(combined));
}

// ─── Formatter ───────────────────────────────────────────────────────────────

/** Files listed before the "...and N more" suffix truncates the report. */
const MAX_FILES_LISTED = 5;

/** Symbols listed per file before an ellipsis truncates the line. */
const MAX_SYMBOLS_LISTED = 8;

function formatHitLine(hit: UntestedExportHit, cwd: string): string {
	const shown = hit.symbols.slice(0, MAX_SYMBOLS_LISTED).join(", ");
	const suffix = hit.symbols.length > MAX_SYMBOLS_LISTED ? ", …" : "";
	return `  - ${relative(cwd, hit.sourcePath)}: ${shown}${suffix}`;
}

/**
 * Public — Stop-time reflection warning for untested exports. Returns null
 * when there is nothing to say. Reflection only: stderr-surfaced by the Stop
 * pipeline, never blocks, and says so (the TDD "test comes next" carve-out).
 */
export function formatUntestedExportsWarning(
	hits: readonly UntestedExportHit[],
	cwd: string,
): string | null {
	if (hits.length === 0) return null;
	const lines = [
		`[interlinked:verify-before-stop] ${hits.length} file(s) written this session export symbols no test file references:`,
		...hits.slice(0, MAX_FILES_LISTED).map((hit) => formatHitLine(hit, cwd)),
	];
	if (hits.length > MAX_FILES_LISTED) {
		lines.push(`  ...and ${hits.length - MAX_FILES_LISTED} more`);
	}
	lines.push(
		"If a test for these is your next step, carry on — this is a reminder, not a block. Otherwise consider adding one before ending the session.",
	);
	return lines.join("\n");
}
