// ===========================================
// git-commit detection (robust) — shared by the commit-time quality gate
// ===========================================
// Pure shell-parsing helpers that decide whether a Bash command is a real
// `git commit` (as opposed to `git status` / `log` / `diff`, a `commit-graph`
// subcommand, or a `# git commit` comment). Extracted from `commit-gate.ts` so
// the gate's decision logic stays under the per-file line cap and the parser can
// be unit-tested in isolation.
//
// No fs, no env, no module-scope state — same discipline as
// `package-install-parser.ts`. Quote-aware enough to keep a quoted commit
// message (`-m "fix: x && y"`) one token so its inner `&&` is not mistaken for a
// segment separator, and to skip git's global flags (`-C <dir>`, `-c key=val`).

// Shell tokenization, cwd-resolution, and flag-cluster primitives now live in
// the sibling `commit-parse-tokens.ts` (a pure leaf — no import back here), so
// this entry point stays under the per-file line cap.
import { nonNull } from "../../lib/non-null.js";
import { applyConstructedContent, type SegmentCommit } from "./commit-parse-construct.js";
import {
	COMMIT_VALUE_FLAGS,
	clusterBooleanLetters,
	combineCwd,
	isAllFlag,
	isIncludeFlag,
	literalDir,
	parseCdTarget,
	shellSplit,
	shortClusterTakesValue,
	splitSegments,
	stripLeadingPrefix,
} from "./commit-parse-tokens.js";

// Re-export the blessed shell-structure tokenizers so `harness/shell-structure.ts`
// (and its downstream `taint-tracker.ts`) keep importing them from this module's
// public surface — the split is an internal refactor, not an API move.
export { shellSplit, splitSegments, stripLeadingPrefix } from "./commit-parse-tokens.js";

/** The shape of a detected `git commit` invocation. */
export interface CommitParse {
	/** True when the command is a real `git commit` (not status/log/diff). */
	isCommit: boolean;
	/** True when `--no-verify` / `-n` is present (a bypass callers note in a warning). */
	noVerify: boolean;
	/**
	 * True when `-a` / `--all` is present (`git commit -a` / `-am`): the commit
	 * stages every tracked modification first, so the would-be snapshot is the
	 * working tree's tracked files. Absent/false for a plain `git commit`, whose
	 * snapshot is the INDEX only — the gate evaluates the staged tree, not the
	 * worktree, for those (finding 3).
	 */
	all?: boolean;
	/**
	 * True when the commit CONSTRUCTS its content during execution rather than
	 * committing the current index — a preceding `git add …` in the same compound
	 * command (`git add -A && git commit`) or a PATHSPEC commit (`git commit src/x.ts`,
	 * which stages those worktree paths). At PreToolUse the staging has not happened
	 * yet, so the index is stale; the gate evaluates the WORKING TREE for these so
	 * content is never left unevaluated (finding 4). The post-commit tree-hash
	 * reconciliation receipt is the principled general backstop (designed separately).
	 */
	constructsContent?: boolean;
	/**
	 * When `constructsContent` is set, the SPECIFIC worktree paths the command stages
	 * — the pathspecs of `git commit <paths>` and/or a narrow preceding `git add
	 * <paths>`. The gate restricts evaluation to these so an UNRELATED dirty file does
	 * not block the commit (finding 2026-06: the round-3 worktree-everything approach
	 * over-blocked, violating zero-FP). EMPTY/absent ⇒ a BROAD stage (`git add -A`/`.`/
	 * `-u`, or `--pathspec-from-file`) whose set is the whole worktree.
	 *
	 * Git's `--only`/`--include` semantics are modeled here (finding 2026-06): a
	 * pathspec commit WITHOUT `--include` commits ONLY the named paths (`--only` is
	 * git's default), so a narrow preceding `git add p` does NOT put `p` into this
	 * commit — its paths are excluded to keep the zero-FP contract. With `--include`,
	 * or with no pathspecs at all, the add's paths ARE captured and included.
	 */
	constructedPaths?: string[];
	/**
	 * The subset of `constructedPaths` whose snapshot overlay must include
	 * TRACKED files only (finding 2026-06, round 4): the commit's own pathspecs
	 * (`git commit -- src` commits tracked paths — an untracked test under src
	 * is NOT in the resulting commit, so it must not supply coverage evidence)
	 * and `-u`-staged add paths (`git add -u src` never stages untracked
	 * files). A path also covered by a PLAIN `git add` in the same command is
	 * excluded — that add stages untracked content into this very commit, so
	 * the full-worktree overlay is the accurate snapshot for it.
	 */
	trackedOnlyPaths?: string[];
	/**
	 * True when the commit ALSO captures the PRE-EXISTING staged index, beyond the
	 * paths this command itself constructs: a plain `git add … && git commit` (no
	 * pathspec — commits the WHOLE index) or `git commit --include <paths>`. The
	 * gate must union the staged set into its evaluation set for these — filtering
	 * to `constructedPaths` alone let an already-staged source file's violations
	 * bypass the quality bar entirely (finding 2026-06). Absent for a pathspec
	 * commit without `--include` (git's `--only` default: the index is NOT
	 * committed) and for non-constructed commits (whose modes already evaluate the
	 * index directly).
	 */
	includesIndex?: boolean;
	/**
	 * The directory the commit effectively runs in, relative to the shell's own
	 * cwd (or absolute), when a `cd <dir>` prefix and/or one or more `git -C <dir>`
	 * flags redirect it — e.g. `cd sub && git commit` ⇒ `"sub"`, `git -C a -C b
	 * commit` ⇒ `"a/b"`. Undefined when the commit runs in the shell's own cwd.
	 * The commit gate resolves this against `event.cwd` so it evaluates the
	 * repository ACTUALLY being committed, not the parent (finding 4). Only literal
	 * targets are captured; a `cd $VAR` / `cd -` / `cd ~` that cannot be resolved
	 * statically leaves this undefined (the gate then falls back to `event.cwd`).
	 */
	cwd?: string;
}

