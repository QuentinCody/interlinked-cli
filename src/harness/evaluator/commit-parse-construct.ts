// interlinked-tdd: exempt
// ===========================================
// git-commit detection — constructed-content resolution
// ===========================================
// Pure leaf helpers extracted from `commit-parse.ts` (2026-09) to keep the
// parser entry point under the per-file line cap: given one parsed `git
// commit` segment plus the running `git add` state that preceded it, decide
// which paths the commit CONSTRUCTS (see `CommitParse.constructedPaths` /
// `.trackedOnlyPaths` / `.includesIndex` docs on the type itself). No fs, no
// env, no module-scope mutable state. `commit-parse.ts` imports
// `applyConstructedContent`; nothing here imports back (a true leaf — only a
// type-only import of `CommitParse`, erased at compile time).
import type { CommitParse } from "./commit-parse.js";

/** The shape of a `git commit` detected in ONE shell segment — mirrors the
 *  internal `SegmentCommit` in `commit-parse.ts`, which is the only producer. */
export interface SegmentCommit {
	isCommit: boolean;
	noVerify: boolean;
	all: boolean;
	/** `--include`/`-i`: the commit captures the staged index IN ADDITION to its
	 *  pathspecs (vs git's `--only` default, which commits the named paths alone). */
	include: boolean;
	/** Specific positional pathspecs on the commit itself (`git commit src/x.ts`). */
	pathspecs: string[];
	/** `--pathspec-from-file` — a broad constructed-content commit (paths in a file). */
	pathspecFromFile: boolean;
	cDir: string | null;
}

/** What the preceding `git add` segments of a compound command staged. */
export interface AddState {
	sawGitAdd: boolean;
	addBroad: boolean;
	addPaths: string[];
	/** The subset of `addPaths` staged via `-u/--update` (tracked files only). */
	updateOnlyPaths: string[];
}

/** Characters that make a pathspec NON-literal: glob (star / `?` / brackets / braces),
 *  shell variable or substitution (dollar), tilde expansion. A plain string scanned
 *  char-by-char (not a regex char class) for lexer friendliness. */
const NON_LITERAL_PATHSPEC_CHARS = "*?[]$~{}";

/**
 * True when a pathspec cannot be matched LITERALLY against changed-file paths:
 * glob chars, shell variables, tilde expansion, or git pathspec magic (leading `:`).
 * Git/the shell expands these at run time, so an exact-match filter would match
 * NOTHING and the gate would silently evaluate no source (finding 2026-06) — the
 * caller treats any non-literal spec as BROAD instead.
 */
function isNonLiteralPathspec(spec: string): boolean {
	for (const ch of NON_LITERAL_PATHSPEC_CHARS) {
		if (spec.includes(ch)) return true;
	}
	return spec.startsWith(":");
}

/**
 * A plain-add path UNDER a commit pathspec is content this commit DOES
 * contain (the add tracks it before the commit runs) — merge it into
 * `specific` so the snapshot overlays it in full ALONGSIDE the tracked-only
 * dir scope, instead of widening the whole scope to a raw copy (round 5). A
 * glob add under the pathspec lands here too and degrades to broad below via
 * `isNonLiteralPathspec` — unknowable fails toward evaluating MORE. Mutates
 * `specific` in place (helper for {@link applyConstructedContent}).
 */
function mergeCoveredAddPaths(seg: SegmentCommit, add: AddState, specific: string[]): void {
	const fullAdds = add.addPaths.filter((p) => !add.updateOnlyPaths.includes(p));
	for (const f of fullAdds) {
		if (seg.pathspecs.some((p) => pathCovers(p, f)) && !specific.includes(f)) {
			specific.push(f);
		}
	}
}

/** True when the commit's constructed content set must be treated as BROAD
 *  (evaluate the whole worktree) rather than the specific paths collected so
 *  far — see the `applyConstructedContent` doc comment for each case. */
function isBroadConstruction(
	onlyNamedPaths: boolean,
	seg: SegmentCommit,
	add: AddState,
	specific: string[],
): boolean {
	return (
		(onlyNamedPaths ? false : add.addBroad) ||
		seg.pathspecFromFile ||
		seg.all ||
		specific.some(isNonLiteralPathspec)
	);
}

/** True when the commit ALSO captures the pre-existing staged index (see
 *  {@link CommitParse.includesIndex}). */
