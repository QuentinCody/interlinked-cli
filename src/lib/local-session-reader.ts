import { existsSync, opendirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readFileRange } from "./bounded-file-io.js";
import { isJsonObject } from "./json-types.js";
import type { SessionState } from "./local-activity-types.js";

const MAX_LOCAL_SESSION_FILES = 10_000;
export const MAX_LOCAL_SESSION_FILE_BYTES = 1024 * 1024;
const MAX_LOCAL_SESSION_TOTAL_BYTES = 32 * 1024 * 1024;

interface LocalSessionScanLimits {
	maxFiles: number;
	maxFileBytes: number;
	maxTotalBytes: number;
}

const DEFAULT_LOCAL_SESSION_SCAN_LIMITS: LocalSessionScanLimits = Object.freeze({
	maxFiles: MAX_LOCAL_SESSION_FILES,
	maxFileBytes: MAX_LOCAL_SESSION_FILE_BYTES,
	maxTotalBytes: MAX_LOCAL_SESSION_TOTAL_BYTES,
});

export class LocalSessionScanLimitError extends Error {
	constructor(detail: string) {
		super(`local session scan refused: ${detail}`);
		this.name = "LocalSessionScanLimitError";
	}
}

interface SessionScanBudget {
	dir: string;
	files: number;
	bytes: number;
	limits: LocalSessionScanLimits;
}

function accountSessionFile(name: string, budget: SessionScanBudget): number {
	budget.files++;
	if (budget.files > budget.limits.maxFiles) {
		throw new LocalSessionScanLimitError(
			`more than ${budget.limits.maxFiles} JSON files in ${budget.dir}`,
		);
	}
	const bytes = statSync(join(budget.dir, name)).size;
	if (bytes > budget.limits.maxFileBytes) {
		throw new LocalSessionScanLimitError(
			`${name} is ${bytes} bytes (per-file limit ${budget.limits.maxFileBytes})`,
		);
	}
	budget.bytes += bytes;
	if (budget.bytes > budget.limits.maxTotalBytes) {
		throw new LocalSessionScanLimitError(
			`JSON files exceed ${budget.limits.maxTotalBytes} total bytes in ${budget.dir}`,
		);
	}
	return bytes;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNumberRecord(value: unknown): value is Record<string, number> {
	if (!isJsonObject(value)) return false;
	return Object.values(value).every(
		(entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0,
	);
}

function isSessionState(value: unknown): value is SessionState {
	if (!isJsonObject(value)) return false;
	const session = value;
	return (
		typeof session.session_id === "string" &&
		typeof session.agent === "string" &&
		(session.phase === "ACTIVE" || session.phase === "ENDED") &&
		typeof session.started_at === "string" &&
		typeof session.last_event_at === "string" &&
		typeof session.tool_count === "number" &&
		Number.isSafeInteger(session.tool_count) &&
		session.tool_count >= 0 &&
		typeof session.error_count === "number" &&
		Number.isSafeInteger(session.error_count) &&
		session.error_count >= 0 &&
		isStringArray(session.files_touched) &&
		isNumberRecord(session.tools_used)
	);
}

function readSessionFile(
	name: string,
	budget: SessionScanBudget,
): SessionState | null {
	try {
		const path = join(budget.dir, name);
		const bytes = accountSessionFile(name, budget);
		const parsed: unknown = JSON.parse(
			readFileRange(path, 0, bytes, budget.limits.maxFileBytes).toString("utf8"),
		);
		return isSessionState(parsed) ? parsed : null;
	} catch (error) {
		if (error instanceof LocalSessionScanLimitError) throw error;
		return null;
	}
}

function scanSessionDirectory(
	dir: string,
	limits: LocalSessionScanLimits,
): SessionState[] {
	const sessions: SessionState[] = [];
	const budget: SessionScanBudget = { dir, files: 0, bytes: 0, limits };
	const directory = opendirSync(dir);
	try {
		for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const session = readSessionFile(entry.name, budget);
			if (session) sessions.push(session);
		}
	} finally {
		try {
			directory.closeSync();
		} catch {
			/* intentional: iteration closes the directory automatically at EOF */
		}
	}
	return sessions;
}

/** Stream a bounded session directory. Limit breaches throw rather than
 * returning an incomplete list that status or checkpoint could call exact. */
export function readBoundedLocalSessions(
	dir: string,
	limits: LocalSessionScanLimits = DEFAULT_LOCAL_SESSION_SCAN_LIMITS,
): SessionState[] {
	if (!existsSync(dir)) return [];
	try {
		return scanSessionDirectory(dir, limits);
	} catch (error) {
		if (error instanceof LocalSessionScanLimitError) throw error;
		/* intentional: an unreadable directory behaves like the legacy reader */
		return [];
	}
}
