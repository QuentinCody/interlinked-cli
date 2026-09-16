// Unit tests for the pure gate-reach aggregation layer (plan 16 §4).
//
// Everything under test here is a pure function over plain records: no fs, no
// clock, no daemon. The fs/collection half lives in `gate-reach-collect.ts`.

import { describe, expect, it } from "vitest";

import {
	buildGateReachSnapshot,
	compareGateReach,
	computeGateReach,
	formatGateReachLine,
	formatGateReachLines,
	formatGateReachRegression,
	formatGateReachReport,
	REACH_REGRESSION_TOLERANCE,
} from "./gate-reach.js";

describe("computeGateReach", () => {
	it("derives unmeasured from eligible minus measured minus skipped", () => {
		const r = computeGateReach({
			gate: "mutation",
			eligible: 1013,
			measured: 679,
			skipped: { no_tests: 290 },
		});
		expect(r.status).toBe("measured");
		expect(r.unit).toBe("files");
		expect(r.eligible).toBe(1013);
		expect(r.measured).toBe(679);
		expect(r.skipped).toEqual({ no_tests: 290 });
		expect(r.unmeasured).toBe(44);
		expect(r.reach).toBeCloseTo(679 / 1013, 6);
	});

	it("honours a non-default unit", () => {
		const r = computeGateReach({ gate: "cyclomatic", unit: "fns", eligible: 10, measured: 10 });
		expect(r.unit).toBe("fns");
	});

	it("forces measured to zero and status disabled when the gate is off", () => {
		// A disabled gate cannot have measured anything, whatever the caller
		// passed — this is the "silent zero" the meta-metric exists to prevent.
		const r = computeGateReach({
			gate: "per_edit_coverage",
			eligible: 800,
			measured: 42,
			disabled: true,
			reason: "config per_edit_coverage.enabled=false",
		});
		expect(r.status).toBe("disabled");
		expect(r.measured).toBe(0);
		expect(r.reach).toBe(0);
		expect(r.unmeasured).toBe(800);
		expect(r.reason).toBe("config_per_edit_coverage.enabled=false");
	});

	it("forces measured to zero when the measurement source is unavailable", () => {
		const r = computeGateReach({
			gate: "mutation",
			eligible: 800,
			measured: 99,
			sourceUnavailable: true,
			reason: "manifest absent",
		});
		expect(r.status).toBe("source_unavailable");
		expect(r.measured).toBe(0);
		expect(r.unmeasured).toBe(800);
		expect(r.reason).toBe("manifest_absent");
	});

	it("prefers disabled over source_unavailable when both are set", () => {
		const r = computeGateReach({
			gate: "g",
			eligible: 1,
			measured: 0,
			disabled: true,
			sourceUnavailable: true,
		});
		expect(r.status).toBe("disabled");
	});

	it("reports reach 0 (never 1) for an empty eligible domain", () => {
		// A walk that found nothing must NOT read as perfect coverage — that
		// would turn a broken enumerator into a green meta-metric.
		const r = computeGateReach({ gate: "coverage", eligible: 0, measured: 0 });
		expect(r.reach).toBe(0);
		expect(r.unmeasured).toBe(0);
	});

	it("clamps measured to eligible", () => {
		const r = computeGateReach({ gate: "coverage", eligible: 10, measured: 99 });
		expect(r.measured).toBe(10);
		expect(r.reach).toBe(1);
		expect(r.unmeasured).toBe(0);
	});

	it("floors negative and non-finite counts at zero", () => {
		const r = computeGateReach({
			gate: "coverage",
			eligible: Number.NaN,
			measured: -5,
			skipped: { bad: -3, worse: Number.POSITIVE_INFINITY },
		});
		expect(r.eligible).toBe(0);
		expect(r.measured).toBe(0);
		expect(r.skipped).toEqual({});
	});

	it("drops zero-valued skip buckets and clamps an over-reported skip total", () => {
		const r = computeGateReach({
			gate: "coverage",
			eligible: 10,
			measured: 2,
			skipped: { none: 0, huge: 500 },
		});
		expect(r.skipped).toEqual({ huge: 500 });
		expect(r.unmeasured).toBe(0);
	});
});

