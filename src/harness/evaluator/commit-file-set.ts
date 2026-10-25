// The files a `git commit` command will capture, for commit-time checks that
// read SESSION state (files edited this session) rather than the commit.
//
// Without this scope, a commit of two files drew `prod_delta_no_test_delta`,
// `tpp_leapfrog` and `reintroduces_removed_code` warnings about unstaged files
// that only shared the worktree (2026-10-05).
//
// The scope is computed ONLY when it is certain from git alone: one plain
// `git commit` (the index) or `git commit -a` (the index plus tracked edits),
// run in the session directory. Anything that builds the commit at run time —
// a preceding `git add` (including `-f` and `-u`), a pathspec, a `cd` / `-C`
// hop, several commits in one command — returns null, and the caller keeps
// every finding. Four review rounds (2026-10-05/06) each found another way a
// modeled scope dropped a warning for a committed file; an unknown scope
// reports more, never less.
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { SessionTrajectory } from "../types.js";
import { defaultGitChangedFiles, defaultResolveRepoRoot } from "./commit-gate-changes.js";
import { splitSegments } from "./commit-parse-shell.js";
import { shellSplit } from "./commit-parse-tokens.js";

export interface CommitFileSetDeps {
	resolveRepoRoot: (dir: string) => string | null;
	gitChangedFiles: (root: string, stagedOnly: boolean, includeUntracked: boolean) => string[] | null;
}

const DEFAULT_DEPS: CommitFileSetDeps = {
	resolveRepoRoot: defaultResolveRepoRoot,
	gitChangedFiles: defaultGitChangedFiles,
};

export interface CommitScope {
	/** The repository toplevel the commit runs in. */
	root: string;
	/** Absolute paths the commit will capture. */
	files: ReadonlySet<string>;
}

/** Flags that change neither the index nor which tree is committed. */
const PLAIN_FLAGS: ReadonlySet<string> = new Set([
	"-a", "--all", "-q", "--quiet", "-s", "--signoff", "-n", "--no-verify", "-v", "--verbose",
	"--allow-empty", "--allow-empty-message", "--no-edit", "--no-gpg-sign",
]);
/** Flags that take the next token as their value (message, author, …). */
const VALUE_FLAGS: ReadonlySet<string> = new Set(["-m", "--message", "-F", "--file", "--author", "--date", "--trailer", "--cleanup"]);
const VALUE_FLAG_ASSIGNED = /^--(?:message|file|author|date|trailer|cleanup)=/;
/**
 * Any shell expansion: command/backtick/process substitution RUNS a command, and a parameter expansion or glob
 * can SPLIT into extra arguments (`MESSAGE='fix --all'; git commit -m $MESSAGE` commits tracked edits). The
 * tokenizer drops quotes, so a quoted `$` cannot be told apart from an unquoted one; every expansion is
 * treated as unknown (review 2026-10-06).
 */
