// ===========================================
// Affected-test selection — the keystone that makes per-edit coverage AFFORDABLE
// ===========================================
// The per-edit coverage / red-green / CRAP gate (evaluator/coverage-write-guard.ts)
// runs the project's suite under coverage against an apply-before-disk overlay. On
// a real repo with a slow suite that FULL run blows the ~25s per-edit budget, so
// the gate defers and never actually enforces. This module fixes that: given the
// edited file, it walks the REVERSE import graph (DependencyView.getDependents)
// transitively and returns ONLY the test files that could be affected by the edit
// — a tiny, fast subset the overlay run fits inside the budget. The runner is then
// pointed at exactly those tests (vitest run <paths> / pytest <paths>).
//
// Three return states, each load-bearing for the caller's decision:
//   - `null`  — selection could not produce a PROVABLY COMPLETE answer: the
//               edited file is not in the dependency graph (e.g. a brand-new
//               source file not yet indexed), the view only answers for its own
//               seed file (a per-file Supermodel shard — no honest transitive
//               walk), or the BFS hit its node cap with frontier remaining
//               (truncated ⇒ possibly missing tests). The caller must fall back
//               to the FULL suite — running a wrong/incomplete subset would
//               falsely pass the gate. "Don't know which tests" ≠ "no tests".
//   - `[]`    — the file IS in the graph but NO test transitively depends on it.
//               For a source edit this is the strict-TDD signal: the added
//               executable lines are exercised by nothing, so the caller BLOCKS
//               ("write the test for <file> in this edit").
//   - `[…]`   — the affected test paths (repo-relative POSIX), deduped + sorted
//               for a deterministic command. The caller runs only these.
//
// Why the reverse graph and not a fresh scan: the daemon already holds a
// `ProjectGraph` (built once on startup, refreshed incrementally) behind the
// `DependencyView` seam — the SAME graph PostToolUse impact analysis uses. We
// REUSE it; we never build a second graph here.

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isTestSourcePath } from "./checks/shared.js";
import type { DependencyView } from "./dependency-view.js";

/** A test file materialized in the current edit's overlay (a co-created test
 *  of an atomic apply_patch / MultiEdit), keyed by repo-relative path. */
export interface OverlaySection {
	relPath: string;
	content: string;
}

/** Inputs for {@link selectAffectedTests}. */
export interface SelectAffectedTestsInput {
	/** Repo-relative POSIX path of the edited file (e.g. `src/m.ts`). */
	editedRelPath: string;
	/** Absolute project root the relative paths resolve against. */
	projectRoot: string;
	/** The dependency view the daemon already built (reverse import graph). */
	depView: DependencyView;
	/**
	 * Files materialized in THIS edit's overlay (the whole atomic patch's
	 * sections). Lets a BRAND-NEW source file — not yet in the import graph —
	 * scope to a test created in the SAME edit, before either is on disk.
	 * Non-test sections are ignored. Optional: a plain on-disk Write needs none
	 * (the companion is found on disk).
	 */
	overlaySections?: ReadonlyArray<OverlaySection>;
}

/** BFS node-expansion ceiling — the reverse graph is shallow, but a malformed
 *  cyclic graph must still terminate quickly. The `visited` set already
 *  guarantees termination; this is a belt-and-braces bound so a pathological
 *  fan-in can't make the per-edit gate slow (the very thing this module exists
 *  to avoid). Hitting the cap with frontier REMAINING means the collected set
 *  may be incomplete, so the selector returns `null` (full-suite fallback) —
 *  a truncated walk must never masquerade as a complete subset (finding
 *  2026-06: it returned the partial set, and a missed affected test let a
 *  breaking edit through the scoped run). */
const MAX_TRANSITIVE_HOPS = 1000;

/**
 * Is `relPath` a test/spec file? THIN RE-EXPORT of
 * `checks/shared.ts::isTestSourcePath` (plan
 * `docs/plans/16-monotonic-quality-enforcement.md` §11.3, Audit B) — kept as
 * a separately named export for this module's own callers (the mutation
 * gate + manifest choke point, and this module's own BFS below) and its
 * pinned test file, rather than removing it outright. Matches the
 * cross-language conventions the task pins explicitly: `*.test.*` /
 * `*.spec.*` (any extension, JS/TS and friends), `test_*.py`, `*_test.py`,
 * `*_test.go`, `*Test(s).java/.swift`, and anything under a
 * `__tests__/`/`tests/`/`test/` directory. Purely path-based — the file
 * need not exist on disk.
 *
 * Widened vs the pre-consolidation implementation to also match a bare
 * `tests/`/`test/` directory segment (previously only `__tests__/`) — the
 * union of all three convention lists that used to answer "is this a test"
 * independently. Safe direction for an oracle: it only ever EXCLUDES more
 * files from mutation targeting / manifest tracking, never pulls in product
 * code. Concretely affects `test/agent-driven/run-scenario.ts` in this repo
 * (a helper script living under `test/`, not itself an oracle) — it now
 * reads as a test path here, matching what `isTestOrSpecPath` /
 * `isStrictTestFile` already concluded for it (measured divergence in the
 * plan doc).
 */
