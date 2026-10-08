// ===========================================
// PreToolUse Bash gate — COMMIT-TIME shippability backstop (WARN-only)
// ===========================================
// Two defects reached the slow pre-push gate that a cheap check at `git commit`
// could have named:
//   A. a committed code file imports a file that is untracked or gitignored, so
//      a clean checkout of the commit does not build;
//   B. a CI workflow runs a repository script that the checkout will not have
//      (`scripts/*` is gitignored by default, so a script there is invisible).
//
// CALLING CONVENTION: WARN-only, the same as `runCommitJitGate` — it appends to
// `preDecision.warnings` and returns void. It never blocks, never throws, and
// any git failure becomes ONE `NOT CHECKED` line.
//
// Scope and limits (documented, not hidden):
//   - The index is judged. `git add -A && git commit` has not staged yet at
//     PreToolUse, so those commits are judged on what is staged now.
//   - Check B has no YAML parser: it reads `run:` values (inline and block
//     scalars) and extracts repository-relative `(scripts|src|bin|tools)/…`
//     paths ending in mjs/cjs/js/ts/sh/py with `WORKFLOW_PATH`. It will miss
//     paths built from variables or expressions.

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { analyzeSyntax } from "../../lib/metrics/analysis-syntax.js";
import { resolveSourceTarget } from "../../lib/metrics/graph-entries.js";
import { parseTsSource } from "../checks/cyclomatic-ast.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { gitShow, resolveRepoRoot } from "./commit-git-io.js";
import { parseGitCommit } from "./commit-parse.js";
import { readToolString } from "./tool-input-values.js";