// `SegmentCommit` (a `git commit` detected in ONE segment, plus the compounded
// `-C` directory) and `AddState` (what preceding `git add` segments staged)
// now live in `commit-parse-construct.js`, imported above — that module's the
// only consumer whose logic needs their full shape spelled out, and this file
// still constructs/threads values of both types.

/** The SPECIFIC positional pathspecs of a commit's `rest` (after "commit"): bare
 *  positionals plus everything after a `--`. Flags (and their values) are skipped;
 *  `--pathspec-from-file` is broad (paths live in a file) and contributes none. */
function commitPathspecs(rest: string[]): string[] {
	const paths: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const t = nonNull(rest[i]);
		if (t === "--") {
			paths.push(...rest.slice(i + 1).map((v) => nonNull(v)));
			break;
		}
		// The SEPARATE-value form consumes its file argument too — without the `i++`
		// the list file itself read as a pathspec and the gate evaluated it instead
		// of the sources named inside (finding 2026-06). The commit is already
		// marked broad via `hasPathspecFromFile`.
		if (t === "--pathspec-from-file") {
			i++;
			continue;
		}
		if (t.startsWith("--pathspec-from-file=")) continue;
		if (t.startsWith("-")) {
			i += COMMIT_VALUE_FLAGS.has(t) || shortClusterTakesValue(t) ? 1 : 0; // its value is not a pathspec
			continue;
		}
		paths.push(t); // bare positional → pathspec
	}
	return paths;
}

/** True when the commit reads pathspecs from a file (`--pathspec-from-file[=<file>]`) —
 *  a constructed-content commit whose path set is broad/unknown (finding 2026-06). */
function hasPathspecFromFile(rest: string[]): boolean {
	return rest.some((t) => t === "--pathspec-from-file" || t.startsWith("--pathspec-from-file="));
}

/**
 * Paths a `git add` segment stages, whether it stages BROADLY, and whether
 * `-u/--update` restricts it to TRACKED files. `-A`/`-u` are broad ONLY when
 * bare: with a pathspec, git stages just that scope (`git add -A src/` touches
 * nothing outside src/), so returning broad evaluated the entire repository
 * and let unrelated files false-block or supply coverage (finding 2026-06,
 * round 4). `.` is an ordinary cwd-relative pathspec — the gate rebases it
 * against the command's directory (repo root → broad via the rebase; a
 * subdirectory `git add .` stages only that subtree).
 */