export function isTestPath(relPath: string): boolean {
	return isTestSourcePath(relPath);
}

/** Resolve a graph path (absolute or relative) to a repo-relative POSIX path, or
 *  null when it lands outside `projectRoot` (a foreign-repo dependent is not part
 *  of this repo's test run). */
function toRepoRel(p: string, projectRoot: string): string | null {
	const abs = isAbsolute(p) ? p : resolve(projectRoot, p);
	const rel = relative(projectRoot, abs).replace(/\\/g, "/");
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
	return rel;
}

/**
 * Candidate companion test paths for a source file, e.g. `src/m.ts` →
 * `src/m.test.ts`, `src/m.spec.ts`, `src/__tests__/m.test.ts`, … Included only
 * when they actually exist on disk, so the runner is never pointed at a phantom.
 * The transitive BFS already finds a companion that *imports* the edited file;
 * this is the safety net for a companion the regex import graph missed (e.g. a
 * test that imports via a path alias the graph didn't resolve).
 */
function companionTestCandidates(editedRelPath: string): string[] {
	const norm = editedRelPath.replace(/\\/g, "/");
	const dot = norm.lastIndexOf(".");
	if (dot <= 0) return [];
	const stem = norm.slice(0, dot); // src/dir/m
	const ext = norm.slice(dot + 1); // ts
	const slash = stem.lastIndexOf("/");
	const dir = slash >= 0 ? stem.slice(0, slash) : "";
	const base = slash >= 0 ? stem.slice(slash + 1) : stem; // m
	const prefix = dir ? `${dir}/` : "";
	const tdir = dir ? `${dir}/__tests__/` : "__tests__/";
	return [
		`${prefix}${base}.test.${ext}`,
		`${prefix}${base}.spec.${ext}`,
		`${tdir}${base}.test.${ext}`,
		`${tdir}${base}.spec.${ext}`,
	];
}

/**
 * Tests that COVER `editedRelPath` WITHOUT needing the import graph: its
 * convention companion present on disk OR as an overlay section, plus any
 * overlay test section importing the file by path (a co-created test under a
 * non-convention name). This is what lets a brand-new file — not yet in the
 * graph — enforce coverage per-edit instead of deferring. INCLUSIVE by design:
 * an extra test only fails to add coverage (harmless); a MISSED covering test
 * would let the edit falsely pass, so we err toward including. Repo-relative
 * POSIX paths.
 */
function coveringTestsWithoutGraph(
	editedRelPath: string,
	projectRoot: string,
	overlaySections: ReadonlyArray<OverlaySection>,
): string[] {
	const overlayPaths = new Set(overlaySections.map((s) => s.relPath.replace(/\\/g, "/")));
	const found = new Set<string>();
	// 1. Convention companions — on disk (test-first TDD) or in the overlay
	//    (atomic source+test patch).
	for (const candidate of companionTestCandidates(editedRelPath)) {
		if (existsSync(resolve(projectRoot, candidate)) || overlayPaths.has(candidate)) {
			found.add(candidate);
		}
	}
	// 2. Overlay test sections importing the file by path. A relative import of
	//    `src/dir/m.ts` reads `./m.<ext>` or `../x/m.<ext>`, so the content holds
	//    the path segment `/m.` — a regex-free, FP-resistant needle (`/metrics.`
	//    does NOT contain `/m.`). Misses extensionless alias imports; those are
	//    rare and the convention companion above covers the common case.
	const base = (editedRelPath.replace(/\\/g, "/").split("/").pop() ?? "").replace(
		/\.[^.]+$/,
		"",
	);
	if (base.length > 0) {
		const needle = `/${base}.`;
		for (const section of overlaySections) {
			const rel = section.relPath.replace(/\\/g, "/");
			if (isTestPath(rel) && section.content.includes(needle)) found.add(rel);
		}
	}
	return [...found];
}

/**
 * One BFS hop: for `current`, visit its dependents (files that import it),
 * enqueue any not-yet-visited one, and collect it into `tests` when it is a
 * test file. Mutates `visited`, `queue`, and `tests` in place — extracted so
 * the BFS driver loop in {@link selectAffectedTests} stays flat.
 */
function expandDependents(
	current: string,
	projectRoot: string,
	depView: DependencyView,
	visited: Set<string>,
	queue: string[],
	tests: Set<string>,
): void {
	for (const dependent of depView.getDependents(current)) {
		const depAbs = isAbsolute(dependent) ? dependent : resolve(projectRoot, dependent);
		if (visited.has(depAbs)) continue;
		visited.add(depAbs);
		queue.push(depAbs);
		const rel = toRepoRel(depAbs, projectRoot);
		if (rel && isTestPath(rel)) tests.add(rel);
	}
}

