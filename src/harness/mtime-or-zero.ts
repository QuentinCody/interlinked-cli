// ===========================================
// mtimeOrZero — the shared "mtime or 0 on error" read
// ===========================================
// Both `coverage-discharge.ts` and `baseline-autofold-folds.ts` need a
// report/baseline file's mtime for freshness comparisons, and both treat a
// missing/unreadable file as "no evidence" rather than throwing — the two
// bodies were byte-for-byte identical. One definition here; every caller
// that wants "0 on error" (as opposed to `baseline-staleness.ts`'s `null`,
// which distinguishes absent from present) imports it.

import { statSync } from "node:fs";

/** A file's mtime in epoch ms, or 0 when it does not exist or is unreadable. */
export function mtimeOrZero(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}
