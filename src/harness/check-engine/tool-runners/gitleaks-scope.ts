import { existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { currentProcessSignal } from "../process-cancellation.js";
import { runProcessAsync } from "../spawn-async.js";
import type { ToolInputScope } from "../types.js";

export type GitleaksInputScope = NonNullable<ToolInputScope["selection"]>;

/** Working inputs omit generated/control/history trees, while tracked files
 * remain explicit exceptions. Git storage is always outside working inputs. */
const OMITTED_DIRECTORIES = new Set([
	".git", ".interlinked", ".archive", "node_modules", "dist", "build", "coverage",
	"target", "__pycache__", ".venv", "venv",
]);
const WORKTREE_STORES = new Set([".claude/worktrees", ".codex/worktrees"]);

export interface GitleaksScope {
	files: string[];
	targets: string[];
	excluded: string[];
	unavailable: Array<{ file: string; reason: string }>;
}

/** Pin root policy for every native subtarget, without adding inheritance. */
export function gitleaksConfiguration(root: string): { args: string[]; env: NodeJS.ProcessEnv; file?: string } {
	const env = { ...process.env };
	const configured = env.GITLEAKS_CONFIG;
	if (configured) {
		const file = resolve(root, configured);
		return { args: ["--config", file], env, file };
	}
	if (env.GITLEAKS_CONFIG_TOML) return { args: [], env };
	const file = join(root, ".gitleaks.toml");
	if (existsSync(file)) return { args: ["--config", file], env, file };
	// Prevent per-subdirectory config discovery from changing embedded defaults.
	env.GITLEAKS_CONFIG_TOML = "[extend]\nuseDefault=true\n";
	return { args: [], env };
}

async function gitInventory(root: string, remaining: () => number, selection: GitleaksInputScope): Promise<{ tracked: string[]; visible?: string[] }> {
	const probe = await readProjectGit(root, ["rev-parse", "--is-inside-work-tree"], remaining);
	if (probe.killed || probe.timedOut || probe.stdoutTruncated || probe.stderrTruncated) throw new Error("Git working-input discovery incomplete; no complete Gitleaks scope");
	if (probe.code !== 0 || probe.stdout.trim() !== "true") {
		if (selection === "working-tree" && probe.code === 128 && !existsSync(join(root, ".git"))) return { tracked: [] };
		throw new Error("Git working-input discovery failed; no complete Gitleaks scope");
	}
	const tracked = await gitFileList(root, remaining, ["--cached"]);
	if (selection === "working-tree") return { tracked };
	const visible = await gitFileList(root, remaining, ["--cached", "--others", "--exclude-standard"]);
	return { tracked, visible };
}

async function gitFileList(root: string, remaining: () => number, flags: string[]): Promise<string[]> {
	const result = await readProjectGit(root, ["ls-files", ...flags, "-z"], remaining);
	if (result.code !== 0 || result.killed || result.timedOut || result.stdoutTruncated || result.stderrTruncated) {
		throw new Error("Git tracked-input discovery failed; no complete Gitleaks scope");
	}
	const files = result.stdout.split("\0").filter(Boolean);
	if (files.some(file => isAbsolute(file) || file.split("/").includes(".."))) throw new Error("Git returned an invalid working-input path");
	return files;
}

async function readProjectGit(root: string, args: string[], remaining: () => number) {
	const env = { ...process.env };
	for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[name];
	const result = await runProcessAsync("git", ["-c", "core.fsmonitor=false", ...args], { cwd: root, exactEnv: env, timeout: remaining(), maxBufferBytes: null });
	currentProcessSignal()?.throwIfAborted();
	return result;
}

/** Enumerate all working files, including Git-ignored inputs such as .env.
 * Safe directory targets contain only admitted regular files. */
export async function collectGitleaksScope(root: string, remaining: () => number, selection: GitleaksInputScope = "working-tree"): Promise<GitleaksScope> {
	const { tracked, visible } = await gitInventory(root, remaining, selection);
	const trackedSet = new Set(tracked);
	const ancestors = pathAncestors(tracked);
	const scope: GitleaksScope = { files: [], targets: [], excluded: [], unavailable: [] };
	if (selection === "git-visible") scope.excluded.push("<git-ignored>");
	await walkWorkingDirectory({ root, remaining, trackedSet, ancestors, scope,
		...(visible ? { visible: new Set(visible), visibleAncestors: pathAncestors(visible) } : {}),
	}, "", false);
	scope.files.sort(); scope.targets.sort(); scope.excluded.sort();
	scope.unavailable.sort((a, b) => a.file.localeCompare(b.file));
	return scope;
}

function pathAncestors(files: string[]): Set<string> {
	const ancestors = new Set<string>();
	for (const file of files) {
		const segments = file.split("/");
		for (let count = 1; count < segments.length; count++) ancestors.add(segments.slice(0, count).join("/"));
	}
	return ancestors;
}

interface WorkingInputCensus {
	root: string;
	remaining: () => number;
	trackedSet: Set<string>;
	ancestors: Set<string>;
	visible?: Set<string>;
	visibleAncestors?: Set<string>;
	scope: GitleaksScope;
}

async function walkWorkingDirectory(census: WorkingInputCensus, directory: string, inheritedOmission: boolean): Promise<boolean> {
	const { root, scope, remaining } = census;
	currentProcessSignal()?.throwIfAborted(); remaining();
	const start = scope.targets.length;
	let complete = !inheritedOmission;
	let entries;
	try { entries = await readdir(join(root, directory), { withFileTypes: true }); }
	catch { scope.unavailable.push({ file: directory || ".", reason: "directory unreadable" }); return false; }
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!await visitWorkingInput(census, directory, entry, inheritedOmission)) complete = false;
	}
	if (directory && complete && scope.targets.length > start) scope.targets.splice(start, scope.targets.length - start, directory);
	return complete;
}