/**
 * Select the test files transitively affected by an edit to `editedRelPath`.
 *
 * Algorithm: BFS the reverse import graph from the edited file. Each visited node
 * is asked for its dependents (`depView.getDependents`) — the files that import
 * it — and any dependent that is itself a test file is collected. The walk is
 * transitive (a test that imports a module that imports the edited file is
 * included) and cycle-safe (a `visited` set). The edited file's own companion
 * tests are added when they exist on disk. Returns repo-relative POSIX paths,
 * deduped + sorted; `null` when the edited file is not in the graph; `[]` when it
 * is but nothing tests it.
 *
 * Pure read over the already-built graph — never triggers a rebuild, never
 * touches the network, and (companion check aside) never touches the filesystem.
 */
export function selectAffectedTests(input: SelectAffectedTestsInput): string[] | null {
	const { editedRelPath, projectRoot, depView } = input;
	const overlaySections = input.overlaySections ?? [];
	const editedAbs = resolve(projectRoot, editedRelPath);

	// A seed-only view (per-file Supermodel shard) answers EVERY getDependents
	// call with the seed file's dependents, whatever the argument — so a
	// "transitive" walk over it just re-expands hop 1 forever and silently
	// misses indirect tests (finding 2026-06: a nonempty-but-incomplete subset
	// skipped a failing indirect test). No honest transitive selection is
	// possible → full-suite fallback.
	if (depView.answerScope !== "repo") return null;

	const covering = coveringTestsWithoutGraph(editedRelPath, projectRoot, overlaySections);

	// NEW FILE (not yet in the import graph): the reverse-graph walk can't help —
	// nothing imports a file the graph hasn't indexed — but its companion / co-
	// created test CAN run scoped. This is the fix that stops new files (the
	// dominant TDD case) deferring per-edit coverage to commit. A non-empty
	// covering set runs scoped; empty → null (full suite / defer), leaving "new
	// file with no test at all" to the TDD companion gate, not a false pass.
	if (!depView.hasFile(editedAbs)) {
		return covering.length > 0 ? [...new Set(covering)].sort() : null;
	}

	const tests = new Set<string>();
	const visited = new Set<string>([editedAbs]);
	const queue: string[] = [editedAbs];
	let head = 0;
	for (; head < queue.length && head < MAX_TRANSITIVE_HOPS; head++) {
		const current = queue[head];
		if (current === undefined) break;
		expandDependents(current, projectRoot, depView, visited, queue, tests);
	}
	// Cap hit with frontier remaining → the walk was TRUNCATED and `tests` may be
	// missing affected tests beyond the cap. An incomplete subset must never be
	// returned as if complete — a scoped run drawn from it could skip the very
	// test this edit breaks and approve it (finding 2026-06). Full-suite fallback.
	if (head < queue.length) return null;

	// The edited file's own companion / co-created test(s) — covers a companion
	// the import graph failed to link (disk companion or overlay-section test).
	for (const candidate of covering) tests.add(candidate);

	return [...tests].sort();
}

/**
 * The overlay-materialized files a route may scope to (a co-created test of an
 * atomic apply_patch / MultiEdit). Structural subset of the guard's OverlayFile
 * — declared here to keep the selector free of an evaluator-layer import. */
export interface RouteOverlayFile {
	relPath: string;
	content: string;
	delete?: boolean;
}

/** How the per-edit coverage overlay should run: only the affected tests
 *  (`scoped`) or the whole suite (`full`). */
export type SelectionRoute = { kind: "scoped"; tests: string[] } | { kind: "full" };

/**
 * Run affected-test selection (when a dependency view is available) and map its
 * result to a {@link SelectionRoute}. A non-empty subset routes to `scoped` (run
 * only those tests). Everything else routes to `full`:
 *   - no `depView` / `null` from the selector (file not in the graph) — "don't
 *     know which tests", so run them all rather than a wrong subset;
 *   - `[]` (file in the graph, but no test STATICALLY imports it) — the
 *     evidence-authority contract: the graph's silence is not proof of no
 *     coverage (an integration test exercises code it never imports), so MEASURE
 *     with the full suite; the coverage decision blocks only on what actually
 *     ran uncovered.
 * Kept out of `checkCoverageWrite` so that entry stays low-complexity.
 */
export function routeBySelection(
	relPath: string,
	projectRoot: string,
	depView: DependencyView | undefined,
	overlayFiles?: ReadonlyArray<RouteOverlayFile>,
): SelectionRoute {
	if (!depView) return { kind: "full" };
	// Forward the edit's overlay sections so a BRAND-NEW file (not yet in the
	// graph) can scope to a test created in the SAME edit, instead of deferring.
	const overlaySections = (overlayFiles ?? [])
		.filter((f) => !f.delete)
		.map((f) => ({ relPath: f.relPath, content: f.content }));
	const selected = selectAffectedTests({
		editedRelPath: relPath,
		projectRoot,
		depView,
		overlaySections,
	});
	if (selected === null || selected.length === 0) return { kind: "full" };
	return { kind: "scoped", tests: selected };
}
