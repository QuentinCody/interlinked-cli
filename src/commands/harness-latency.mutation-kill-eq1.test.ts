// ===========================================
// harness-latency.ts — equivalence-falsification pass 1 (eq1)
// ===========================================
// Targeted against a batch of mutants an earlier pass flagged
// "suspected equivalent". Most really are equivalent (dead fields never
// read past parseLatencyRecord, branch-symmetric null ternaries, a
// masked-by-`?? null` length check, an unreachable Math.min cap on an
// unexported helper only ever called with q < 1) — those verdicts are
// recorded structurally in the receipts log, not re-derived here.
//
// e448d822ba1600dc is the one mutant this pass falsifies: replacing
// `line.trim()` with the raw `line` before `JSON.parse` looks redundant
// (JSON.parse tolerates ASCII whitespace padding) but JS's `String.trim()`
// strips a wider Unicode whitespace set — including U+00A0 (NBSP) — that
// JSON.parse does NOT accept as JSON whitespace. A line padded with NBSP
// therefore parses under the real `.trim()` call and throws (silently
// skipped) once the trim is removed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CWD = "/eq1-latency";
const LOG = `${CWD}/.interlinked/logs/latency.jsonl`;
let files = new Map<string, string>();

vi.mock("node:fs", () => ({
	existsSync: (path: string) => files.has(path),
	readFileSync: (path: string) => {
		const content = files.get(path);
		if (content === undefined) {
			const err: Error & { code?: string } = new Error("ENOENT");
			err.code = "ENOENT";
			throw err;
		}
		return content;
	},
}));

import { computeLatencyReport } from "./harness-latency.js";

beforeEach(() => {
	files = new Map();
	vi.spyOn(process, "cwd").mockReturnValue(CWD);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("harness-latency eq1 falsification", () => {
	// test-contract: boundary — mutantId e448d822ba1600dc: `line.trim()` -> `line`
	// drops JS trim()'s Unicode-whitespace handling. A line padded with U+00A0
	// (NBSP) parses under the real .trim() call (NBSP is stripped, valid JSON
	// remains) but JSON.parse rejects raw NBSP as an unexpected token, so the
	// mutant silently drops the record — total_events differs (1 vs 0).
	it("counts a JSON line padded with NBSP only when the padding is actually trimmed", () => {
		const nbsp = " ";
		const record = { hook_event: "PostToolUse", session_id: "s1", checks_timing_ms: 5 };
		files.set(LOG, `${nbsp}${JSON.stringify(record)}${nbsp}\n`);

		const report = computeLatencyReport(CWD);

		expect(report.total_events).toBe(1);
		expect(report.by_hook_event).toEqual({ PostToolUse: 1 });
	});
});