function addSegmentPaths(segment: string): { paths: string[]; broad: boolean; updateOnly: boolean } {
	const tokens = stripLeadingPrefix(shellSplit(segment));
	const { subIdx } = scanGitGlobalFlags(tokens);
	if (subIdx < 0) return { paths: [], broad: false, updateOnly: false };
	const paths: string[] = [];
	let allish = false;
	let updateOnly = false;
	let fromFile = false;
	// A `switch(true)` over the mutually-exclusive token classes, not an if-chain:
	// each case's `break` matches the original if-chain's `continue` exactly (the
	// switch's own body IS the whole loop body, so both hand control back to the
	// next iteration), and the `default` matches the trailing `paths.push(t)`.
	for (const t of tokens.slice(subIdx + 1)) {
		switch (true) {
			case t === "-A" || t === "--all":
				allish = true;
				break;
			case t === "-u" || t === "--update":
				allish = true;
				updateOnly = true;
				break;
			// File-mediated pathspecs (`--pathspec-from-file files.txt`, `=<file>`, or
			// `-` for stdin): the real staged paths live INSIDE the file, which a static
			// parse cannot read — so this add is BROAD, never "the list file is the path"
			// (finding 2026-06: the gate evaluated files.txt itself and the named sources
			// bypassed). Same indirection class as pip's `-r requirements.txt`.
			case t === "--pathspec-from-file" || t.startsWith("--pathspec-from-file="):
				fromFile = true;
				break;
			case t === "--" || t.startsWith("-"): // separator / other add flags
				break;
			default:
				paths.push(t);
		}
	}
	return { paths, broad: fromFile || (allish && paths.length === 0), updateOnly };
}

/** True when a segment is a `git add …` (its staging constructs the commit's content). */
function isGitAddSegment(segment: string): boolean {
	const tokens = stripLeadingPrefix(shellSplit(segment));
	if (tokens.length < 2) return false;
	const head = tokens[0];
	if (head !== "git" && !nonNull(head).endsWith("/git")) return false;
	const { subIdx } = scanGitGlobalFlags(tokens);
	return subIdx >= 0 && tokens[subIdx] === "add";
}

/**
 * Advance past git's global flags (`-C <dir>`, `-c key=val`, `--no-pager`, …) to
 * the subcommand token. Returns its index (or -1) AND the compounded `-C`
 * directory: multiple `-C` flags compound exactly like `cd` (each relative `-C`
 * is interpreted against the preceding one), so they fold through `combineCwd`.
 */
function scanGitGlobalFlags(tokens: string[]): { subIdx: number; cDir: string | null } {
	let i = 1;
	let cDir: string | null = null;
	while (i < tokens.length) {
		const t = tokens[i];
		if (t === "-C") {
			const raw = tokens[i + 1];
			const dir = raw !== undefined ? literalDir(raw) : null;
			if (dir !== null) cDir = combineCwd(cDir, dir);
			i += 2; // flag + its argument
			continue;
		}
		if (t === "-c") {
			i += 2; // config `key=val` — consume both
			continue;
		}
		if (nonNull(t).startsWith("-")) {
			i += 1;
			continue;
		}
		return { subIdx: i, cDir };
	}
	return { subIdx: -1, cDir };
}

/** Parse ONE shell segment for a `git commit`, capturing its `-C` dir, or null. */
function parseSegment(segment: string): SegmentCommit | null {
	const tokens = stripLeadingPrefix(shellSplit(segment));
	if (tokens.length < 2) return null;
	// Head must be `git` (or a path ending in /git), not a comment or other binary.
	const head = tokens[0];
	if (head !== "git" && !nonNull(head).endsWith("/git")) return null;

	const { subIdx, cDir } = scanGitGlobalFlags(tokens);
	if (subIdx < 0 || tokens[subIdx] !== "commit") return null;

	const rest = tokens.slice(subIdx + 1);
	// `-n` may ride in a cluster (`-anm "x"`); attached values are excluded the
	// same way as for -a / -i (clusterBooleanLetters).
	const noVerify = rest.some((t) => t === "--no-verify" || clusterBooleanLetters(t).includes("n"));
	const all = rest.some(isAllFlag);
	return {
		isCommit: true,
		noVerify,
		all,
		include: rest.some(isIncludeFlag),
		pathspecs: commitPathspecs(rest),
		pathspecFromFile: hasPathspecFromFile(rest),
		cDir,
	};
}

// `AddState` (what preceding `git add` segments staged) and the
// constructed-content path/index resolution logic (`applyConstructedContent`
// and its private helpers: `--only`/`--include` semantics, tracked-only
// subset, non-literal-pathspec broadening — finding 2026-06, rounds 4-6) now
// live in `commit-parse-construct.js`, imported above.

/** Running accumulation across the segments of a compound command, threaded
 *  through {@link processCommitSegment}: the `cd` chain so far and what any
 *  preceding `git add` segment(s) staged. Mutated in place by each call. */
