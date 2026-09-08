// Wave 32 survivor-kill campaign for read-provenance.ts.
// Each case targets one or more specific mutantIds from
// .interlinked/mutation-manifest.json — see scratch/fleet-r3/receipts/
// read-provenance.jsonl for the mutantId → test mapping.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blindEditSpan, ensureEditMechanics, fnv1a32, recordFileView, staleReadWarning } from "./read-provenance.js";
import { createFreshSession } from "./session-state-mutators.js";
import type { HarnessEvent, SessionTrajectory } from "./types.js";

let dir: string;
let target: string;

const CONTENT = ["line one", "line two", "line three", "line four", "line five", ""].join("\n");

function makeEvent(overrides: Partial<HarnessEvent>): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "prov-w32",
		agent_source: "claude",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: dir,
		...overrides,
	}; // SAFETY: test fixture — HarnessEvent has many optional discriminated fields tests don't all set
}

function makeSession(): SessionTrajectory {
	return createFreshSession(makeEvent({}), "prov-w32");
}

function readEvent(extra: Record<string, unknown> = {}): HarnessEvent {
	return makeEvent({
		tool_name: "Read",
		tool_input: { file_path: target, ...extra },
		tool_outcome: "success",
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "read-prov-w32-"));
	target = join(dir, "sample.txt");
	writeFileSync(target, CONTENT);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("fnv1a32 — exact value", () => {
	// test-contract: invariant — kills 80610c3e0543811d (i<=length off-by-one)
	it("produces the exact FNV-1a hash for a single-char string", () => {
		expect(fnv1a32("a")).toBe(3826002220);
	});
});

describe("readViewable — via recordFileView", () => {
	// test-contract: boundary — kills aa73618438c792d4 (size > cap becomes >=)
	it("captures a file exactly at the view size cap", () => {
		const session = makeSession();
		const atCapPath = join(dir, "at-cap.txt");
		writeFileSync(atCapPath, "x".repeat(2 * 1024 * 1024));
		recordFileView(
			session,
			makeEvent({ tool_name: "Read", tool_input: { file_path: atCapPath }, tool_outcome: "success" }),
		);
		expect(session.file_views?.get(atCapPath)).toBeDefined();
	});
});

describe("mergeView — via recordFileView", () => {
	// test-contract: invariant — kills 19a6cae36c6d8fe2 (hash-change check forced false)
	it("replaces the view entirely (not merges ranges) when the file content changed", () => {
		const session = makeSession();
		recordFileView(session, readEvent({ offset: 1, limit: 2 })); // ranges [[1,2]]
		writeFileSync(target, CONTENT.replace("line three", "line three (edited)"));
		recordFileView(session, readEvent({ offset: 4, limit: 2 })); // new content, ranges [[4,5]]
		const view = session.file_views?.get(target);
		expect(view?.ranges).toEqual([[4, 5]]);
	});

	// test-contract: invariant — kills 37ca9bf45f18a25b (existing.ranges===null check forced false)
	it("keeps a whole-file view whole when a later partial read arrives for the same content", () => {
		const session = makeSession();
		recordFileView(session, readEvent()); // whole-file view, ranges null
		expect(() => recordFileView(session, readEvent({ offset: 1, limit: 2 }))).not.toThrow();
		const view = session.file_views?.get(target);
		expect(view?.ranges).toBeNull();
	});
});

describe("trackRescue — via recordFileView", () => {
	// test-contract: invariant — kills 2823ffc03856559c (mechanics?.last_doom -> mechanics.last_doom)
	it("does not crash on a successful write when edit_mechanics was never initialized", () => {
		const session = makeSession();
		expect(session.edit_mechanics).toBeUndefined();
		expect(() =>
			recordFileView(
				session,
				makeEvent({ tool_name: "Edit", tool_input: { file_path: target }, tool_outcome: "success" }),
			),
		).not.toThrow();
	});

	// test-contract: invariant — kills 65609e2dab416eeb (!mechanics||!doom -> false) and
	// 6938f9eaea32bc40 (OR -> AND) — mechanics exists but no last_doom is set
	it("does not crash and does not rescue when mechanics exist but there is no last_doom", () => {
		const session = makeSession();
		const mechanics = ensureEditMechanics(session);
		expect(() =>
			recordFileView(
				session,
				makeEvent({ tool_name: "Edit", tool_input: { file_path: target }, tool_outcome: "success" }),
			),
		).not.toThrow();
		expect(mechanics.rescued).toBe(0);
	});

	// test-contract: boundary — kills 566c5eb1dfbc51c1 (<=window+1 -> <window+1)
	it("rescues exactly at the +1 step-window boundary", () => {
		const session = makeSession();
		const mechanics = ensureEditMechanics(session);
		mechanics.last_doom = { file: target, step: session.tool_call_count };
		session.tool_call_count += 3; // RESCUE_STEP_WINDOW(2) + 1
		recordFileView(
			session,
			makeEvent({ tool_name: "Edit", tool_input: { file_path: target }, tool_outcome: "success" }),
		);
		expect(mechanics.rescued).toBe(1);
	});

	// test-contract: boundary — kills 3d87805b2490db69 (subtraction -> addition)
	it("computes step distance via subtraction, not addition", () => {
		const session = makeSession();
		const mechanics = ensureEditMechanics(session);
		session.tool_call_count = 5;
		mechanics.last_doom = { file: target, step: 5 };
		recordFileView(
			session,
			makeEvent({ tool_name: "Edit", tool_input: { file_path: target }, tool_outcome: "success" }),
		);
		expect(mechanics.rescued).toBe(1);
	});

	// test-contract: boundary — kills 3e71d07150f5796d (window+1 -> window-1)
	it("still rescues at step distance 2, inside the +1 window", () => {
		const session = makeSession();
		const mechanics = ensureEditMechanics(session);
		mechanics.last_doom = { file: target, step: session.tool_call_count };
		session.tool_call_count += 2;
		recordFileView(
			session,
			makeEvent({ tool_name: "Edit", tool_input: { file_path: target }, tool_outcome: "success" }),
		);
		expect(mechanics.rescued).toBe(1);
	});
});

describe("recordFileView — guard clause mutants", () => {
	// test-contract: invariant — kills 955d6cc9ea85c78d (!filePath||!toolName -> false) and
	// a6f4e6edaf8b57cf (OR -> AND)
	it("fails open (no throw, no capture) when file_path is missing", () => {
		const session = makeSession();
		expect(() =>
			recordFileView(session, makeEvent({ tool_name: "Read", tool_input: {}, tool_outcome: "success" })),
		).not.toThrow();
		expect(session.file_views).toBeUndefined();
	});

	// test-contract: invariant — kills 24937feceab13488 (!=="interrupted" -> true) and
	// 142ab002a573d06c ("interrupted" -> "")
	it("does not treat an interrupted write as succeeded", () => {
		const session = makeSession();
		recordFileView(
			session,
			makeEvent({ tool_name: "Edit", tool_input: { file_path: target }, tool_outcome: "interrupted" }),
		);
		expect(session.file_views?.get(target)).toBeUndefined();
	});

	// test-contract: invariant — kills 11c72e2380f9baf0 (!isRead -> true)
	it("only attempts a rescue for writes, never for reads", () => {
		const session = makeSession();
		const mechanics = ensureEditMechanics(session);
		mechanics.last_doom = { file: target, step: session.tool_call_count };
		recordFileView(session, readEvent());
		expect(mechanics.rescued).toBe(0);
		expect(mechanics.last_doom).toBeDefined();
	});
});

describe("firstDriftLine — via staleReadWarning", () => {
	// test-contract: boundary — kills a9b17a9a6b89d053 (Math.min -> Math.max) and
	// 8ada31e76a9dbd56 (i<max -> i<=max) — both would index past the shorter array
	it("bounds the drift scan by the shorter of the two line arrays, not the longer", () => {
		const session = makeSession();
		writeFileSync(target, "a\nb\nc\nd\n");
		recordFileView(session, readEvent());
		writeFileSync(target, "a\nb"); // shrunk to 2 lines, matching the view's first two
		expect(() =>
			staleReadWarning(session, makeEvent({}), "Edit", { file_path: target, old_string: "a", new_string: "x" }),
		).not.toThrow();
	});
});

describe("renderDriftContext — via staleReadWarning", () => {
	// test-contract: boundary — kills fe200b360aad3168 (Math.max->Math.min start),
	// 25d0aef7ade7a9b9 (Math.min->Math.max end), bce9a1e21f6a028d (slice -> full array),
	// 408e623ab2086a52 (start-1 -> start+1), 32d9b75e41c8cb4f ("\n" -> ""),
	// 8fff6f288d187f1f and f0c6f5b3 (fence literals -> "")
	it("shows exactly the ±2-line window around the drift, newline-joined, fenced with backticks", () => {
		const session = makeSession();
		const lines = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet"];
		writeFileSync(target, lines.join("\n"));
		recordFileView(session, readEvent());
		const changed = [...lines];
		changed[4] = "Echo-changed"; // line 5 diverges
		writeFileSync(target, changed.join("\n"));
		const warning = staleReadWarning(session, makeEvent({}), "Edit", {
			file_path: target,
			old_string: "Alpha",
			new_string: "x",
		});
		const m = warning?.match(/lines (\d+)\S(\d+):/);
		expect(m?.[1]).toBe("3");
		expect(m?.[2]).toBe("7");
		expect(warning).toContain("Charlie\nDelta");
		expect(warning).toContain("Golf");
		expect(warning).not.toContain("Bravo");
		expect(warning).not.toContain("Hotel");
		expect(warning).toContain("```\nCharlie");
		expect(warning).toContain("Golf\n```");
	});
});

describe("staleReadWarning — literal and gating mutants", () => {
	// test-contract: invariant — kills d0ed99c1e259ae40 (cause phrase -> "")
	it("names the possible causes of drift in the message", () => {
		const session = makeSession();
		recordFileView(session, readEvent());
		writeFileSync(target, CONTENT.replace("line three", "line 3 (edited)"));
		const warning = staleReadWarning(session, makeEvent({}), "Edit", {
			file_path: target,
			old_string: "line one",
			new_string: "x",
		});
		expect(warning).toContain("a formatter, another agent, or an out-of-band edit");
	});

	// test-contract: invariant — kills 67243d57b8db45ad (gateKey -> "")
	it("repeat-gates independently per file (the gate key includes the path)", () => {
		const session = makeSession();
		const target2 = join(dir, "sample2.txt");
		writeFileSync(target2, CONTENT);
		recordFileView(session, readEvent());
		recordFileView(session, makeEvent({ tool_name: "Read", tool_input: { file_path: target2 }, tool_outcome: "success" }));
		writeFileSync(target, CONTENT.replace("line three", "changed A"));
		writeFileSync(target2, CONTENT.replace("line three", "changed B"));
		const w1 = staleReadWarning(session, makeEvent({}), "Edit", {
			file_path: target,
			old_string: "line one",
			new_string: "x",
		});
		const w2 = staleReadWarning(session, makeEvent({}), "Edit", {
			file_path: target2,
			old_string: "line one",
			new_string: "x",
		});
		expect(w1).not.toBeNull();
		expect(w2).not.toBeNull();
	});
});

describe("insideDisplayedRanges — via blindEditSpan", () => {
	// test-contract: invariant — kills f9085fec013c19bd (.some -> .every)
	it("treats an anchor as displayed if it is inside any one of several ranges", () => {
		const session = makeSession();
		recordFileView(session, readEvent({ offset: 1, limit: 2 })); // range [1,2]
		recordFileView(session, readEvent({ offset: 4, limit: 2 })); // range [4,5]
		const span = blindEditSpan(session, makeEvent({}), "Edit", {
			file_path: target,
			old_string: "line four",
			new_string: "x",
		});
		expect(span).toBeNull();
	});

	// test-contract: invariant — kills 5b89d056c544992c (start>=lo -> true)
	it("flags an anchor as blind when it starts before the displayed range, even if it ends inside", () => {
		const session = makeSession();
		recordFileView(session, readEvent({ offset: 4, limit: 2 })); // saw lines 4-5
		const span = blindEditSpan(session, makeEvent({}), "Edit", {
			file_path: target,
			old_string: "line three\nline four",
			new_string: "x",
		});
		expect(span).toEqual({ file: target, startLine: 3, endLine: 4 });
	});

	// test-contract: boundary — kills a18b78a464888ec1 (end<=hi -> end<hi)
	it("treats an anchor ending exactly at the displayed range's end as inside it", () => {
		const session = makeSession();
		recordFileView(session, readEvent({ offset: 1, limit: 4 })); // saw lines 1-4
		const span = blindEditSpan(session, makeEvent({}), "Edit", {
			file_path: target,
			old_string: "line four",
			new_string: "x",
		});
		expect(span).toBeNull();
	});
});

describe("blindEditSpan — guard and anchor mutants", () => {
	// test-contract: invariant — kills 47eeb57b67371495 (!filePath -> false)
	it("fails open without reaching resolveEventPath when file_path is missing, even with a stray map entry", () => {
		const session = makeSession();
		session.file_views = new Map();
		// SAFETY: deliberately forcing an undefined-keyed Map entry to prove
		// blindEditSpan never reaches this state (its own guard must return first).
		session.file_views.set(undefined as unknown as string, {
			hash: "x",
			line_hashes: new Uint32Array(0),
			at_step: 0,
			ranges: [[1, 1]],
		});
		expect(() =>
			blindEditSpan(session, makeEvent({}), "Edit", { old_string: "line one", new_string: "x" }),
		).not.toThrow();
	});

	// test-contract: invariant — kills 51e5ef4f7500e589 (at===-1 -> false) and
	// 7268e1f91b1a2d1e (-1 -> +1)
	it("skips an anchor not found in the file rather than fabricating line 1", () => {
		const session = makeSession();
		recordFileView(session, readEvent({ offset: 4, limit: 2 })); // saw lines 4-5 only
		const span = blindEditSpan(session, makeEvent({}), "Edit", {
			file_path: target,
			old_string: "never in the file",
			new_string: "x",
		});
		expect(span).toBeNull();
	});

	// test-contract: boundary — kills 47be0004aa9b0eb7 (i<at -> i<=at)
	it("counts newlines strictly before the anchor position, not through it", () => {
		const session = makeSession();
		recordFileView(session, readEvent({ offset: 1, limit: 2 })); // saw lines 1-2 only
		const span = blindEditSpan(session, makeEvent({}), "Edit", {
			file_path: target,
			old_string: "\nline four",
			new_string: "x",
		});
		expect(span?.startLine).toBe(3);
	});
});

describe("anchorStrings — array-seed and type-guard mutants", () => {
	// test-contract: invariant — kills ddad63f06cd5be81 (early-return [] -> ["Stryker was here"])
	it("yields no phantom anchors when edits is not an array", () => {
		const session = makeSession();
		writeFileSync(target, "Stryker was here\nline two\n");
		recordFileView(session, readEvent({ offset: 2, limit: 1 })); // saw only line 2
		const span = blindEditSpan(session, makeEvent({}), "MultiEdit", { file_path: target });
		expect(span).toBeNull();
	});

	// test-contract: invariant — kills 907610dcecd08428 (accumulator [] -> ["Stryker was here"])
	it("yields no phantom anchors when the edits array has no valid old_string entries", () => {
		const session = makeSession();
		writeFileSync(target, "Stryker was here\nline two\n");
		recordFileView(session, readEvent({ offset: 2, limit: 1 })); // saw only line 2
		const span = blindEditSpan(session, makeEvent({}), "MultiEdit", {
			file_path: target,
			edits: [null, "not-an-object", { new_string: "no old_string" }, 42],
		});
		expect(span).toBeNull();
	});

	// test-contract: invariant — kills 17e315d8d0d4942f (typeof oldS==="string" -> true)
	it("only collects string old_string values, not non-string ones coerced by indexOf", () => {
		const session = makeSession();
		writeFileSync(target, "abc\n42\nxyz\n");
		recordFileView(session, readEvent({ offset: 1, limit: 1 })); // saw only line 1
		const span = blindEditSpan(session, makeEvent({}), "MultiEdit", {
			file_path: target,
			edits: [{ old_string: 42, new_string: "y" }],
		});
		expect(span).toBeNull();
	});
});
