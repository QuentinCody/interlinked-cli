// ===========================================
// Reachability Annotator — Phase C
// ===========================================
// Pure `findings → findings` transformer that annotates each
// `DetectorFinding` from the Phase B endpoint-security pack with a
// reachability tag derived from the Phase A2 project graph. The tag is
// appended on its own line so `formatQualityWarnings`'s newline-aware
// rendering surfaces it as a separate suffix line without any formatter
// change (Phase C, Q1 — annotate, never suppress).
//
// This module is intentionally decoupled from the registry/adapter
// layer: it takes findings in, returns findings out. The integration
// step in `check-registry/endpoint-security-adapters.ts` calls into
// here after the detectors run.
//
// Design notes:
//   - One graph query per *unique* file (not per finding). Multiple
//     findings on the same file share a single verdict — cheaper and
//     keeps the [reachable]/[unreachable] tag consistent across them.
//     The graph itself memoizes per `(file, entry-point-set)`; this
//     module hoists the dedup so the call-shape stays minimal even
//     when the memo would short-circuit it.
//   - The input array and finding objects are never mutated; the
//     output is a new array of new `DetectorFinding` records with the
//     amended `message` field.
//   - Verbose mode appends an "Entry points considered:" line. When
//     more than five entry points are passed, the list is truncated
//     to the first five with an ellipsis.

import { basename } from "node:path";

import type { DetectorFinding } from "./checks/endpoint-security.js";
import type { EntryPoint } from "./entry-points.js";
import type { ProjectGraph } from "./project-graph.js";
import type { RouteMap } from "./route-map.js";

/** Options accepted by {@link annotateReachability}. */
interface AnnotateReachabilityOpts {
	/** Initializedproject graph used to compute reachability verdicts. */
	projectGraph: ProjectGraph;
	/** Entry points the graph should walk from. */
	entryPoints: EntryPoint[];
	/**
	 * When true, additionally append a line listing the entry-point basenames
	 * the graph was asked to consider. Truncated to the first five when more
	 * than five entry points are passed.
	 */
	verbose?: boolean;
}

/** Maximum number of entry-point basenames to surface in verbose mode. */
const VERBOSE_ENTRY_POINT_LIMIT = 5;

/** Tag appended to findings whose file is reachable from any entry point. */
const REACHABLE_TAG = "[reachable]";

/** Tag appended to findings whose file is not reachable from any entry point. */
const UNREACHABLE_TAG = "[unreachable-from-entrypoints]";

/**
 * Annotate each finding's `message` with `[reachable]` or
 * `[unreachable-from-entrypoints]` based on the project graph. Returns a
 * brand-new array of new finding objects; the input is never mutated.
 *
 * Behavior contract (per the Phase C plan, Q1):
 *   - **Always annotate, never suppress.** Every input finding produces
 *     exactly one output finding in the same order.
 *   - Reachability tag lands on its own line (`\n[reachable]`) so it
 *     surfaces as a suffix in the existing newline-aware quality-warning
 *     formatter without any formatter-side change.
 *   - In verbose mode, an additional `Entry points considered: …` line
 *     is appended with up to five entry-point basenames.
 */
export function annotateReachability(
	findings: DetectorFinding[],
	opts: AnnotateReachabilityOpts,
): DetectorFinding[] {
	if (findings.length === 0) return [];

	const entryPointFiles = opts.entryPoints.map((ep) => ep.file);
	const verbose = opts.verbose === true;
	const verboseSuffix = verbose ? buildVerboseSuffix(opts.entryPoints) : null;

	// One verdict per unique file. The graph already memoizes per
	// `(file, sorted-entry-point-set)`, but hoisting here keeps the
	// call shape obvious (and gives the "≤1 call per unique file"
	// guarantee asserted by the test suite without leaking the graph's
	// internal memo as part of the contract).
	const verdicts = new Map<string, boolean>();
	const out: DetectorFinding[] = [];
	for (const finding of findings) {
		let reachable = verdicts.get(finding.file);
		if (reachable === undefined) {
			const verdict = opts.projectGraph.isFileReachableFromEntryPoints(
				finding.file,
				entryPointFiles,
			);
			reachable = verdict.reachable;
			verdicts.set(finding.file, reachable);
		}
		const tag = reachable ? REACHABLE_TAG : UNREACHABLE_TAG;
		let message = `${finding.message}\n${tag}`;
		if (verboseSuffix !== null) {
			message = `${message}\n${verboseSuffix}`;
		}
		out.push({ ...finding, message });
	}
	return out;
}

/**
 * Build the verbose-mode "Entry points considered: …" line. Truncates to
 * the first {@link VERBOSE_ENTRY_POINT_LIMIT} basenames when more are
 * supplied; an ellipsis marker (`…`) is appended in the truncated case so
 * the reader can tell the list was cut.
 */
function buildVerboseSuffix(entryPoints: EntryPoint[]): string {
	const basenames = entryPoints.map((ep) => basename(ep.file));
	if (basenames.length <= VERBOSE_ENTRY_POINT_LIMIT) {
		return `Entry points considered: ${basenames.join(", ")}`;
	}
	const head = basenames.slice(0, VERBOSE_ENTRY_POINT_LIMIT).join(", ");
	return `Entry points considered: ${head}, …`;
}

/**
 * Build a deduplicated `EntryPoint[]` list from every endpoint in
 * `routeMap`, with one entry per *unique handler file*. The reason
 * string is `http_handler:<framework>:<method>:<path>` — capturing the
 * first endpoint that surfaced each file, since two endpoints on the
 * same file collapse to one entry point for reachability purposes
 * (the file either is or isn't reachable; per-endpoint surfacing in
 * the reason string is debug noise).
 *
 * This is intentionally distinct from `collectEntryPoints` in
 * `entry-points.ts` — that helper composes bin / lib_export / test
 * sources alongside the route map and dedupes by `(kind, file, reason)`
 * which surfaces *every* endpoint as a separate record. For Phase C's
 * one-graph-query-per-unique-file flow we want a tighter dedupe that
 * collapses on `file` alone.
 */
export function buildHttpHandlerEntryPoints(routeMap: RouteMap): EntryPoint[] {
	const seen = new Set<string>();
	const out: EntryPoint[] = [];
	for (const ep of routeMap.extractAllEndpoints()) {
		if (seen.has(ep.file)) continue;
		seen.add(ep.file);
		out.push({
			kind: "http_handler",
			file: ep.file,
			reason: `http_handler:${ep.framework}:${ep.method}:${ep.path}`,
		});
	}
	return out;
}
