import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyEvent, createState } from "../state.js";
import type { ToolEvent, TrajectoryState } from "../types.js";
import { Monitor } from "./eval.js";
import { LTL_PARITY_RULES, LTL_SHADOW_PROPERTIES, SOURCE_EDIT_VERIFIED_WITHIN } from "./rules.js";

// ---------------------------------------------------------------------------
// Recorded-shaped events (the fields the shadow normalizer forwards)
// ---------------------------------------------------------------------------

const MULTI = "line one\nline two\nline three\nline four\nline five\nline six\nline seven\nline eight\nline nine\nline ten";

function base(tool: string, hook: ToolEvent["hook"], i: number): ToolEvent {
	return { ts: "2026-10-04T00:00:00.000Z", session: "s", agent: "claude", tool, toolUseId: `tu-${i}`, hook, input: {} };
}
function readEv(file: string, i: number): ToolEvent {
	return { ...base("Read", "PostToolUse", i), input: { file_path: file } };
}
interface EditSpec {
	file: string;
	multiline: boolean;
	hook?: ToolEvent["hook"];
}
function editEv({ file, multiline, hook = "PostToolUse" }: EditSpec, i: number): ToolEvent {
	const oldStr = multiline ? MULTI : "x";
	return {
		...base("Edit", hook, i),
		input: { file_path: file, old_string: oldStr, new_string: `${oldStr}\n// edited ${i}` },
		contentSha256: `sha-${i}`,
		toolOutcome: "success",
		checkDecision: "allow",
	};
}
function bashEv(command: string, i: number): ToolEvent {
	return { ...base("Bash", "PostToolUse", i), input: { command }, toolOutcome: "success" };
}

const SOURCE_FILES = ["/r/src/a.ts", "/r/src/b.ts", "/r/src/c.ts"];
const TEST_FILE = "/r/src/a.test.ts";

type ShapeKind = "read" | "grep" | "edit" | "testEdit" | "verify" | "bash" | "preEdit";
type Shape = { kind: ShapeKind; n: number; multi: boolean };
/** Edits are weighted 3x so traces reach the 8 / 10 edit thresholds often. */
const KINDS: ShapeKind[] = ["read", "grep", "edit", "edit", "edit", "testEdit", "verify", "bash", "preEdit"];
const shapeArb: fc.Arbitrary<Shape> = fc.record({
	kind: fc.constantFrom(...KINDS),
	n: fc.integer({ min: 0, max: 2 }),
	multi: fc.boolean(),
});

function toEvent(s: Shape, i: number): ToolEvent {
	const src = SOURCE_FILES[s.n] ?? "/r/src/a.ts";
	switch (s.kind) {
		case "read":
			return readEv(src, i);
		case "grep":
			return { ...base("Grep", "PostToolUse", i), input: {} };
		case "edit":
			return editEv({ file: src, multiline: s.multi }, i);
		case "preEdit":
			return editEv({ file: src, multiline: s.multi, hook: "PreToolUse" }, i);
		case "testEdit":
			return editEv({ file: TEST_FILE, multiline: s.multi }, i);
		case "verify":
			return bashEv("npx vitest run src/a.test.ts", i);
		case "bash":
			return bashEv("ls -la", i);
	}
}

const traceArb: fc.Arbitrary<ToolEvent[]> = fc
	.array(shapeArb, { minLength: 1, maxLength: 40 })
	.map((shapes) => shapes.map((s, i) => toEvent(s, i)));

/** Fold the trace; at every event compare the hand-coded verdict with the formula's violation. */
function parityMismatches(ruleIndex: number, trace: ToolEvent[]): string[] {
	const rule = LTL_PARITY_RULES[ruleIndex];
	if (!rule) throw new Error(`no parity rule at ${ruleIndex}`);
	const state = createState("s");
	const monitor = new Monitor<TrajectoryState, ToolEvent>([rule.property]);
	const mismatches: string[] = [];
	trace.forEach((event, i) => {
		applyEvent(state, event);
		const hand = rule.handCoded(state, event) !== null;
		const [report] = monitor.step(state, event);
		const formula = (report?.violations.length ?? 0) > 0;
		if (hand !== formula) mismatches.push(`#${i} ${event.tool}/${event.hook}: hand=${hand} formula=${formula}`);
	});
	return mismatches;
}

function fired(ruleIndex: number, trace: ToolEvent[]): boolean[] {
	const rule = LTL_PARITY_RULES[ruleIndex];
	if (!rule) throw new Error(`no parity rule at ${ruleIndex}`);
	const state = createState("s");
	const monitor = new Monitor<TrajectoryState, ToolEvent>([rule.property]);
	return trace.map((event) => {
		applyEvent(state, event);
		return (monitor.step(state, event)[0]?.violations.length ?? 0) > 0;
	});
}

const COLD_START = 0;
const RATIO = 1;
const STREAK = 2;

