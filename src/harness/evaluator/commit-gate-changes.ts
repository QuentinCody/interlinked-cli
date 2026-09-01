// ===========================================
// Commit gate — changed-file selection
// ===========================================
// "WHICH files does this commit evaluate?" — extracted from `commit-gate.ts`
// (line cap) so the gate module keeps only the run + scan + decision flow. This
// module owns the real git queries (changed files, repo toplevel), the
// constructed-pathspec rebase + narrow filter, and the scan/deletion split.
// Pure apart from the two `git` shell-outs, every function injectable-friendly:
// the gate's unit tests stub `gitChangedFiles`/`readFile` and never spawn git.

import { execFileSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type CoverageLanguage, coverageLanguageForPath } from "../coverage-runner.js";
import { isCappableFile } from "../large-file-policy.js";
import type { ChangedSource } from "./commit-gate-scan.js";

/** How the gate models the commit's would-be tree (see `resolveEvalTarget`). */
export type EvalMode = "index" | "tracked" | "worktree";

/**
 * List the repo-relative POSIX paths of source files changed for the commit about
 * to run. `stagedOnly` (a plain `git commit`) returns ONLY the staged set — the
 * exact files the commit captures; otherwise (`-a`/`--all`) it returns the working
 * tree's tracked changes too. Returns `null` when the diff could not be taken (git
 * missing, not a repo) — the gate fail-opens on `null`.
 */
export type GitChangedFilesFn = (
	projectRoot: string,
	stagedOnly?: boolean,
	includeUntracked?: boolean,
) => string[] | null;

/** Shared timeout for the short-lived read-only `git` invocations the gate runs. */
const GIT_TIMEOUT_MS = 5_000;

/** Run one read-only `git` command, returning its trimmed nonempty lines or null. */
function gitLines(projectRoot: string, args: string[]): string[] | null {
	try {
		const out = execFileSync("git", args, {
			cwd: projectRoot,
			encoding: "utf-8",
			timeout: GIT_TIMEOUT_MS,
		});
		return out
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
	} catch {
		return null;
	}
}

/**
 * The real changed-files function. `stagedOnly` (a plain `git commit`) returns
 * just `git diff --cached --name-only` — the staged set the commit will capture.
 * Otherwise (`-a`/`--all`, which stages tracked edits first) it UNIONs `git diff
 * --name-only HEAD` (working tree vs HEAD) with the staged set. `includeUntracked`
 * (CONSTRUCTED commits only — `git add … && git commit`) additionally unions
 * `git ls-files --others --exclude-standard`: the add stages NEW files at run time,
 * while `git diff` never lists them, so without this a brand-new uncovered source
 * sailed through the gate (finding 2026-06). Plain `-a` never stages untracked
 * files, so `tracked` mode keeps them excluded. Read-only. Returns `null` only when
 * every needed git invocation fails so the gate fail-opens rather than blocking
 * when git can't answer at all.
 */
export function defaultGitChangedFiles(
	projectRoot: string,
	stagedOnly = false,
	includeUntracked = false,
): string[] | null {
	const staged = gitLines(projectRoot, ["diff", "--cached", "--name-only"]);
	if (stagedOnly) return staged; // a plain commit captures the index only
	const worktree = gitLines(projectRoot, ["diff", "--name-only", "HEAD"]);
	const untracked = includeUntracked
		? gitLines(projectRoot, ["ls-files", "--others", "--exclude-standard"])
		: [];
	if (worktree === null && staged === null && untracked === null) return null; // git unusable
	return [...new Set<string>([...(worktree ?? []), ...(staged ?? []), ...(untracked ?? [])])];
}

/**
 * The git repository TOPLEVEL for a directory (`git rev-parse --show-toplevel`),
 * or null when not a repo / git fails. Git emits changed-file paths relative to the
 * TOPLEVEL, so the gate must anchor there: evaluating from a subdirectory
 * (`cd src && git commit -a`) would otherwise resolve `src/a.ts` against
 * `/repo/src` → `/repo/src/src/a.ts` and silently skip every changed source
 * (finding 2026-06).
 */
export function defaultResolveRepoRoot(dir: string): string | null {
	const lines = gitLines(dir, ["rev-parse", "--show-toplevel"]);
	return lines !== null && lines.length > 0 ? (lines[0] ?? null) : null;
}

// ===========================================
// Changed-source selection (language mapping shared with the per-edit gate via
// `coverageLanguageForPath` — one extension→language table, never mirrored)
// ===========================================

/** The selection split: files to SCAN (content on disk) and gated-language
 *  paths that are DELETED in this commit. Deletions cannot be coverage /
 *  cyclomatic scan targets, but they MUST still trigger the red-bar suite run —
 *  a commit that only deletes a source file previously skipped the suite
 *  entirely and could land a deletion that breaks imports or tests (finding
 *  2026-06). */
interface SelectedChanges {
	sources: ChangedSource[];
	/** Repo-relative paths of gated-language files absent from the evaluation
	 *  tree (deleted by this commit). Their LANGUAGES join the suite run. */
	deletedPaths: string[];
	/** Languages the suite must run for: every scanned source's language plus
	 *  every deletion's language, deduped. */
	suiteLanguages: CoverageLanguage[];
}

