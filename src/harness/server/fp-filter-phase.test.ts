import { describe, expect, it, vi } from "vitest";
import { CHECK_REGISTRY } from "../check-registry/index.js";
import type { QualityCheckResult } from "../quality-checks/result-types.js";
import type { FpFilterConfig, HarnessDecision, HarnessEvent } from "../types.js";
import { makeServerRules, makeServerRuntime } from "./__tests__/fixtures.js";
import { annotateFpFilter, isFpFilterEligible, splitFpSuppressed } from "./fp-filter-phase.js";
import { applyQualityDecision, collectQualityResultEntries } from "./post-tool-file-checks-phases-quality.js";

const CWD = "/repo";
let sessionSeq = 0;

function ev(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	sessionSeq++;
	return {
		hook_event: "PostToolUse", session_id: `fp-sess-${sessionSeq}`, agent_source: "claude",
		timestamp: "2026-10-08T00:00:00.000Z", tool_name: "Edit", tool_input: { file_path: `${CWD}/src/a.ts` },
		...partial,
	};
}

/** function_arg_count in product source: 0/30 TP in E18, p ≈ 0.013. */
function fpShaped(over: Partial<QualityCheckResult> = {}): QualityCheckResult {
	return { name: "function_arg_count", severity: "warning", message: "x".repeat(76), file: `${CWD}/src/harness/a.ts`, ...over };
}

/** magic_number in product source: p ≈ 0.63. */
function tpShaped(over: Partial<QualityCheckResult> = {}): QualityCheckResult {
	return { name: "magic_number", severity: "warning", message: "x".repeat(62), file: `${CWD}/src/lib/b.ts`, ...over };
}

const ON: FpFilterConfig = { enabled: true };

describe("isFpFilterEligible", () => {
	it("admits [heuristic] registry checks", () => {
		expect(isFpFilterEligible("function_arg_count")).toBe(true);
	});

	it("refuses [proven] tool checks, deferrals, unknown ids and pre_block checks", () => {
		expect(isFpFilterEligible("typescript")).toBe(false);
		expect(isFpFilterEligible("external_check_deferred")).toBe(false);
		expect(isFpFilterEligible("no_such_check_anywhere")).toBe(false);
		const preBlock = CHECK_REGISTRY.filter((c) => c.phase === "pre_block");
		expect(preBlock.length).toBeGreaterThan(0);
		for (const c of preBlock) expect(isFpFilterEligible(c.id)).toBe(false);
	});
});

describe("annotateFpFilter — config off is a no-op", () => {
	it.each([undefined, { enabled: false }])("leaves results untouched for %j", (config) => {
		const rows = [fpShaped(), tpShaped()];
		const before = structuredClone(rows);
		annotateFpFilter(rows, config, ev(), CWD);
		expect(rows).toEqual(before);
		expect(splitFpSuppressed(rows, config)).toEqual({ shown: rows, trailer: null });
	});
});

describe("annotateFpFilter — positive (must suppress a known-FP-shaped finding)", () => {
	it("P1: marks function_arg_count suppressed and records its p", () => {
		const rows = [fpShaped()];
		annotateFpFilter(rows, ON, ev(), CWD);
		expect(rows[0]?.fpFilter?.suppressed).toBe(true);
		expect(rows[0]?.fpFilter?.p).toBeLessThan(0.0235);
	});

	it("P2: min_p raises the cut so a TP-shaped finding is suppressed too", () => {
		const rows = [tpShaped()];
		annotateFpFilter(rows, { enabled: true, min_p: 0.99 }, ev(), CWD);
		expect(rows[0]?.fpFilter?.suppressed).toBe(true);
	});
});

describe("annotateFpFilter — negative (must not suppress)", () => {
	it("N1: keeps a known-TP-shaped finding but still records p", () => {
		const rows = [tpShaped()];
		annotateFpFilter(rows, ON, ev(), CWD);
		expect(rows[0]?.fpFilter).toEqual({ p: expect.any(Number), suppressed: false });
		expect(rows[0]?.fpFilter?.p).toBeGreaterThan(0.5);
	});

	it("N2: never touches a [proven] finding, however FP-shaped its path", () => {
		const rows = [fpShaped({ name: "typescript", file: `${CWD}/scratch/x.ts` })];
		annotateFpFilter(rows, ON, ev(), CWD);
		expect(rows[0]?.fpFilter).toBeUndefined();
	});
});

