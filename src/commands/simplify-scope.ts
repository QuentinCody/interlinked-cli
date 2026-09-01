// ===========================================
// Simplification review — repository identity and git scope discovery
// ===========================================

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import type {
	SimplificationRepositoryIdentity,
	SimplificationScopeKind,
	SimplificationScopeReceipt,
} from "../lib/simplification-types.js";
import { isJsonObject } from "../lib/json-types.js";

interface GitCall {
	cwd: string;
	args: string[];
}

type SimplifyGitRunner = (call: GitCall) => string;

const defaultGitRunner: SimplifyGitRunner = ({ cwd, args }) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		timeout: 15_000,
		stdio: ["pipe", "pipe", "pipe"],
	});

function optionalGit(call: GitCall, runner: SimplifyGitRunner): string | null {
	try {
		const value = runner(call).trim();
		return value.length > 0 ? value : null;
	} catch {
		return null;
	}
}

function nulPaths(output: string): string[] {
	return output
		.split("\0")
		.map((path) => path.replace(/\\/g, "/"))
		.filter((path) => path.length > 0 && !path.startsWith("../") && !path.startsWith("/"));
}

function sortedUnique(paths: Iterable<string>): string[] {
	return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

function assertSelectedSnapshotMatches(args: {
	cwd: string;
	runner: SimplifyGitRunner;
	selected: readonly string[];
	comparisonRef?: string;
	label: string;
}): void {
	if (args.selected.length === 0) return;
	const command = args.comparisonRef
		? ["diff", "--name-only", "-z", args.comparisonRef, "--"]
		: ["diff", "--name-only", "-z", "--"];
	const drift = new Set(nulPaths(requiredGit(
		{ cwd: args.cwd, args: command },
		args.runner,
		`unable to verify ${args.label} content against the working tree`,
	)));
	const mismatches = args.selected.filter((path) => drift.has(path));
	if (mismatches.length > 0) {
		throw new Error(
			`${args.label} selected path content differs from the working tree: ${mismatches.join(", ")}`,
		);
	}
}

function requiredGit(call: GitCall, runner: SimplifyGitRunner, failure: string): string {
	try {
		return runner(call);
	} catch {
		throw new Error(failure);
	}
}

interface ParsedRange {
	base: string;
	head: string;
	expression: string;
}

function parseRange(expression: string): ParsedRange {
	const match = expression.match(
		/^([A-Za-z0-9][A-Za-z0-9._/@~^{}+\-]*)(\.\.\.?)([A-Za-z0-9][A-Za-z0-9._/@~^{}+\-]*)$/,
	);
	if (!match?.[1] || !match[2] || !match[3]) {
		throw new Error("--range must be an explicit <base>..<head> or <base>...<head> git range");
	}
	return { base: match[1], head: match[3], expression: `${match[1]}${match[2]}${match[3]}` };
}

function resolveCommit(cwd: string, ref: string, runner: SimplifyGitRunner): string {
	return requiredGit(
		{ cwd, args: ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`] },
		runner,
		`git ref is not a commit: ${ref}`,
	).trim();
}

function changedPaths(cwd: string, runner: SimplifyGitRunner): string[] {
	const tracked = optionalGit({ cwd, args: ["diff", "--name-only", "-z", "HEAD", "--"] }, runner);
	const fallbackUnstaged = tracked === null
		? optionalGit({ cwd, args: ["diff", "--name-only", "-z", "--"] }, runner)
		: null;
	const fallbackStaged = tracked === null
		? optionalGit({ cwd, args: ["diff", "--cached", "--name-only", "-z", "--"] }, runner)
		: null;
	const untracked = optionalGit(
		{ cwd, args: ["ls-files", "--others", "--exclude-standard", "-z"] },
		runner,
	);
	if (tracked === null && fallbackUnstaged === null && fallbackStaged === null && untracked === null) {
		throw new Error("changed-file discovery requires a readable git worktree");
	}
	return sortedUnique(
		[tracked, fallbackUnstaged, fallbackStaged, untracked]
			.filter((value): value is string => value !== null)
			.flatMap(nulPaths),
	);
}

interface ResolveReviewScopeOptions {
	cwd: string;
	kind: Exclude<SimplificationScopeKind, "repository">;
	range?: string;
	git?: SimplifyGitRunner;
}

export function resolveReviewScope(options: ResolveReviewScopeOptions): SimplificationScopeReceipt {
	const cwd = resolve(options.cwd);
	const runner = options.git ?? defaultGitRunner;
	if (options.kind === "changed") {
		return {
			kind: "changed",
			range: null,
			base_sha: optionalGit({ cwd, args: ["rev-parse", "HEAD"] }, runner),
			head_sha: null,
			selected_paths: changedPaths(cwd, runner),
		};
	}
	if (options.kind === "staged") {
		const output = requiredGit(
			{ cwd, args: ["diff", "--cached", "--name-only", "-z", "--"] },
			runner,
			"staged-file discovery requires a readable git index",
		);
		const selected = sortedUnique(nulPaths(output));
		assertSelectedSnapshotMatches({
			cwd,
			runner,
			selected,
			label: "staged index",
		});
		return {
			kind: "staged",
			range: null,
			base_sha: optionalGit({ cwd, args: ["rev-parse", "HEAD"] }, runner),
			head_sha: null,
			selected_paths: selected,
		};
	}
	if (!options.range) {
		throw new Error("review range scope requires --range <base>..<head>");
	}
	const parsed = parseRange(options.range);
	const baseSha = resolveCommit(cwd, parsed.base, runner);
	const headSha = resolveCommit(cwd, parsed.head, runner);
	const output = requiredGit(
		{ cwd, args: ["diff", "--name-only", "-z", parsed.expression, "--"] },
		runner,
		`unable to discover files for git range ${parsed.expression}`,
	);
	const selected = sortedUnique(nulPaths(output));
	assertSelectedSnapshotMatches({
		cwd,
		runner,
		selected,
		comparisonRef: headSha,
		label: `range head ${headSha}`,
	});
	return {
		kind: "range",
		range: parsed.expression,
		base_sha: baseSha,
		head_sha: headSha,
		selected_paths: selected,
	};
}

export function repositoryScope(headSha: string | null): SimplificationScopeReceipt {
	return {
		kind: "repository",
		range: null,
		base_sha: headSha,
		head_sha: headSha,
		selected_paths: null,
	};
}

function workingTreeHash(cwd: string, files: string[]): string {
	const hash = createHash("sha256");
	for (const file of [...files].sort((a, b) => a.localeCompare(b))) {
		const rel = relative(cwd, file).replace(/\\/g, "/");
		try {
			hash.update(rel);
			hash.update("\0");
			hash.update(readFileSync(file));
			hash.update("\0");
		} catch {
			hash.update(`${rel}\0<unreadable>\0`);
		}
	}
	return hash.digest("hex");
}

function normalizeRemoteIdentity(value: string): string {
	return value
		.trim()
		.replace(/^git@([^:]+):/, "$1/")
		.replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?/i, "")
		.replace(/\.git$/, "")
		.replace(/\/$/, "")
		.toLowerCase();
}

function localPackageName(cwd: string): string | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8"));
		if (!isJsonObject(parsed)) return null;
		const name = parsed.name;
		return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
	} catch {
		return null;
	}
}

function stableRepositoryId(cwd: string, runner: SimplifyGitRunner): string {
	const remote = optionalGit({ cwd, args: ["config", "--get", "remote.origin.url"] }, runner);
	const roots = optionalGit({ cwd, args: ["rev-list", "--max-parents=0", "HEAD"] }, runner);
	const material = remote
		? `remote\0${normalizeRemoteIdentity(remote)}`
		: roots
			? `root-commits\0${roots.split(/\s+/).sort().join("\0")}`
			: `local\0${localPackageName(cwd) ?? basename(cwd)}`;
	return `repo-${createHash("sha256").update(material).digest("hex").slice(0, 24)}`;
}

interface RepositoryIdentityOptions {
	cwd: string;
	files: string[];
	git?: SimplifyGitRunner;
}

export function repositoryIdentity(options: RepositoryIdentityOptions): SimplificationRepositoryIdentity {
	const cwd = resolve(options.cwd);
	const runner = options.git ?? defaultGitRunner;
	return {
		repository_id: stableRepositoryId(cwd, runner),
		root: cwd,
		head_sha: optionalGit({ cwd, args: ["rev-parse", "HEAD"] }, runner),
		tree_sha: optionalGit({ cwd, args: ["rev-parse", "HEAD^{tree}"] }, runner),
		working_tree_sha256: workingTreeHash(cwd, options.files),
	};
}