describe("parity rules — positive (the formula fires where the hand-coded rule fires)", () => {
	it("P1: three hand-coded rules are expressed as formulas with matching ids", () => {
		expect(LTL_PARITY_RULES.map((r) => r.property.id)).toEqual([
			"reb_cold_start_first_edit_zero_reads",
			"vd_code_to_test_edit_ratio",
			"vd_code_edit_streak_no_verify",
		]);
	});

	it("P2: cold start — a first multi-line surgical edit with no orientation violates the formula", () => {
		expect(fired(COLD_START, [editEv({ file: "/r/src/a.ts", multiline: true }, 0)])).toEqual([true]);
	});

	it("P3: ratio — the tenth source edit with no test edit in the window violates the formula", () => {
		const trace = Array.from({ length: 10 }, (_, i) => editEv({ file: "/r/src/a.ts", multiline: false }, i));
		expect(fired(RATIO, trace).filter(Boolean)).toHaveLength(1);
		expect(fired(RATIO, trace)[9]).toBe(true);
	});

	it("P4: streak — eight unverified multi-line source edits violate the formula once, at the eighth", () => {
		const trace = Array.from({ length: 9 }, (_, i) => editEv({ file: "/r/src/b.ts", multiline: true }, i));
		const f = fired(STREAK, trace);
		expect(f[7]).toBe(true);
		expect(f.filter(Boolean)).toHaveLength(1);
	});

	it("P5: parity holds on random recorded-shaped traces for every rule", () => {
		for (const idx of [COLD_START, RATIO, STREAK]) {
			fc.assert(
				fc.property(traceArb, (trace) => {
					expect(parityMismatches(idx, trace)).toEqual([]);
				}),
				{ numRuns: 150 },
			);
		}
	});
});

describe("parity rules — negative (guards suppress exactly as the hand-coded rule does)", () => {
	it("N1: cold start — a prior Read suppresses; a single-line old_string suppresses", () => {
		expect(fired(COLD_START, [readEv("/r/src/a.ts", 0), editEv({ file: "/r/src/a.ts", multiline: true }, 1)])).toEqual([
			false,
			false,
		]);
		expect(fired(COLD_START, [editEv({ file: "/r/src/a.ts", multiline: false }, 0)])).toEqual([false]);
	});

	it("N2: ratio — one test edit in the window suppresses the tenth-edit violation", () => {
		const trace = [editEv({ file: TEST_FILE, multiline: false }, 0)];
		for (let i = 1; i <= 10; i++) trace.push(editEv({ file: "/r/src/a.ts", multiline: false }, i));
		expect(fired(RATIO, trace).some(Boolean)).toBe(false);
	});

	it("N3: streak — a verifier run resets the streak; single-line edits never reach 60 lines", () => {
		const trace: ToolEvent[] = [];
		for (let i = 0; i < 7; i++) trace.push(editEv({ file: "/r/src/b.ts", multiline: true }, i));
		trace.push(bashEv("npm test", 7));
		for (let i = 8; i < 15; i++) trace.push(editEv({ file: "/r/src/b.ts", multiline: true }, i));
		expect(fired(STREAK, trace).some(Boolean)).toBe(false);
		const small = Array.from({ length: 9 }, (_, i) => editEv({ file: "/r/src/b.ts", multiline: false }, i));
		expect(fired(STREAK, small).some(Boolean)).toBe(false);
	});
});

describe("future-time shadow property — source edit verified within N events", () => {
	function futureProp() {
		const prop = LTL_SHADOW_PROPERTIES.find((p) => p.id === "source_edit_verified_within_events");
		if (!prop) throw new Error("future-time property missing");
		return prop;
	}

	function run(trace: ToolEvent[]) {
		const state = createState("s");
		const m = new Monitor<TrajectoryState, ToolEvent>([futureProp()]);
		const reports = trace.map((e) => {
			applyEvent(state, e);
			return m.step(state, e)[0];
		});
		return { reports, end: m.end()[0] };
	}

	it("P1: an edit followed by N non-verifying events is a violation whose onset is the edit", () => {
		const trace = [editEv({ file: "/r/src/a.ts", multiline: false }, 0)];
		for (let i = 1; i < SOURCE_EDIT_VERIFIED_WITHIN; i++) trace.push(bashEv("ls", i));
		const { reports } = run(trace);
		const last = reports[SOURCE_EDIT_VERIFIED_WITHIN - 1];
		expect(last?.violations.map((v) => [v.onset, v.at])).toEqual([[0, SOURCE_EDIT_VERIFIED_WITHIN - 1]]);
		expect(reports.slice(0, -1).flatMap((r) => r?.violations ?? [])).toEqual([]);
	});
	it("event-clock.v1 counts Pre and Post separately even with the same tool-use ID", () => {
        const trace = [editEv({ file: "/r/src/a.ts", multiline: false }, 0)];
        for (let index = 1; trace.length < SOURCE_EDIT_VERIFIED_WITHIN; index++) {
            trace.push({ ...bashEv("ls", index), hook: "PreToolUse" });
            if (trace.length < SOURCE_EDIT_VERIFIED_WITHIN) trace.push(bashEv("ls", index));
        }
        expect(run(trace).reports.at(-1)?.violations.map(row => row.at)).toEqual([SOURCE_EDIT_VERIFIED_WITHIN - 1]);
    });

	it("N1: an edit followed by a verifier run is silent, and the open obligation at Stop is unknown-not-pass", () => {
		const clean = run([editEv({ file: "/r/src/a.ts", multiline: false }, 0), bashEv("npx tsc --noEmit", 1)]);
		expect(clean.reports.flatMap((r) => r?.violations ?? [])).toEqual([]);
		expect(clean.end?.leaning).toBe("true");
		const open = run([editEv({ file: "/r/src/a.ts", multiline: false }, 0), bashEv("ls", 1)]);
		expect(open.end?.verdict).toBe("unknown");
		expect(open.end?.leaning).toBe("unknown");
	});
});