const EXECUTABLE_EXPANSION = /[$`*?[{]|[<>]\(|^~/;
/** Short clusters of plain letters, optionally ending in `m` (value next): `-am`, `-qam`. */
const SHORT_CLUSTER = /^-[aqsnv]+m?$/;

/**
 * The positively supported form: the WHOLE command is one `git commit` segment whose every token is a
 * listed flag or a flag value. Returns whether it is `-a`, or null for anything else — another command
 * before it (`git apply --cached`, `git add`, `cd`), an environment or `git -c` override, a pathspec,
 * `--amend`, `-p`, a redirect (review 2026-10-06: a parser that recognized only `git add` still narrowed
 * `git apply --cached p && git commit`).
 */
function plainCommit(command: string): { all: boolean } | null {
	const segments = splitSegments(command);
	if (segments.length !== 1) return null;
	const tokens = shellSplit(segments[0] ?? "");
	if (tokens[0] !== "git" || tokens[1] !== "commit") return null;
	// A flag VALUE can execute too: `-m "$(git add src/b.ts; echo fix)"` stages before committing (review 2026-10-06).
	if (tokens.some((token) => EXECUTABLE_EXPANSION.test(token))) return null;
	let all = false;
	for (let i = 2; i < tokens.length; i++) {
		const flag = commitFlag(tokens[i] ?? "");
		if (flag === null) return null;
		all ||= flag.all;
		if (flag.takesValue && ++i >= tokens.length) return null;
	}
	return { all };
}

/** One token of the supported form, or null when it is not a listed flag. */
function commitFlag(token: string): { all: boolean; takesValue: boolean } | null {
	if (SHORT_CLUSTER.test(token)) return { all: token.includes("a"), takesValue: token.endsWith("m") };
	if (VALUE_FLAGS.has(token)) return { all: false, takesValue: true };
	if (PLAIN_FLAGS.has(token)) return { all: token === "-a" || token === "--all", takesValue: false };
	return VALUE_FLAG_ASSIGNED.test(token) ? { all: false, takesValue: false } : null;
}

/** The files the commit will capture, or null when the scope is not certain. */
export function committedFiles(command: string, eventCwd: string, deps: CommitFileSetDeps = DEFAULT_DEPS): CommitScope | null {
	const plain = plainCommit(command);
	if (plain === null) return null;
	const root = deps.resolveRepoRoot(eventCwd);
	if (root === null) return null;
	const changed = deps.gitChangedFiles(root, !plain.all, false);
	if (changed === null) return null;
	return { root, files: new Set(changed.map((path) => resolve(root, path))) };
}

/**
 * One identity per file: git reports the PHYSICAL toplevel while session tracking keeps paths as the agent
 * reached them (through a symlinked checkout, `/var` vs `/private/var`), so both sides are resolved through
 * the nearest existing ancestor. Only the DIRECTORY part is resolved: the final segment keeps its name, so
 * a git symlink entry (`alias.ts -> src/a.ts`) stays a different file from its target, and a deleted file
 * keeps its name under its canonical parent (review 2026-10-05).
 */
function canonicalPath(path: string): string {
	return join(canonicalDirectory(dirname(path)), basename(path));
}

function canonicalDirectory(path: string): string {
	const missing: string[] = [];
	let current = path;
	for (;;) {
		try {
			return join(realpathSync(current), ...missing.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return path;
			missing.push(basename(current));
			current = parent;
		}
	}
}

function inScope(scope: CommitScope): (file: string) => boolean {
	const files = new Set([...scope.files].map(canonicalPath));
	return (file) => files.has(canonicalPath(isAbsolute(file) ? file : resolve(scope.root, file)));
}

/**
 * The ONLY checks narrowed to the commit: each loops over `session.files_written` and attaches the very
 * file whose content it judged, so `file` is the evidence location. Every other producer is kept: review
 * rounds (2026-10-05) found producers whose `file` is not evidence — the `<session>` sentinel for
 * aggregates, `tdd_commit_gate` naming a cycle's source when the commit holds only its test, and
 * `assertion_count_regression` naming the first session test file as an example of a sum. An allowlist
 * keeps a new or unknown producer reported; a denylist silently dropped each one until a review caught it.
 */
const FILE_EVIDENCE_CHECKS: ReadonlySet<string> = new Set([
	"prod_delta_no_test_delta",
	"tpp_leapfrog",
	"reintroduces_removed_code",
]);

/**
 * Narrow the FILE_EVIDENCE_CHECKS advisories to files in the commit; keep everything when `committed` is
 * null, every other check, and every `error` (it can block the commit).
 */
export function scopeToCommit<T extends { name?: string; file?: string | undefined; severity?: string }>(results: T[], committed: CommitScope | null): T[] {
	if (committed === null) return results;
	const inCommit = inScope(committed);
	const narrowed = (result: T): boolean =>
		FILE_EVIDENCE_CHECKS.has(result.name ?? "") && result.severity !== "error" && result.file !== undefined;
	return results.filter((result) => !narrowed(result) || inCommit(result.file ?? ""));
}

/**
 * A session view whose `files_written` holds only committed files, for a detector that caps its results:
 * `checkReintroducesRemovedCode` stops at 5 findings, so filtering its OUTPUT let unstaged files use up the
 * cap before a committed file was examined (review 2026-10-06). Returns the session unchanged when the
 * scope is unknown.
 */
export function sessionForCommit(session: SessionTrajectory, committed: CommitScope | null): SessionTrajectory {
	if (committed === null) return session;
	const inCommit = inScope(committed);
	return { ...session, files_written: new Set([...session.files_written].filter(inCommit)) };
}