/**
 * Split the raw changed-path list into the source files the gate SCANS — a
 * supported language, in the configured `languages` set, and a "cappable" file
 * (the same predicate the line cap uses — excludes test files, generated code,
 * `.d.ts`, non-code) — and the gated-language paths that are DELETED
 * (unreadable from the evaluation tree). Deletions skip the cappable check
 * (it needs content) but never skip the suite: deleting a test or generated
 * file can still break other tests, and the suite is the only honest oracle.
 *
 * NON-cappable changes (test / generated files) likewise contribute their
 * LANGUAGE to the suite run even though they are never scan sources: a commit
 * touching only `*.test.ts` previously left `suiteLanguages` empty and the gate
 * returned without running anything — a FAILING test edit could be committed
 * straight through the default-on gate (finding 2026-06). Declaration-only
 * `.d.ts` files are the one exemption: they carry no runtime behavior a suite
 * could observe (`.pyi` stubs never reach here — they map to no coverage
 * language at all).
 */
export function selectChangedSources(
	rawPaths: string[],
	projectRoot: string,
	languages: string[],
	readFile: (absPath: string) => string | null,
): SelectedChanges {
	const sources: ChangedSource[] = [];
	const deletedPaths: string[] = [];
	const suiteLanguages = new Set<CoverageLanguage>();
	for (const relPath of rawPaths) {
		const language = coverageLanguageForPath(relPath);
		if (!language || !languages.includes(language)) continue;
		const abs = isAbsolute(relPath) ? relPath : resolve(projectRoot, relPath);
		const content = readFile(abs);
		if (content === null) {
			// Absent from the evaluation tree → deleted by this commit (or a raced
			// deletion). Not scannable, but the deletion's language still runs.
			deletedPaths.push(relPath);
			suiteLanguages.add(language);
			continue;
		}
		if (!isCappableFile({ filePath: relPath, content })) {
			// Test / generated files are still EXECUTABLE gated-language code the
			// commit captures — a red test edit must not land (finding 2026-06).
			if (!relPath.endsWith(".d.ts")) suiteLanguages.add(language);
			continue;
		}
		sources.push({ relPath, language });
		suiteLanguages.add(language);
	}
	return { sources, deletedPaths, suiteLanguages: [...suiteLanguages] };
}

// ===========================================
// Narrow-commit changed-set resolution
// ===========================================

/**
 * Restrict changed files to those a NARROW constructed-content commit actually stages
 * — an exact pathspec, or a file under a named directory pathspec. Repo-relative on
 * both sides (the pathspecs resolve against the same projectRoot as the changed-files
 * query). This is what keeps an unrelated dirty file from blocking the commit.
 */
function filterToConstructedPaths(files: string[], specs: string[]): string[] {
	const norms = specs.map((p) => p.replace(/^\.\//, "").replace(/\/+$/, ""));
	return files.filter((f) => norms.some((p) => f === p || f.startsWith(`${p}/`)));
}

/**
 * Rebase the parser's constructed pathspecs — which are relative to the COMMAND's
 * effective directory — onto the repository TOPLEVEL, the frame `git` emits
 * changed-file paths in. Without this, `cd packages/app && git add src/a.ts &&
 * git commit` filtered toplevel-relative `packages/app/src/a.ts` against the raw
 * spec `src/a.ts`, matched nothing, and the staged file bypassed the gate
 * (finding 2026-06). Returns `null` — "treat as BROAD, evaluate everything" —
 * when any spec resolves to the repo root itself (`git commit .` names the whole
 * tree) or escapes it (`../outside`): the narrow filter exists only to avoid
 * false blocks, so unresolvable rebases fail toward evaluating MORE, never less.
 */
export function rebaseConstructedPaths(
	specs: string[],
	commandCwd: string,
	projectRoot: string,
): string[] | null {
	const root = resolve(projectRoot);
	const out: string[] = [];
	for (const spec of specs) {
		const rel = relative(root, resolve(commandCwd, spec));
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
		out.push(rel.split(sep).join("/"));
	}
	return out;
}

/**
 * The changed-file set the gate evaluates for this commit. A NARROW constructed
 * commit filters to its constructed paths — but when the commit ALSO captures the
 * PRE-EXISTING staged index (`git add p && git commit`, which commits the whole
 * index, or `git commit --include q`) the staged set is UNIONED back in: filtering
 * to constructedPaths alone let an already-staged source file's violations bypass
 * the quality bar entirely (finding 2026-06). When the staged set cannot be read,
 * fall back to the FULL changed set — the narrow filter exists only to avoid false
 * blocks, so unknowable fails toward evaluating MORE, never less. (The staged
 * files are evaluated at their WORKTREE content, like every constructed-commit
 * path — the standing superset approximation for this mode.)
 */
export function changedSetForCommit(
	allChanged: string[],
	parse: { constructedPaths?: string[]; includesIndex?: boolean },
	mode: EvalMode,
	stagedSet: () => string[] | null,
): string[] {
	if (mode !== "worktree" || !parse.constructedPaths) return allChanged;
	const narrow = filterToConstructedPaths(allChanged, parse.constructedPaths);
	if (!parse.includesIndex) return narrow;
	const staged = stagedSet();
	if (staged === null) return allChanged;
	return [...new Set([...narrow, ...staged])];
}
