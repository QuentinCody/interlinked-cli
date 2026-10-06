import { describe, expect, it } from "vitest";
import { Monitor, type Property } from "./eval.js";
import { always, and, atom, eventually, implies, next, not, or, release, until } from "./formula.js";

type S = { verifies: number };
type E = { kind: "edit" | "verify" | "read"; input: { file?: string } };

const edit = atom<S, E>("edit", (_s, e) => e.kind === "edit");
const verify = atom<S, E>("verify", (_s, e) => e.kind === "verify");
const read = atom<S, E>("read", (_s, e) => e.kind === "read");
const verified = atom<S, E>("verified", (s) => s.verifies > 0);

function ev(kind: E["kind"], file?: string): E {
	return { kind, input: file === undefined ? {} : { file } };
}

/** Run `trace` through a single-property monitor; return the per-event verdicts and the end verdict. */
function run(formula: Property<S, E>["formula"], trace: E[]) {
	const m = new Monitor<S, E>([{ id: "p", formula }]);
	const state: S = { verifies: 0 };
	const steps = trace.map((e) => {
		if (e.kind === "verify") state.verifies += 1;
		const [r] = m.step(state, e);
		return r;
	});
	const [end] = m.end();
	return { steps, end, verdicts: steps.map((s) => s?.verdict), endVerdict: end?.verdict, leaning: end?.leaning };
}

describe("Monitor — positive (must report)", () => {
	it("P1: always(¬edit) reports a violation at each offending event, stays alive, dedups by onset", () => {
		const trace = [ev("read"), ev("edit"), ev("read"), ev("edit")];
		const r = run(always(not(edit)), trace);
		expect(r.verdicts).toEqual(["pending", "false", "false", "false"]); // false is sticky; reports keep coming
		expect(r.steps[2]?.violations).toEqual([]);
		expect(r.steps[1]?.violations.map((v) => [v.onset, v.at])).toEqual([[1, 1]]);
		expect(r.steps[3]?.violations.map((v) => [v.onset, v.at])).toEqual([[3, 3]]);
		expect(r.endVerdict).toBe("false"); // a violated property is false over the whole trace
		const clean = run(always(not(edit)), [ev("read"), ev("verify")]);
		expect(clean.endVerdict).toBe("unknown"); // LTL3: a finite trace cannot confirm a safety property
		expect(clean.leaning).toBe("true"); // reporting leaning: nothing refuted it
	});

	it("P2: eventually(verify).within(3) counts the current event first and times out exactly at the bound", () => {
		expect(run(eventually(verify, 3), [ev("read"), ev("read"), ev("verify")]).verdicts).toEqual([
			"pending",
			"pending",
			"true",
		]);
		expect(run(eventually(verify, 3), [ev("read"), ev("read"), ev("read")]).verdicts).toEqual([
			"pending",
			"pending",
			"false",
		]);
	});

	it("P3: always(edit ⇒ eventually(verify).within(3)) reports the onset of the edit that went unverified", () => {
		const trace = [ev("edit"), ev("read"), ev("read"), ev("read"), ev("verify")];
		const r = run(always(implies(edit, eventually(verify, 3))), trace);
		expect(r.verdicts).toEqual(["pending", "pending", "false", "false", "false"]);
		expect(r.steps[2]?.violations.map((v) => [v.onset, v.at])).toEqual([[0, 2]]);
		expect(r.steps.slice(3).flatMap((s) => s?.violations ?? [])).toEqual([]); // the later edits were verified
	});

	it("P4: an obligation spawned inside a bounded always is kept after the window closes (differs from Bombadil)", () => {
		// always(…).within(2) activates two eventually(verify).within(3) obligations
		// at events 0 and 1; the second one can only time out at event 3.
		const trace = [ev("edit"), ev("edit"), ev("read"), ev("read"), ev("read")];
		const r = run(always(implies(edit, eventually(verify, 3)), 2), trace);
		// After event 3 the window is closed and every obligation is resolved: the property settles false.
		expect(r.verdicts).toEqual(["pending", "pending", "false", "false", "false"]);
		expect(r.steps[3]?.violations.map((v) => v.onset)).toEqual([1]);
		expect(r.steps[4]?.violations).toEqual([]);
		expect(r.endVerdict).toBe("false");
	});

	it("P5: a violation carries only the atoms and fields it read", () => {
		const editsFile = atom<S, E>("editsFile", (_s, e) => e.kind === "edit" && e.input.file !== undefined);
		const r = run(always(implies(editsFile, verified)), [ev("edit", "/a.ts")]);
		const v = r.steps[0]?.violations[0];
		expect(v?.evidence.map((a) => a.name)).toEqual(["editsFile", "verified"]);
		expect(v?.evidence[0]?.reads).toEqual(["event.kind", "event.input", "event.input.file"]);
		expect(v?.evidence[1]?.reads).toEqual(["state.verifies"]);
	});

	it("P6: next(verify) looks at the following event only", () => {
		expect(run(next(verify), [ev("edit"), ev("verify")]).verdicts).toEqual(["pending", "true"]);
		expect(run(next(verify), [ev("edit"), ev("read")]).verdicts).toEqual(["pending", "false"]);
	});

	it("P7: until — read until verify holds; a non-read before verify refutes it and the evidence names both sides", () => {
		expect(run(until(read, verify), [ev("read"), ev("read"), ev("verify")]).verdicts).toEqual([
			"pending",
			"pending",
			"true",
		]);
		const refuted = run(until(read, verify), [ev("read"), ev("edit")]);
		expect(refuted.verdicts).toEqual(["pending", "false"]);
		expect(refuted.steps[1]?.violations[0]?.evidence.map((a) => a.name)).toEqual(["verify", "read"]);
	});

	it("P8: release — the right side holds up to and including the first left event", () => {
		expect(run(release(verify, read), [ev("read"), ev("edit")]).verdicts).toEqual(["pending", "false"]);
		// `read` must hold at the releasing event too: and(read, verify) never holds here, so release stays open.
		const open = run(release(verify, read), [ev("read"), ev("read")]);
		expect(open.endVerdict).toBe("unknown");
		expect(open.leaning).toBe("true");
	});
});