const TAG = "[interlinked:commit-shippability]";
const MAX_STAGED_FILES = 200;
const MAX_REPORTED = 10;
const GIT_TIMEOUT_MS = 3_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const CODE_FILE = /\.(?:ts|tsx|js|mjs|cjs|mts)$/;
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const SHIPPED_DIR = /^(?:scripts|src|bin|tools)\//;
const RELATIVE_SPECIFIER = /^\.\.?(?:\/|$)/;
const RUN_LINE = /^\s*(?:-\s+)?run:/;
const BLOCK_SCALAR = /^[|>][+-]?\s*(?:#.*)?$/;
/** Deliberate, documented regex: a repo-relative script path inside a `run:` value (the whole match is the path). */
const WORKFLOW_PATH = /(?<![\w./-])(?:\.\/)?(?:scripts|src|bin|tools)\/[\w./@-]+\.(?:mjs|cjs|js|ts|sh|py)(?![\w/-])/g;

interface RepoView {
	root: string;
	/** Tracked in the index (this includes staged additions). */
	shippable: ReadonlySet<string>;
}

/** Existence oracle for resolveSourceTarget: only `has` is consulted, and only for regular files. */
class DiskFiles extends Set<string> {
	constructor(private readonly root: string) {
		super();
	}
	override has(path: string): boolean {
		try {
			return statSync(join(this.root, path)).isFile();
		} catch {
			return false;
		}
	}
}

function notChecked(reason: string): string {
	return `${TAG} NOT CHECKED: ${reason}`;
}

/** NUL-separated git output as a list, or null when git failed or timed out. */
function gitList(root: string, args: string[]): string[] | null {
	const result = spawnSync("git", ["-C", root, ...args], {
		encoding: "utf-8",
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: GIT_MAX_BUFFER,
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.error || result.status !== 0) return null;
	return result.stdout.split("\0").filter(Boolean);
}

function isIgnored(root: string, path: string): boolean {
	const result = spawnSync("git", ["-C", root, "check-ignore", "-q", "--", path], { timeout: GIT_TIMEOUT_MS, stdio: "ignore" });
	return result.status === 0;
}

function stateOf(root: string, path: string, onDisk: boolean): "ignored" | "untracked" | "missing" {
	if (isIgnored(root, path)) return "ignored";
	return onDisk ? "untracked" : "missing";
}

function importFindings(view: RepoView, file: string, content: string): string[] | null {
	const parsed = parseTsSource(content, file);
	if (!parsed) return null;
	const disk = new DiskFiles(view.root);
	const out: string[] = [];
	for (const ref of analyzeSyntax(parsed).imports) {
		if (!ref.specifier || !RELATIVE_SPECIFIER.test(ref.specifier)) continue;
		const target = posix.join(posix.dirname(file), ref.specifier);
		if (target.startsWith("../") || resolveSourceTarget(target, view.shippable)) continue;
		const found = resolveSourceTarget(target, disk);
		if (!found) continue;
		out.push(`${TAG} ${file}:${ref.line} imports ${found}, which is ${stateOf(view.root, found, true)} — a clean checkout of this commit will not have it.`);
	}
	return out;
}

/** Check A over the staged code files; the second member is a NOT CHECKED reason. */
function checkImports(view: RepoView, staged: string[]): { lines: string[]; skipped?: string } {
	const lines: string[] = [];
	for (const file of staged.filter((f) => CODE_FILE.test(f))) {
		const content = gitShow(view.root, `:${file}`);
		if (content === null) continue;
		const found = importFindings(view, file, content);
		if (!found) return { lines, skipped: "the typescript parser is unavailable, so staged imports were not inspected." };
		lines.push(...found);
	}
	return { lines };
}

/** The text of every `run:` value: inline values and the lines of `|` / `>` block scalars. */
function runValueLines(yaml: string): string[] {
	const out: string[] = [];
	let blockIndent = -1;
	for (const line of yaml.split("\n")) {
		const indent = line.length - line.trimStart().length;
		if (blockIndent >= 0 && (line.trim() === "" || indent > blockIndent)) {
			out.push(line);
			continue;
		}
		blockIndent = -1;
		if (!RUN_LINE.test(line)) continue;
		const keyColumn = line.indexOf("run:");
		const value = line.slice(keyColumn + "run:".length).trim();
		if (BLOCK_SCALAR.test(value)) blockIndent = keyColumn;
		else out.push(value);
	}
	return out;
}

function workflowScriptPaths(yaml: string): string[] {
	const paths = new Set<string>();
	for (const line of runValueLines(yaml)) {
		for (const match of line.matchAll(WORKFLOW_PATH)) paths.add(match[0].replace(/^\.\//, ""));
	}
	return [...paths];
}

function workflowFindings(view: RepoView, workflow: string): string[] {
	const content = gitShow(view.root, `:${workflow}`);
	if (content === null) return [];
	return workflowScriptPaths(content)
		.filter((path) => !view.shippable.has(path))
		.map((path) => {
			const state = stateOf(view.root, path, existsSync(resolve(view.root, path)));
			return `${TAG} ${workflow} runs ${path}, which is ${state} — CI's checkout will not have it.`;
		});
}

/** Check B: only when the commit stages a workflow or a file under a directory workflows run from. */
function checkWorkflows(view: RepoView, staged: string[]): string[] {
	if (!staged.some((f) => WORKFLOW_FILE.test(f) || SHIPPED_DIR.test(f))) return [];
	const workflows = [...view.shippable].filter((f) => WORKFLOW_FILE.test(f));
	return workflows.flatMap((workflow) => workflowFindings(view, workflow));
}

function collectLines(root: string): string[] {
	const stagedAll = gitList(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]);
	if (!stagedAll) return [notChecked("git diff --cached failed.")];
	const tracked = gitList(root, ["ls-files", "-z"]);
	if (!tracked) return [notChecked("git ls-files failed.")];
	const staged = stagedAll.slice(0, MAX_STAGED_FILES);
	const view: RepoView = { root, shippable: new Set([...tracked, ...stagedAll]) };
	const imports = checkImports(view, staged);
	const findings = [...imports.lines, ...checkWorkflows(view, staged)];
	const shown = findings.slice(0, MAX_REPORTED);
	const hidden = findings.length - shown.length;
	if (hidden > 0) shown.push(`${TAG} and ${hidden} more finding(s) not shown.`);
	if (imports.skipped) shown.push(notChecked(imports.skipped));
	const omitted = stagedAll.length - staged.length;
	if (omitted > 0) shown.push(notChecked(`only the first ${MAX_STAGED_FILES} of ${stagedAll.length} staged files were inspected.`));
	return shown;
}

function commitLines(event: HarnessEvent): string[] {
	const parse = parseGitCommit(readToolString(event.tool_input?.command));
	if (!parse?.isCommit) return [];
	const baseCwd = event.cwd || process.cwd();
	const dir = parse.cwd ? resolve(baseCwd, parse.cwd) : baseCwd;
	const root = resolveRepoRoot(dir);
	return root ? collectLines(root) : [notChecked(`${dir} is not inside a git repository.`)];
}

/** Pipeline entry: appends shippability warnings for a real `git commit`; a no-op otherwise. Never blocks, never throws. */
export function runCommitShippabilityGate(event: HarnessEvent, preDecision: HarnessDecision): void {
	if (preDecision.decision !== "allow" || event.tool_name !== "Bash") return;
	let lines: string[];
	try {
		lines = commitLines(event);
	} catch {
		lines = [notChecked("an unexpected error stopped the check.")];
	}
	if (lines.length > 0) preDecision.warnings = [...(preDecision.warnings ?? []), ...lines];
}
