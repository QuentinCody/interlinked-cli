// Check-health governance loop (Tricorder-style demotion signal) — pure
// aggregation tests over synthetic recurrence rows. The probation heuristic is
// a detector in spirit: positive cases (must flag) and negative cases
// (legitimate patterns that must NOT flag) are both pinned below.

import { describe, expect, it } from "vitest";
import {
	type CheckDeterminismTag,
	classifyCheckHealth,
	createCheckHealthAccumulator,
	describeCheckHealth,
	finalizeCheckHealth,
	foldCheckHealthEvent,
	foldRecurrenceLine,
	LOW_DATA_EVENT_FLOOR,
	PROBATION_REPEAT_RATE_THRESHOLD,
	PROBATION_UNIQUE_FINDINGS_FLOOR,
} from "./check-health.js";
import type { RecurrenceEvent } from "./recurrence.js";

// ===========================================
// Fixture builders
// ===========================================

it.each(["file", "message", "session_id"])("rejects non-string %s in raw recurrence rows", (field) => {
	const acc = createCheckHealthAccumulator();
	expect(foldRecurrenceLine(acc, JSON.stringify({ ...caught(), [field]: { invalid: true } }))).toBe(false);
	expect(foldRecurrenceLine(acc, JSON.stringify(caught()))).toBe(true);
	expect(finalizeCheckHealth(acc, () => "heuristic")).toMatchObject([
		{ events: 1, unique_findings: 1, sessions: 1 },
	]);
});

function caught(overrides: Partial<RecurrenceEvent> = {}): RecurrenceEvent {
	return {
		ts: "2026-06-01T00:00:00.000Z",
		kind: "harness_caught",
		check_id: "ubs_example_check",
		agent_source: "claude",
		session_id: "s-1",
		file: "src/a.ts",
		message: "1 example issue(s) in src/a.ts",
		...overrides,
	};
}

/** N re-fires of the SAME finding + M distinct findings, spread over sessions. */
function synthRows(opts: {
	checkId: string;
	uniqueFindings: number;
	repeatsPerFinding: number;
	sessions?: number;
}): RecurrenceEvent[] {
	const rows: RecurrenceEvent[] = [];
	const sessions = opts.sessions ?? 3;
	for (let f = 0; f < opts.uniqueFindings; f++) {
		for (let r = 0; r < opts.repeatsPerFinding; r++) {
			rows.push(
				caught({
					check_id: opts.checkId,
					file: `src/file-${f}.ts`,
					message: `finding ${f}`,
					session_id: `s-${(f + r) % sessions}`,
					ts: `2026-06-0${1 + (r % 5)}T00:00:00.000Z`,
				}),
			);
		}
	}
	return rows;
}

function healthOf(
	rows: RecurrenceEvent[],
	classify: (id: string) => CheckDeterminismTag = () => "heuristic",
) {
	const acc = createCheckHealthAccumulator();
	for (const row of rows) foldCheckHealthEvent(acc, row);
	return finalizeCheckHealth(acc, classify);
}

// ===========================================
// Probation heuristic — positive cases (must flag)
// ===========================================

describe("probation heuristic — positive cases", () => {
	it("flags a heuristic check with high repeat-rate across many findings", () => {
		const rows = synthRows({ checkId: "noisy_check", uniqueFindings: 10, repeatsPerFinding: 10 });
		const [row] = healthOf(rows);
		expect(row?.status).toBe("probation-candidate");
		expect(row?.repeat_rate).toBeCloseTo(10);
	});

	it("flags exactly at the thresholds (>= semantics on rate and floor)", () => {
		const rows = synthRows({
			checkId: "edge_check",
			uniqueFindings: PROBATION_UNIQUE_FINDINGS_FLOOR,
			repeatsPerFinding: PROBATION_REPEAT_RATE_THRESHOLD,
		});
		const [row] = healthOf(rows);
		expect(row?.events).toBeGreaterThanOrEqual(LOW_DATA_EVENT_FLOOR);
		expect(row?.status).toBe("probation-candidate");
	});

	it("flags an ignored advisory re-firing across many sessions, with an actionable why", () => {
		const rows = synthRows({
			checkId: "ignored_advisory",
			uniqueFindings: 8,
			repeatsPerFinding: 12,
			sessions: 6,
		});
		const [row] = healthOf(rows);
		expect(row?.status).toBe("probation-candidate");
		expect(row?.sessions).toBe(6);
		// The WHY line is the actionable core: events / unique / sessions.
		expect(row?.why).toContain("96 events / 8 unique / 6 sessions");
		expect(row?.why).toContain("repeat-rate 12.0");
	});
});

// ===========================================
// Probation heuristic — negative cases (must NOT flag)
// ===========================================

describe("probation heuristic — negative cases", () => {
	it("never flags a PROVEN check, even with identical noisy stats", () => {
		// tsc re-firing means the agent ignored a real error — evidence about
		// the agent, not the check. Demotion is heuristic-only.
		const rows = synthRows({ checkId: "typescript", uniqueFindings: 10, repeatsPerFinding: 10 });
		const [row] = healthOf(rows, () => "proven");
		expect(row?.status).toBe("healthy");
	});

	it("does not flag one stuck finding re-firing forever (unique below floor)", () => {
		const rows = synthRows({
			checkId: "stuck_file",
			uniqueFindings: PROBATION_UNIQUE_FINDINGS_FLOOR - 1,
			repeatsPerFinding: 50,
		});
		const [row] = healthOf(rows);
		expect(row?.status).toBe("healthy");
	});

	it("does not flag a healthy check whose findings get fixed after one fire", () => {
		const rows = synthRows({ checkId: "healthy_check", uniqueFindings: 30, repeatsPerFinding: 1 });
		const [row] = healthOf(rows);
		expect(row?.repeat_rate).toBeCloseTo(1);
		expect(row?.status).toBe("healthy");
	});

	it("reports low-data (not probation) below the event floor", () => {
		const rows = synthRows({
			checkId: "new_check",
			uniqueFindings: 1,
			repeatsPerFinding: LOW_DATA_EVENT_FLOOR - 1,
		});
		const [row] = healthOf(rows);
		expect(row?.status).toBe("low-data");
	});

	it("never flags unknown-determinism ids on log evidence alone", () => {
		const rows = synthRows({ checkId: "retired_check", uniqueFindings: 10, repeatsPerFinding: 10 });
		const [row] = healthOf(rows, () => null);
		expect(row?.status).toBe("healthy");
	});
});