describe("Monitor — negative (must not report) and end-of-trace", () => {
	it("N1: an unbounded eventually never fails mid-trace and ends UNKNOWN, not pass", () => {
		const r = run(eventually(verify), [ev("read"), ev("edit")]);
		expect(r.verdicts).toEqual(["pending", "pending"]);
		expect(r.endVerdict).toBe("unknown");
		expect(r.leaning).toBe("unknown"); // a strong obligation stays unknown under both folds
	});

	it("N2: a satisfied property settles and is not re-evaluated", () => {
		const r = run(eventually(verify), [ev("verify"), ev("edit"), ev("edit")]);
		expect(r.verdicts).toEqual(["true", "true", "true"]);
		expect(r.steps.flatMap((s) => s?.violations ?? [])).toEqual([]);
		expect(r.endVerdict).toBe("true");
	});

	it("N3: the same onset is reported once even when two obligations fail together", () => {
		// Both branches of the conjunction fail at event 1 with onset 1 — one report, two evidence atoms.
		const r = run(always(and(not(edit), verified)), [ev("read"), ev("edit")]);
		expect(r.steps[1]?.violations).toHaveLength(1);
		expect(r.steps[1]?.violations[0]?.evidence.map((a) => a.name)).toEqual(["edit", "verified"]);
	});

	it("N4: or(eventually(verify), always(read)) — a satisfied disjunct wins and the other side's violations are absorbed", () => {
		const r = run(or(eventually(verify), always(read)), [ev("read"), ev("edit"), ev("verify")]);
		expect(r.verdicts).toEqual(["pending", "pending", "true"]);
		expect(r.steps[1]?.violations).toEqual([]);
	});

	it("N5: an until whose right side is pending at the end is UNKNOWN; a refuted one stays false", () => {
		expect(run(until(read, verify), [ev("read")]).endVerdict).toBe("unknown");
		expect(run(until(read, verify), [ev("edit")]).endVerdict).toBe("false");
	});

	it("N6: identical pending obligations are merged, so an unbounded always(eventually) stays bounded in size", () => {
		const m = new Monitor<S, E>([{ id: "p", formula: always(eventually(verify)) }]);
		const state: S = { verifies: 0 };
		for (let i = 0; i < 50; i++) m.step(state, ev("edit"));
		expect(m.size("p")).toBeLessThan(10);
		expect(m.end()[0]?.verdict).toBe("unknown");
	});

	it("N7: a throwing atom is unavailable, with no invented source violation or later clean verdict", () => {
		const boom = atom<S, E>("boom", () => {
			throw new Error("predicate exploded");
		});
		const r = run(always(boom), [ev("read")]);
		expect(r.verdicts).toEqual(["pending"]);
        expect(r.steps[0]?.violations).toEqual([]);
        expect(r.steps[0]?.unavailable).toContain("predicate exploded");
        expect(r.end?.unavailable).toContain("predicate exploded");
        expect(r.leaning).toBe("unknown");
	});
});
