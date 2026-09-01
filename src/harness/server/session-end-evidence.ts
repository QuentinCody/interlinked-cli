// ===========================================
// SessionEnd evidence bundle (DW P4 §4 job 5 — proof-of-enforcement seed)
// ===========================================
// Writes the session's honest closeout at SessionEnd: what the agent actually
// did (files edited, tests run + pass/fail, warnings surfaced) and whether it
// verified its work (typecheck / test / lint / build observed). Strictly a
// record of OBSERVED signals — never a fabricated certification. The `result`
// is derived only from whether any verification ran, so an unverified session
// reads as `unverified`, not a false pass.
//
// Best-effort + never-throw (SessionEnd cleanup must complete regardless).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionTrajectory } from "../types.js";

interface SessionEvidence {
	session_id: string;
	started_at: string;
	tool_calls: number;
	files_edited: number;
	tests: { run: number; passed: number; failed: number };
	warnings_surfaced: number;
	/** Verification-signal kinds observed this session (typecheck/test/lint/build/…). */
	verification: string[];
	/** Derived: `verified` iff at least one verification signal was observed. */
	result: "verified" | "unverified";
}

/** Pure: fold the session's observed signals into the evidence shape. */
export function buildSessionEvidence(session: SessionTrajectory): SessionEvidence {
	let passed = 0;
	let failed = 0;
	for (const run of session.test_runs.values()) {
		if (run.status === "pass") passed++;
		else failed++;
	}
	const verification = [...(session.verification_observed ?? [])].sort();
	return {
		session_id: session.session_id,
		started_at: session.started_at,
		tool_calls: session.tool_call_count,
		files_edited: session.files_written.size,
		tests: { run: passed + failed, passed, failed },
		warnings_surfaced: session.warnings_issued.size,
		verification,
		result: verification.length > 0 ? "verified" : "unverified",
	};
}

/** Write the evidence bundle to `.interlinked/evidence/<session_id>.json`.
 *  Best-effort; never throws. */
export function writeSessionEndEvidence(cwd: string, session: SessionTrajectory): void {
	try {
		const safe = session.session_id.replace(/[^\w.-]/g, "_") || "unknown";
		const dir = join(cwd, ".interlinked", "evidence");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${safe}.json`), JSON.stringify(buildSessionEvidence(session), null, 2));
	} catch (err) {
		void err; // evidence is a bonus artifact — never break SessionEnd on it
	}
}
