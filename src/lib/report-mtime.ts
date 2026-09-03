import { statSync } from "node:fs";

/**
 * A report file's mtime in milliseconds, or 0 when unreadable.
 *
 * 0 sorts oldest, so an unreadable report is the LEAST trusted candidate in any
 * "freshest report wins" ordering — the single rule every coverage / mutation
 * report resolver shares.
 */
export function reportMtimeMs(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}