describe("annotateFpFilter — repeat count", () => {
	it("counts prior occurrences per (session, file, check) and skips dry runs", () => {
		const event = ev();
		const p = (e: HarnessEvent): number => {
			const rows = [fpShaped()];
			annotateFpFilter(rows, ON, e, CWD);
			return rows[0]?.fpFilter?.p ?? Number.NaN;
		};
		const first = p(event);
		const second = p(event);
		expect(second).toBeGreaterThan(first);
		const dry = { ...event, dry_run: true };
		const third = p(dry);
		expect(p(dry)).toBe(third);
		expect(p(ev())).toBe(first);
	});
});

describe("splitFpSuppressed", () => {
	it("downgrade removes suppressed findings and names them in one trailer", () => {
		const rows = [fpShaped(), fpShaped({ file: `${CWD}/src/c.ts` }), tpShaped()];
		annotateFpFilter(rows, ON, ev(), CWD);
		const { shown, trailer } = splitFpSuppressed(rows, ON);
		expect(shown.map((r) => r.name)).toEqual(["magic_number"]);
		expect(trailer).toMatch(/^\[interlinked:fp-filter\] \[heuristic\] 2 findings suppressed by fp_filter \(p<0\.0235\): function_arg_count×2; audit: /);
	});

	it("hide carries only the count", () => {
		const rows = [fpShaped()];
		annotateFpFilter(rows, { enabled: true, mode: "hide" }, ev(), CWD);
		expect(splitFpSuppressed(rows, { enabled: true, mode: "hide" }).trailer).toBe(
			"[interlinked:fp-filter] [heuristic] 1 finding suppressed by fp_filter (p<0.0235); audit: interlinked query checks --where fp_filter_suppressed=true",
		);
	});
});

describe("recording and delivery", () => {
	it("collectQualityResultEntries records p and the suppressed flag", () => {
		const rows = [fpShaped(), tpShaped()];
		annotateFpFilter(rows, ON, ev(), CWD);
		const acc: Parameters<typeof collectQualityResultEntries>[1] = [];
		collectQualityResultEntries(rows, acc);
		expect(acc[0]).toMatchObject({ name: "function_arg_count", fp_filter_suppressed: true, fp_filter_p: expect.any(Number) });
		expect(acc[1]).toMatchObject({ name: "magic_number", fp_filter_p: expect.any(Number) });
		expect(acc[1]?.fp_filter_suppressed).toBeUndefined();
	});

	it("applyQualityDecision replaces suppressed warnings with the trailer", () => {
		const ctx = makeServerRuntime({ cwd: CWD, rules: { ...makeServerRules(), fp_filter: ON }, log: vi.fn() });
		const rows = [fpShaped(), tpShaped()];
		annotateFpFilter(rows, ON, ev(), CWD);
		const decision: HarnessDecision = { decision: "allow" };
		applyQualityDecision(ctx, rows, decision);
		const warnings = decision.warnings ?? [];
		expect(warnings.some((w) => w.startsWith("[interlinked:magic_number]"))).toBe(true);
		expect(warnings.some((w) => w.startsWith("[interlinked:function_arg_count]"))).toBe(false);
		expect(warnings.at(-1)).toMatch(/^\[interlinked:fp-filter\] \[heuristic\] 1 finding suppressed/);
		expect(decision.decision).toBe("allow");
	});

	it("applyQualityDecision is unchanged when the filter is off", () => {
		const ctx = makeServerRuntime({ cwd: CWD, rules: makeServerRules(), log: vi.fn() });
		const rows = [fpShaped(), tpShaped()];
		const decision: HarnessDecision = { decision: "allow" };
		applyQualityDecision(ctx, rows, decision);
		const warnings = decision.warnings ?? [];
		expect(warnings.some((w) => w.startsWith("[interlinked:function_arg_count]"))).toBe(true);
		expect(warnings.some((w) => w.startsWith("[interlinked:fp-filter]"))).toBe(false);
	});
});