describe("formatGateReachLine", () => {
	it("renders a measured gate as the documented one-line figure", () => {
		const line = formatGateReachLine(
			computeGateReach({
				gate: "mutation",
				eligible: 1013,
				measured: 679,
				skipped: { no_tests: 290 },
			}),
		);
		expect(line).toBe(
			"gate=mutation eligible_files=1013 measured=679 skipped_no_tests=290 unmeasured=44 reach=67.0%",
		);
	});

	it("renders a disabled gate loudly, with its reason", () => {
		const line = formatGateReachLine(
			computeGateReach({
				gate: "per_edit_coverage",
				eligible: 1013,
				measured: 0,
				disabled: true,
				reason: "per_edit_coverage.enabled=false",
			}),
		);
		expect(line).toBe(
			"gate=per_edit_coverage eligible_files=1013 measured=0 unmeasured=1013 disabled=true reason=per_edit_coverage.enabled=false",
		);
	});

	it("marks an unavailable measurement source rather than claiming zero reach", () => {
		const line = formatGateReachLine(
			computeGateReach({ gate: "mutation", eligible: 5, measured: 0, sourceUnavailable: true }),
		);
		expect(line).toContain("measurement_source=unavailable");
		expect(line).not.toContain("reach=");
	});

	it("sorts skip buckets so the line is stable across runs", () => {
		const line = formatGateReachLine(
			computeGateReach({ gate: "g", eligible: 9, measured: 1, skipped: { zeta: 1, alpha: 2 } }),
		);
		expect(line.indexOf("skipped_alpha")).toBeLessThan(line.indexOf("skipped_zeta"));
	});
});

describe("buildGateReachSnapshot / formatGateReachLines", () => {
	it("stamps session and time and computes every gate", () => {
		const snapshot = buildGateReachSnapshot({
			sessionId: "s1",
			at: 1_700_000_000_000,
			inputs: [
				{ gate: "a", eligible: 4, measured: 2 },
				{ gate: "b", eligible: 4, measured: 0, disabled: true },
			],
		});
		expect(snapshot.version).toBe(1);
		expect(snapshot.session_id).toBe("s1");
		expect(snapshot.at).toBe(new Date(1_700_000_000_000).toISOString());
		expect(snapshot.gates.map((g) => g.gate)).toEqual(["a", "b"]);
		expect(formatGateReachLines(snapshot)).toHaveLength(2);
	});
});

describe("compareGateReach", () => {
	const measured = (gate: string, eligible: number, m: number) =>
		computeGateReach({ gate, eligible, measured: m });

	it("flags a reach drop larger than the tolerance", () => {
		const prev = [measured("coverage", 100, 90)];
		const next = [measured("coverage", 100, 80)];
		const regressions = compareGateReach(prev, next);
		expect(regressions).toHaveLength(1);
		expect(regressions[0]?.kind).toBe("reach_dropped");
		expect(regressions[0]?.previous).toBeCloseTo(0.9, 6);
		expect(regressions[0]?.current).toBeCloseTo(0.8, 6);
	});

	it("stays quiet for a drop inside the tolerance band", () => {
		// One newly-added source file that the last full coverage run never saw
		// must not nag every session; only a real loss of reach speaks.
		const prev = [measured("coverage", 1000, 900)];
		const next = [measured("coverage", 1001, 900)];
		expect(REACH_REGRESSION_TOLERANCE).toBeGreaterThan(0);
		expect(compareGateReach(prev, next)).toEqual([]);
	});

	it("flags a gate that stopped measuring even when reach was already low", () => {
		const prev = [measured("per_edit_coverage", 100, 5)];
		const next = [
			computeGateReach({ gate: "per_edit_coverage", eligible: 100, measured: 0, disabled: true }),
		];
		const regressions = compareGateReach(prev, next);
		expect(regressions).toHaveLength(1);
		expect(regressions[0]?.kind).toBe("stopped_measuring");
		expect(regressions[0]?.currentStatus).toBe("disabled");
	});

	it("does not flag a gate that was already not measuring", () => {
		const off = computeGateReach({ gate: "g", eligible: 10, measured: 0, disabled: true });
		expect(compareGateReach([off], [off])).toEqual([]);
	});

	it("ignores gates absent from the previous snapshot", () => {
		expect(compareGateReach([], [measured("brand_new", 10, 1)])).toEqual([]);
	});

	it("ignores gates absent from the current snapshot", () => {
		expect(compareGateReach([measured("gone", 10, 10)], [])).toEqual([]);
	});

	it("reports a reach rise as no regression", () => {
		expect(compareGateReach([measured("g", 100, 10)], [measured("g", 100, 90)])).toEqual([]);
	});
});

