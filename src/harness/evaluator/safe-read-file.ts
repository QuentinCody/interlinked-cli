// One `readFileSync` wrapper for every per-function metric gate that needs a
// file's before-content without throwing on a missing/unreadable path.
// Extracted 2026-09-03: `apply-patch-section-metric.ts`,
// `characterize-campaign-target.ts`, and `per-function-metric-gate.ts` each
// carried an identical private copy.

import { readFileSync } from "node:fs";

/** Read `abs` as utf-8; null on any error (missing file, EISDIR, etc.) rather
 *  than throwing — callers treat "unreadable" the same as "absent". */
export function safeReadFile(abs: string): string | null {
	try {
		return readFileSync(abs, "utf-8");
	} catch {
		return null;
	}
}
