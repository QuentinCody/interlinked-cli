// ===========================================
// Viz Status File — "is a dashboard up, and where?"
// ===========================================
// `viz serve` writes a tiny kv file while it is listening; the statusline reads
// it to render a clickable link. The file records the owning PID so a reader can
// tell a LIVE server from a stale file left by a killed process — the statusline
// must never offer a link that goes nowhere.
//
// Same kv shape as `sponsor.status` (`key=value` per line) so the statusline's
// existing grep/cut idiom reads it unchanged.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface VizStatus {
	url: string;
	pid: number;
	root: string;
}

/** Status-file location under a project root. */
export function vizStatusPath(root: string): string {
	return join(root, ".interlinked", "viz.status");
}

/** Serialize a status as the statusline's `key=value` kv format. */
export function formatVizStatus(status: VizStatus): string {
	return `url=${status.url}\npid=${status.pid}\nroot=${status.root}\n`;
}

/** Parse the kv file back into a status, or null if a required field is absent. */
export function parseVizStatus(text: string): VizStatus | null {
	const kv = new Map<string, string>();
	for (const line of text.split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) kv.set(line.slice(0, eq), line.slice(eq + 1).trim());
	}
	const url = kv.get("url");
	const pid = Number(kv.get("pid"));
	// interlinked-ignore: nan_coercion_guard — Number.isInteger already excludes
	// NaN and short-circuits before the relational compare, so it cannot fail open.
	if (!url || !Number.isInteger(pid) || pid <= 0) return null;
	return { url, pid, root: kv.get("root") ?? "" };
}

/** Write the status file. Best-effort: a failure must not stop the server. */
export function writeVizStatus(root: string, status: VizStatus): boolean {
	try {
		const path = vizStatusPath(root);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, formatVizStatus(status));
		return true;
	} catch (err) {
		void err; /* the link is a convenience — never fail the server over it */
		return false;
	}
}

/** Remove the status file on shutdown so no stale link survives the process. */
export function clearVizStatus(root: string): void {
	try {
		rmSync(vizStatusPath(root), { force: true });
	} catch (err) {
		void err; /* already gone, or unwritable — nothing to do either way */
	}
}

/** True when a process with this pid exists (signal 0 probes without signaling). */
export function isPidAlive(pid: number, kill: (p: number, sig: number) => void = process.kill): boolean {
	try {
		kill(pid, 0);
		return true;
	} catch (err) {
		void err; /* ESRCH (gone) and EPERM (not ours) both mean "not our live server" */
		return false;
	}
}

/**
 * Read the status of a LIVE dashboard for this root, or null when none is
 * running. A file whose owning process has exited is treated as absent.
 */
export function readLiveVizStatus(root: string): VizStatus | null {
	const path = vizStatusPath(root);
	if (!existsSync(path)) return null;
	let status: VizStatus | null = null;
	try {
		status = parseVizStatus(readFileSync(path, "utf-8"));
	} catch (err) {
		void err; /* unreadable status file reads as "no dashboard" */
		return null;
	}
	return status && isPidAlive(status.pid) ? status : null;
}
