// ===========================================
// Statusline status-file writers
// ===========================================
// Extracted from server.ts. The daemon drops a handful of one-line marker
// files under `.interlinked/` that the bash statusline polls:
//   - `classifier.status`        — policy-classifier readiness
//   - `content-scanner.status`   — ML content-scanner lifecycle
//   - `scanner/review-pending`   — count of unresolved scanner reviews
//
// Each write is best-effort: a failure only loses the indicator until the
// next call, so the helpers swallow errors rather than disturb the daemon.
// `createStatusWriters(interlinkedDir)` binds the paths once at startup and
// returns the writer functions, keeping server.ts free of the path wiring.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Best-effort single-line file write. Swallows any I/O error — these markers
 *  are cosmetic statusline inputs, never load-bearing for the daemon. */
export function writeStatusFile(path: string, content: string): void {
	try {
		writeFileSync(path, content);
	} catch (e) {
		void e;
	}
}

/** The three statusline writers plus the resolved marker paths (exposed for
 *  tests / diagnostics). */
interface StatusWriters {
	readonly classifierStatusPath: string;
	readonly scannerStatusPath: string;
	readonly scannerReviewPendingPath: string;
	/** Persist the one-line classifier status. */
	writeClassifierStatus(status: string): void;
	/** Persist the one-line content-scanner status. */
	writeScannerStatus(status: string): void;
	/** Persist the pending-review count as a single line. */
	writeReviewPendingMarker(count: number): void;
}

/** Build the statusline writers, binding every marker path under
 *  `<interlinkedDir>`. */
export function createStatusWriters(interlinkedDir: string): StatusWriters {
	const classifierStatusPath = join(interlinkedDir, "classifier.status");
	const scannerStatusPath = join(interlinkedDir, "content-scanner.status");
	const scannerReviewPendingPath = join(interlinkedDir, "scanner", "review-pending");
	return {
		classifierStatusPath,
		scannerStatusPath,
		scannerReviewPendingPath,
		writeClassifierStatus(status: string): void {
			writeStatusFile(classifierStatusPath, status);
		},
		writeScannerStatus(status: string): void {
			writeStatusFile(scannerStatusPath, status);
		},
		writeReviewPendingMarker(count: number): void {
			writeStatusFile(scannerReviewPendingPath, `${count}\n`);
		},
	};
}