interface RunningCommitState {
	runCwd: string | null; // accumulated `cd` chain, relative to shell cwd
	sawGitAdd: boolean; // a `git add …` before the commit constructs its content
	addBroad: boolean; // a bare `git add -A`/`-u` (or from-file) stages the whole worktree
	addPaths: string[]; // narrow `git add <paths>` staged paths
	updateOnlyPaths: string[]; // the subset staged via `-u` (tracked only)
}

/**
 * Process ONE segment of a compound command against the running `cd`/`add`
 * state (mutated in place). Returns the finished `CommitParse` when `segment`
 * is the commit itself; `null` when the segment only feeds the running state
 * (a `cd` or `git add`) or matches nothing, meaning the caller's loop should
 * keep scanning subsequent segments.
 */
function processCommitSegment(segment: string, state: RunningCommitState): CommitParse | null {
	const cd = parseCdTarget(segment);
	if (cd !== null) {
		state.runCwd = combineCwd(state.runCwd, cd);
		return null;
	}
	if (isGitAddSegment(segment)) {
		state.sawGitAdd = true;
		const a = addSegmentPaths(segment);
		if (a.broad) state.addBroad = true;
		else {
			state.addPaths.push(...a.paths);
			if (a.updateOnly) state.updateOnlyPaths.push(...a.paths);
		}
		return null;
	}
	const seg = parseSegment(segment);
	if (!seg) return null;
	const effective = combineCwd(state.runCwd, seg.cDir);
	const parse: CommitParse = { isCommit: seg.isCommit, noVerify: seg.noVerify };
	if (seg.all) parse.all = true;
	if (state.sawGitAdd || seg.pathspecs.length > 0 || seg.pathspecFromFile) {
		parse.constructsContent = true;
		applyConstructedContent(parse, seg, {
			sawGitAdd: state.sawGitAdd,
			addBroad: state.addBroad,
			addPaths: state.addPaths,
			updateOnlyPaths: state.updateOnlyPaths,
		});
	}
	if (effective !== null) parse.cwd = effective;
	return parse;
}

/**
 * Detect whether ANY segment of `command` is a real `git commit`. Distinguishes
 * `git commit` / `git commit -m` / `git commit -am` / `git commit --amend` from
 * non-commit git verbs (status / log / diff / show), `commit-graph`/`commit-tree`
 * (different subcommands), and a `# git commit` comment.
 *
 * Working-directory aware (finding 4): a `cd <dir>` prefix chain and the commit's
 * own `git -C <dir>` flag(s) are folded into `CommitParse.cwd` (relative to the
 * shell's cwd) so the gate evaluates the repo actually being committed —
 * `cd repo && git commit` and `git -C repo commit` both surface `cwd: "repo"`.
 * Returns the parse for the first matching segment, or `null`.
 */
export function parseGitCommit(command: string): CommitParse | null {
	if (!command || typeof command !== "string") return null;
	const state: RunningCommitState = {
		runCwd: null,
		sawGitAdd: false,
		addBroad: false,
		addPaths: [],
		updateOnlyPaths: [],
	};
	for (const segment of splitSegments(command)) {
		const result = processCommitSegment(segment, state);
		if (result) return result;
	}
	return null;
}

/**
 * True when a Bash command runs `git push` in at least one segment. Same
 * quote/comment/`cd`-aware discipline as {@link parseGitCommit} (reuses the
 * segment splitter, shell tokenizer, and global-flag scanner), so `# git push`
 * in a comment, a quoted `"git push"` string, and near-misses like `git pushd`
 * do NOT match, while `git -C repo push` and `cd repo && git push` do. THE
 * single source for "is this a push" — the client-side hook-timeout router and
 * the server-side push gate both consume it, retiring the divergent bare
 * `/\bgit\s+push\b/` regexes (2026-07-17).
 */
export function isGitPushCommand(command: string): boolean {
	if (!command || typeof command !== "string") return false;
	for (const segment of splitSegments(command)) {
		const tokens = stripLeadingPrefix(shellSplit(segment));
		if (tokens.length < 2) continue;
		const head = tokens[0];
		if (head !== "git" && !nonNull(head).endsWith("/git")) continue;
		const { subIdx } = scanGitGlobalFlags(tokens);
		if (subIdx >= 0 && tokens[subIdx] === "push") return true;
	}
	return false;
}
