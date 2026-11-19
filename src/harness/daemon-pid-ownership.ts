// ===========================================
// Daemon PID-file ownership
// ===========================================
// Cleanup is allowed only while the pid file still names this daemon. This
// prevents a predecessor's delayed shutdown from erasing its successor's
// ownership metadata after a handover.

import { hasErrorCode } from "./check-engine/tool-errors.js";
import { readFileSync, unlinkSync } from "node:fs";

export function pidFileNames(path: string, pid: number): boolean {
	try {
		const raw = readFileSync(path, "utf8").trim();
		return /^\d+$/.test(raw) && Number.parseInt(raw, 10) === pid;
	} catch {
		return false;
	}
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return hasErrorCode(err, "EPERM");
	}
}

export function removePidFileIfOwned(path: string, pid: number): boolean {
	if (!pidFileNames(path, pid)) return false;
	try {
		unlinkSync(path);
		return true;
	} catch {
		return false;
	}
}