// ===========================================
// Fold mechanics
// ===========================================

describe("fold mechanics", () => {
	it("ignores non-harness_caught kinds and rows without a check_id", () => {
		const acc = createCheckHealthAccumulator();
		foldCheckHealthEvent(acc, caught({ kind: "harness_missed" }));
		foldCheckHealthEvent(acc, caught({ kind: "tool_failure" }));
		foldCheckHealthEvent(acc, caught({ kind: "outcome_marker" }));
		foldCheckHealthEvent(acc, caught({ check_id: undefined }));
		expect(finalizeCheckHealth(acc, () => "heuristic")).toEqual([]);
	});

	it("keys unique findings on (file, message) — same file, different message counts twice", () => {
		const rows = [
			caught({ message: "issue A" }),
			caught({ message: "issue B" }),
			caught({ message: "issue A", file: "src/b.ts" }),
			caught({ message: "issue A" }), // exact repeat — no new finding
		];
		const [row] = healthOf(rows);
		expect(row?.events).toBe(4);
		expect(row?.unique_findings).toBe(3);
	});

	it("takes first/last seen from row timestamps regardless of fold order", () => {
		const rows = [
			caught({ ts: "2026-06-15T00:00:00.000Z" }),
			caught({ ts: "2026-06-01T00:00:00.000Z" }),
			caught({ ts: "2026-06-30T00:00:00.000Z" }),
		];
		const [row] = healthOf(rows);
		expect(row?.first_seen).toBe("2026-06-01T00:00:00.000Z");
		expect(row?.last_seen).toBe("2026-06-30T00:00:00.000Z");
	});

	it("counts sessions uniquely", () => {
		const rows = [
			caught({ session_id: "s-1" }),
			caught({ session_id: "s-1" }),
			caught({ session_id: "s-2" }),
			caught({ session_id: undefined }),
		];
		const [row] = healthOf(rows);
		expect(row?.sessions).toBe(2);
	});

	it("sorts rows by repeat-rate, worst first", () => {
		const rows = [
			...synthRows({ checkId: "worst", uniqueFindings: 5, repeatsPerFinding: 20 }),
			...synthRows({ checkId: "mid", uniqueFindings: 5, repeatsPerFinding: 4 }),
			...synthRows({ checkId: "best", uniqueFindings: 20, repeatsPerFinding: 1 }),
		];
		expect(healthOf(rows).map((r) => r.check_id)).toEqual(["worst", "mid", "best"]);
	});
});

// ===========================================
// Streaming line fold
// ===========================================

describe("foldRecurrenceLine", () => {
	it("folds a valid harness_caught JSONL line", () => {
		const acc = createCheckHealthAccumulator();
		expect(foldRecurrenceLine(acc, JSON.stringify(caught()))).toBe(true);
		expect(finalizeCheckHealth(acc, () => "heuristic")).toHaveLength(1);
	});

	it("skips blank, torn, and non-object lines without throwing", () => {
		const acc = createCheckHealthAccumulator();
		expect(foldRecurrenceLine(acc, "")).toBe(false);
		expect(foldRecurrenceLine(acc, '{"ts":"2026-06-01T00:00:00Z","kind":"harness_ca')).toBe(false);
		expect(foldRecurrenceLine(acc, '"just a string"')).toBe(false);
		expect(foldRecurrenceLine(acc, "[1,2,3]")).toBe(false);
		expect(finalizeCheckHealth(acc, () => "heuristic")).toEqual([]);
	});
});

// ===========================================
// classifyCheckHealth / describeCheckHealth directly
// ===========================================

describe("classifyCheckHealth", () => {
	it("requires all three conditions (rate AND floor AND heuristic) for probation", () => {
		const base: Parameters<typeof classifyCheckHealth>[0] = {
			events: 100,
			unique_findings: PROBATION_UNIQUE_FINDINGS_FLOOR,
			repeat_rate: PROBATION_REPEAT_RATE_THRESHOLD,
			determinism: "heuristic",
		};
		expect(classifyCheckHealth(base)).toBe("probation-candidate");
		expect(classifyCheckHealth({ ...base, repeat_rate: base.repeat_rate - 0.1 })).toBe("healthy");
		expect(
			classifyCheckHealth({ ...base, unique_findings: PROBATION_UNIQUE_FINDINGS_FLOOR - 1 }),
		).toBe("healthy");
		expect(classifyCheckHealth({ ...base, determinism: "proven" })).toBe("healthy");
	});
});

describe("describeCheckHealth", () => {
	it("spells out the demotion evidence, marking unknown determinism explicitly", () => {
		const why = describeCheckHealth({
			events: 693,
			unique_findings: 10,
			sessions: 12,
			repeat_rate: 69.3,
			determinism: null,
		});
		expect(why).toBe("693 events / 10 unique / 12 sessions — repeat-rate 69.3 (unknown-determinism)");
	});
});
