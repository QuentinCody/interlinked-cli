import { execFileSync } from "node:child_process";

/** Only groups led by a proved descendant are eligible for supervisor teardown. */
export function descendantGroupsFromTable(table: string, root: number): number[] {
	const rows = table.trim().split("\n").filter(Boolean).map(line => line.trim().split(/\s+/).map(Number));
	if (rows.some(row => row.length !== 3 || row.some(value => !Number.isSafeInteger(value) || value < 0))) {
		throw new Error("Invalid process ownership snapshot");
	}
	const descendants = new Set([root]);
	let previous = -1;
	while (previous !== descendants.size) {
		previous = descendants.size;
		for (const [pid, parent] of rows) if (pid !== undefined && parent !== undefined && descendants.has(parent)) descendants.add(pid);
	}
	const groups = new Set<number>();
	for (const [pid, , group] of rows) {
		if (pid !== undefined && group !== undefined && group > 1 && group !== root && descendants.has(pid) && descendants.has(group)) groups.add(group);
	}
	return [...groups];
}

/** Capture ownership before signalling a wrapper that may immediately exit and reparent workers. */
export function snapshotDescendantGroups(root: number): number[] {
	const table = execFileSync("ps", ["-axo", "pid=,ppid=,pgid="], {
		encoding: "utf8", timeout: 1000, maxBuffer: 4 * 1024 ** 2, stdio: ["ignore", "pipe", "ignore"],
	});
	return descendantGroupsFromTable(table, root);
}