describe("formatGateReachRegression", () => {
	it("names the percentage-point drop", () => {
		const [reg] = compareGateReach(
			[computeGateReach({ gate: "coverage", eligible: 100, measured: 90 })],
			[computeGateReach({ gate: "coverage", eligible: 100, measured: 70 })],
		);
		expect(reg).toBeDefined();
		expect(formatGateReachRegression(reg!)).toBe(
			"gate=coverage reach fell 90.0% -> 70.0% (-20.0pp)",
		);
	});

	it("names a stop-measuring transition", () => {
		const [reg] = compareGateReach(
			[computeGateReach({ gate: "coverage", eligible: 100, measured: 90 })],
			[computeGateReach({ gate: "coverage", eligible: 100, measured: 0, disabled: true })],
		);
		expect(reg).toBeDefined();
		expect(formatGateReachRegression(reg!)).toBe(
			"gate=coverage STOPPED MEASURING (measured -> disabled)",
		);
	});
});

describe("formatGateReachReport", () => {
	const snapshotOf = (inputs: Parameters<typeof buildGateReachSnapshot>[0]["inputs"]) =>
		buildGateReachSnapshot({ sessionId: "s", at: 0, inputs });

	it("returns null when every gate measured and nothing regressed", () => {
		const snapshot = snapshotOf([{ gate: "coverage", eligible: 10, measured: 10 }]);
		expect(formatGateReachReport({ snapshot, regressions: [] })).toBeNull();
	});

	it("is loud about a disabled gate", () => {
		const snapshot = snapshotOf([
			{ gate: "coverage_ratchet", eligible: 10, measured: 7 },
			{
				gate: "per_edit_coverage",
				eligible: 10,
				measured: 0,
				disabled: true,
				reason: "per_edit_coverage.enabled=false",
			},
		]);
		const report = formatGateReachReport({ snapshot, regressions: [] });
		expect(report).not.toBeNull();
		expect(report).toContain("[interlinked:gate-reach]");
		expect(report).toContain("1 quality gate measured NOTHING");
		expect(report).toContain("gate=per_edit_coverage");
		// Every gate is listed, not just the failing one — the reach of the
		// gates that DID run is the context that makes the zero meaningful.
		expect(report).toContain("gate=coverage_ratchet");
		expect(report).toContain("reason=per_edit_coverage.enabled=false");
	});

	it("pluralises the disabled-gate headline", () => {
		const snapshot = snapshotOf([
			{ gate: "a", eligible: 1, measured: 0, disabled: true },
			{ gate: "b", eligible: 1, measured: 0, disabled: true },
		]);
		expect(formatGateReachReport({ snapshot, regressions: [] })).toContain(
			"2 quality gates measured NOTHING",
		);
	});

	describe("recorded disable reason — positive (must change the report)", () => {
		const recorded = {
			gate: "per_edit_coverage",
			eligible: 10,
			measured: 0,
			disabled: true,
			reason: "per_edit_coverage.enabled=false",
			recordedReason: "OFF locally: full-suite wall ~250s makes per-edit overlay runs unaffordable.",
		};

		it("stays loud but names the recorded decision instead of NOTHING", () => {
			const report = formatGateReachReport({ snapshot: snapshotOf([recorded]), regressions: [] });
			expect(report).not.toBeNull();
			expect(report).toContain("1 quality gate is OFF by recorded decision");
			expect(report).not.toContain("measured NOTHING");
			expect(report).toContain('recorded_reason="OFF locally: full-suite wall ~250s');
			expect(report).toContain("disabled=true");
		});

		it("drops the 'record why it is off' ask from the footer once it is recorded", () => {
			const report = formatGateReachReport({ snapshot: snapshotOf([recorded]), regressions: [] });
			expect(report).not.toContain("record why it is off");
			expect(report).toContain("Re-enable the gate when its recorded condition is met");
		});

		it("pluralises the recorded headline", () => {
			const report = formatGateReachReport({
				snapshot: snapshotOf([recorded, { ...recorded, gate: "mutation" }]),
				regressions: [],
			});
			expect(report).toContain("2 quality gates are OFF by recorded decision");
		});

		it("collapses whitespace and bounds a paragraph-length note", () => {
			const r = computeGateReach({ ...recorded, recordedReason: `a\n\n  b ${"x".repeat(400)}` });
			expect(r.recorded_reason?.startsWith("a b x")).toBe(true);
			expect(r.recorded_reason?.length).toBeLessThanOrEqual(160);
			expect(r.recorded_reason?.endsWith("…")).toBe(true);
		});
	});

	describe("recorded disable reason — negative (must not change the report)", () => {
		it("keeps the NOTHING headline and the full footer while any disabled gate is unexplained", () => {
			const snapshot = snapshotOf([
				{ gate: "a", eligible: 1, measured: 0, disabled: true, recordedReason: "documented" },
				{ gate: "b", eligible: 1, measured: 0, disabled: true },
			]);
			const report = formatGateReachReport({ snapshot, regressions: [] });
			expect(report).toContain("1 quality gate measured NOTHING");
			expect(report).toContain("record why it is off");
		});

		it("ignores a blank note — a blank note is not a recorded decision", () => {
			const r = computeGateReach({ gate: "a", eligible: 1, measured: 0, disabled: true, recordedReason: "  \n " });
			expect(r.recorded_reason).toBeUndefined();
		});

		it("never carries a recorded reason on a gate that is not disabled", () => {
			const r = computeGateReach({ gate: "a", eligible: 4, measured: 4, recordedReason: "stale note" });
			expect(r.status).toBe("measured");
			expect(r.recorded_reason).toBeUndefined();
			expect(formatGateReachLine(r)).not.toContain("recorded_reason");
		});
	});

	it("reports an unavailable measurement source without calling it disabled", () => {
		const snapshot = snapshotOf([
			{ gate: "mutation", eligible: 10, measured: 0, sourceUnavailable: true, reason: "no manifest" },
		]);
		const report = formatGateReachReport({ snapshot, regressions: [] });
		expect(report).toContain("could not be measured");
		expect(report).not.toContain("measured NOTHING");
	});

	it("reports a reach regression even when no gate is disabled", () => {
		const snapshot = snapshotOf([{ gate: "coverage", eligible: 100, measured: 70 }]);
		const regressions = compareGateReach(
			[computeGateReach({ gate: "coverage", eligible: 100, measured: 90 })],
			snapshot.gates,
		);
		const report = formatGateReachReport({ snapshot, regressions });
		expect(report).toContain("shrank");
		expect(report).toContain("reach fell 90.0% -> 70.0%");
	});
});