function includesStagedIndex(seg: SegmentCommit, add: AddState): boolean {
	return seg.include || (add.sawGitAdd && seg.pathspecs.length === 0 && !seg.pathspecFromFile);
}

/** True when pathspec `a` covers `b`: equal, or `b` lies under directory `a`
 *  (`src` covers `src/x.ts`; `.` covers everything). Trailing slashes and a
 *  leading `./` normalize away, matching the gate's own pathspec filter. */
function pathCovers(a: string, b: string): boolean {
	const norm = (s: string) => s.replace(/^\.\//, "").replace(/\/+$/, "");
	const na = norm(a);
	const nb = norm(b);
	return na === "." || na === nb || nb.startsWith(`${na}/`);
}

/**
 * The constructed paths whose snapshot overlay must include TRACKED files only
 * (see {@link CommitParse.trackedOnlyPaths}): the commit's own pathspecs and
 * `-u`-staged add paths. A candidate COVERED by a PLAIN `git add` path keeps
 * the full overlay — that add stages untracked content across the candidate's
 * whole scope, so a tracked-only overlay would evaluate stale index content. A
 * plain add BENEATH the candidate does NOT widen the rest of the scope: the
 * candidate stays tracked-only and the child path itself rides in
 * `constructedPaths` with its own full overlay (round 5: dropping the whole
 * candidate copied the raw directory, letting unrelated untracked files the
 * command never stages supply coverage). A broad add (`git add -A && git
 * commit src/a.ts`) stages everything, so nothing stays tracked-only.
 */
function trackedOnlySubset(seg: SegmentCommit, add: AddState): string[] {
	if (add.addBroad) return [];
	const fullAddPaths = add.addPaths.filter((p) => !add.updateOnlyPaths.includes(p));
	const candidates =
		seg.pathspecs.length > 0 && !seg.include
			? seg.pathspecs
			: [...seg.pathspecs, ...add.updateOnlyPaths];
	const coveredByFullAdd = (p: string) => fullAddPaths.some((f) => pathCovers(f, p));
	return [...new Set(candidates.filter((p) => !coveredByFullAdd(p)))];
}

/**
 * Fold the constructed-content path set and index-inclusion onto `parse`,
 * modeling git's `--only`/`--include` semantics (finding 2026-06):
 *
 *   - A pathspec commit WITHOUT `--include` commits ONLY the named paths
 *     (`--only` is git's default): a preceding `git add` — narrow or broad —
 *     changes the INDEX but not THIS commit's content, so its paths are
 *     excluded from the evaluation set (zero-FP: an unrelated staged file must
 *     not block) and the index is NOT marked included.
 *   - With `--include`, or with no pathspecs at all after a `git add`, the
 *     commit captures the staged index too → `includesIndex` tells the gate to
 *     union the staged set (previously those files bypassed evaluation).
 *
 * Paths stay SPECIFIC only when knowable statically — otherwise BROAD (evaluate
 * everything; the narrow filter exists only to avoid false BLOCKS, so unknowable
 * must fail toward evaluating MORE, never less):
 *   - a BARE `git add -A`/`-u` / `--pathspec-from-file` — whole worktree (with a
 *     pathspec, `-A`/`-u` stage only that scope and stay specific — finding
 *     2026-06 round 4; `.` is a cwd-relative pathspec the gate rebases, broad
 *     only when it resolves to the repo root);
 *   - `git commit -a` — `-a` stages EVERY tracked modification (finding 2026-06);
 *   - any NON-LITERAL pathspec (glob / variable / pathspec magic) — git expands
 *     it at run time, so an exact-match filter would match nothing and silently
 *     evaluate NO source (finding 2026-06).
 */
export function applyConstructedContent(parse: CommitParse, seg: SegmentCommit, add: AddState): void {
	const onlyNamedPaths = seg.pathspecs.length > 0 && !seg.include;
	const specific = onlyNamedPaths ? [...seg.pathspecs] : [...seg.pathspecs, ...add.addPaths];
	if (onlyNamedPaths) {
		mergeCoveredAddPaths(seg, add, specific);
	}
	const broad = isBroadConstruction(onlyNamedPaths, seg, add, specific);
	if (!broad && specific.length > 0) {
		parse.constructedPaths = specific;
		const trackedOnly = trackedOnlySubset(seg, add);
		if (trackedOnly.length > 0) parse.trackedOnlyPaths = trackedOnly;
	}
	if (includesStagedIndex(seg, add)) {
		parse.includesIndex = true;
	}
}