async function visitWorkingInput(census: WorkingInputCensus, directory: string, entry: Dirent, inheritedOmission: boolean): Promise<boolean> {
	const { root, remaining, scope } = census;
	currentProcessSignal()?.throwIfAborted(); remaining();
	const plan = selectWorkingInput(census, directory, entry, inheritedOmission);
	if (!plan) return false;
	const { file, omitted } = plan;
	let stat;
	try { stat = await lstat(join(root, file)); }
	catch { scope.unavailable.push({ file, reason: "input unreadable" }); return false; }
	if (stat.isDirectory()) return walkWorkingDirectory(census, file, omitted);
	if (stat.isFile()) { scope.files.push(file); scope.targets.push(file); return true; }
	if (stat.isSymbolicLink() && entry.name === "node_modules" && !census.trackedSet.has(file) && !census.ancestors.has(file)) {
		scope.excluded.push(file);
		return false;
	}
	scope.unavailable.push({ file, reason: "native Gitleaks does not scan this symbolic or non-regular input" });
	return false;
}

/** Separate scope policy from filesystem traversal so omitted paths stay unopened. */
function selectWorkingInput(census: WorkingInputCensus, directory: string, entry: Dirent, inheritedOmission: boolean): { file: string; omitted: boolean } | undefined {
	const { trackedSet, ancestors, scope } = census;
	const file = directory ? `${directory}/${entry.name}` : entry.name;
	if (entry.name === ".git") {
		scope.excluded.push(file); return;
	}
	const generated = OMITTED_DIRECTORIES.has(entry.name) || WORKTREE_STORES.has(file) || file === "scratch";
	const omitted = inheritedOmission || (entry.isDirectory() && generated);
	if (omitted && !inheritedOmission) scope.excluded.push(file);
	if (census.visible && !census.visible.has(file) && !census.visibleAncestors?.has(file)) return;
	if (omitted && !trackedSet.has(file) && !ancestors.has(file)) return;
	return { file, omitted };
}
