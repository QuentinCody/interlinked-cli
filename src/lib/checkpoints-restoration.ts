import { isAbsolute, relative, sep } from "node:path";
import { getConfigDir, getDataDir } from "./config.js";
import { gitArgs, gitArgsRaw } from "./git-shell.js";

export interface CheckpointSnapshotPlan {
	objectId: string;
	indexId: string;
	untrackedId?: string;
	untrackedPaths: string[];
}

export function isGitObjectId(value: string): boolean {
	return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

export function checkpointStatePaths(cwd: string): string[] {
	const directories = [getConfigDir(cwd), getDataDir(cwd)];
	const relativePaths = directories.map((directory) => relative(cwd, directory).split(sep).join("/") || "checkpoints.json");
	const paths = [".interlinked", ...relativePaths];
	return [...new Set(paths.filter((path) => path !== ".." && !path.startsWith("../")))];
}

export function checkpointStateExclusions(cwd: string): string[] {
	return checkpointStatePaths(cwd).map((path) => `:(literal,exclude)${path}`);
}

export function findCheckpointSnapshot(cwd: string, id: string): string | undefined {
	const stashList = gitArgs(["stash", "list", "--format=%H:%s"], cwd);
	for (const line of stashList.split("\n")) {
		if (line.includes(`interlinked:checkpoint:${id}:`)) return line.slice(0, line.indexOf(":"));
	}
	return undefined;
}

function snapshotPaths(cwd: string, objectId: string): string[] {
	const paths = gitArgsRaw(["ls-tree", "-r", "--name-only", "-z", objectId], cwd).split("\0").filter(Boolean);
	for (const path of paths) {
		if (isAbsolute(path) || path.split("/").some((part) => part === ".." || part === "." || part.toLowerCase() === ".git")) {
			throw new Error("Invalid checkpoint snapshot path");
		}
	}
	return paths;
}

/** Inspect every selected tree before any forced index/worktree mutation. */
export function prepareCheckpointSnapshot(cwd: string, objectId: string, baseCommit: string): CheckpointSnapshotPlan {
	if (!isGitObjectId(objectId) || !isGitObjectId(baseCommit)) throw new Error("Invalid checkpoint snapshot object ID");
	const parents = gitArgs(["rev-list", "--parents", "-n", "1", objectId], cwd).split(/\s+/);
	if ((parents.length !== 3 && parents.length !== 4) || !parents.every(isGitObjectId)) {
		throw new Error("Invalid checkpoint snapshot parents");
	}
	if (parents[0]?.toLowerCase() !== objectId.toLowerCase() || parents[1]?.toLowerCase() !== baseCommit.toLowerCase()) {
		throw new Error("Snapshot base commit differs from metadata");
	}
	const indexId = parents[2];
	if (indexId === undefined) throw new Error("Missing checkpoint index snapshot");
	snapshotPaths(cwd, baseCommit);
	snapshotPaths(cwd, objectId);
	snapshotPaths(cwd, indexId);
	const untrackedId = parents[3];
	const statePaths = checkpointStatePaths(cwd);
	const untrackedPaths = untrackedId === undefined
		? []
		: snapshotPaths(cwd, untrackedId).filter((file) =>
			!statePaths.some((path) => file === path || file.startsWith(`${path}/`)),
		);
	return { objectId, indexId, ...(untrackedId === undefined ? {} : { untrackedId }), untrackedPaths };
}

/** Apply source trees without replacing tracked or untracked Interlinked state. */
export function restoreCheckpointSnapshot(cwd: string, plan: CheckpointSnapshotPlan): void {
	const exclusions = checkpointStateExclusions(cwd);
	gitArgs(["restore", "--source", plan.objectId, "--worktree", "--", ".", ...exclusions], cwd);
	gitArgs(["restore", "--source", plan.indexId, "--staged", "--", ".", ...exclusions], cwd);
	if (plan.untrackedId !== undefined && plan.untrackedPaths.length > 0) {
		gitArgs(["restore", "--source", plan.untrackedId, "--worktree", "--", ...plan.untrackedPaths.map((path) => `:(literal)${path}`)], cwd);
	}
}
