// Companion tests for read-provenance.ts (LG-3/LG-4).
// Positives prove capture, drift detection, repeat-gating, and blind-span
// location; negatives prove the omp `seenLines === undefined` rule — no
// recorded provenance ⇒ no check fires.

import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	blindEditSpan,
	ensureEditMechanics,
	fnv1a32,
	recordFileView,
	staleReadWarning,
} from "./read-provenance.js";
import { createFreshSession } from "./session-state-mutators.js";
import type { HarnessEvent, SessionTrajectory } from "./types.js";

let dir: string;
let target: string;

const CONTENT = ["line one", "line two", "line three", "line four", "line five", ""].join("\n");

function makeEvent(overrides: Partial<HarnessEvent>): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "prov-test",
		agent_source: "claude",
		timestamp: new Date().toISOString(),
		cwd: dir,
		...overrides,
	};
}

function makeSession(): SessionTrajectory {
	return createFreshSession(makeEvent({}), "prov-test");
}

function readEvent(extra: Record<string, unknown> = {}): HarnessEvent {
	return makeEvent({
		tool_name: "Read",
		tool_input: { file_path: target, ...extra },
		tool_outcome: "success",
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "read-prov-"));
	target = join(dir, "sample.txt");
	writeFileSync(target, CONTENT);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("recordFileView", () => {
	it("captures a whole-file view on PostToolUse Read", () => {
		const session = makeSession();
		recordFileView(session, readEvent());
		const view = session.file_views?.get(target);
		expect(view).toBeDefined();
		expect(view?.ranges).toBeNull();
		expect(view?.line_hashes[0]).toBe(fnv1a32("line one"));
	});

	it("captures offset/limit reads as displayed ranges and unions them", () => {
		const session = makeSession();
		recordFileView(session, readEvent({ offset: 1, limit: 2 }));
		recordFileView(session, readEvent({ offset: 4, limit: 2 }));
		const view = session.file_views?.get(target);
		expect(view?.ranges).toEqual([
			[1, 2],
			[4, 5],
		]);
	});

	it("does not capture on PreToolUse events or failed writes", () => {
		const session = makeSession();
		recordFileView(
			session,
			makeEvent({ hook_event: "PreToolUse", tool_name: "Read", tool_input: { file_path: target } }),
		);
		recordFileView(
			session,
			makeEvent({
				tool_name: "Edit",
				tool_input: { file_path: target },
				tool_outcome: "error",
			}),
		);
		expect(session.file_views?.get(target)).toBeUndefined();
	});
});

describe("staleReadWarning", () => {
	function viewThenDrift(session: SessionTrajectory): void {
		recordFileView(session, readEvent());
		writeFileSync(target, CONTENT.replace("line three", "line 3 (reformatted)"));
	}

	it("warns once with the divergence line and current content", () => {
		const session = makeSession();
		viewThenDrift(session);
		const warning = staleReadWarning(session, makeEvent({}), "Edit", {
			file_path: target,
			old_string: "line one",
			new_string: "x",
		});
		expect(warning).toMatch(/\[interlinked:stale-read\]\[heuristic\]/);
		expect(warning).toMatch(/Divergence begins at line 3/);
		expect(warning).toContain("line 3 (reformatted)");
	});

	it("repeat-gates per (path, live-hash) so a formatter sweep warns once", () => {
		const session = makeSession();
		viewThenDrift(session);
		const input = { file_path: target, old_string: "line one", new_string: "x" };
		expect(staleReadWarning(session, makeEvent({}), "Edit", input)).not.toBeNull();
		expect(staleReadWarning(session, makeEvent({}), "Edit", input)).toBeNull();
		expect(session.edit_mechanics?.stale_reads).toBe(1);
	});

	it("uses the alternate fence when the drift context itself contains a code fence", () => {
		const session = makeSession();
		recordFileView(session, readEvent());
		writeFileSync(target, CONTENT.replace("line three", "```fenced```"));
		const warning = staleReadWarning(session, makeEvent({}), "Edit", {
			file_path: target,
			old_string: "line one",
			new_string: "x",
		});
		expect(warning).toContain("~~~~\n");
		expect(warning).toContain("```fenced```");
	});

	it("returns null when the drifted file is no longer readable (deleted)", () => {
		const session = makeSession();
		recordFileView(session, readEvent());
		unlinkSync(target);
		expect(
			staleReadWarning(session, makeEvent({}), "Edit", {
				file_path: target,
				old_string: "line one",
				new_string: "x",
			}),
		).toBeNull();
	});

	it("flags drift at max+1 when content only grew past the recorded view's length", () => {
		const session = makeSession();
		recordFileView(session, readEvent());
		// Preserve every recorded line (including the trailing "") and only add
		// a new line after it, so the overlap loop finds no mismatch.
		writeFileSync(target, `${CONTENT}\nextra line\n`);
		const warning = staleReadWarning(session, makeEvent({}), "Edit", {
			file_path: target,
			old_string: "line one",
			new_string: "x",
		});
		expect(warning).toMatch(/Divergence begins at line 7/);
	});

	it("stays silent without a recorded view, without drift, and for reads", () => {
		const session = makeSession();
		// No view recorded at all:
		expect(
			staleReadWarning(session, makeEvent({}), "Edit", { file_path: target }),
		).toBeNull();
		// View recorded, content unchanged:
		recordFileView(session, readEvent());
		expect(
			staleReadWarning(session, makeEvent({}), "Edit", { file_path: target }),
		).toBeNull();
		// Read tools are never checked:
		writeFileSync(target, "drifted\n");
		expect(
			staleReadWarning(session, makeEvent({}), "Read", { file_path: target }),
		).toBeNull();
	});
});

describe("blindEditSpan", () => {
	it("locates an anchor outside every displayed range", () => {
		const session = makeSession();
		recordFileView(session, readEvent({ offset: 1, limit: 2 })); // saw lines 1–2
		const span = blindEditSpan(session, makeEvent({}), "Edit", {
			file_path: target,
			old_string: "line four",
			new_string: "x",
		});
		expect(span).toEqual({ file: target, startLine: 4, endLine: 4 });
	});

	it("stays silent when the anchor was displayed, on whole-file views, and without provenance", () => {
		const session = makeSession();
		recordFileView(session, readEvent({ offset: 3, limit: 3 })); // saw lines 3–5
		expect(
			blindEditSpan(session, makeEvent({}), "Edit", {
				file_path: target,
				old_string: "line four",
				new_string: "x",
			}),
		).toBeNull();
		// Whole-file view ⇒ nothing is blind:
		recordFileView(session, readEvent());
		expect(
			blindEditSpan(session, makeEvent({}), "Edit", {
				file_path: target,
				old_string: "line one",
				new_string: "x",
			}),
		).toBeNull();
		// No view at all (bash-read world) ⇒ fail open:
		const fresh = makeSession();
		expect(
			blindEditSpan(fresh, makeEvent({}), "Edit", {
				file_path: target,
				old_string: "line one",
				new_string: "x",
			}),
		).toBeNull();
	});

	it("skips anchors the doom guard owns (not present in the file)", () => {
		const session = makeSession();
		recordFileView(session, readEvent({ offset: 1, limit: 2 }));
		expect(
			blindEditSpan(session, makeEvent({}), "Edit", {
				file_path: target,
				old_string: "never in the file",
				new_string: "x",
			}),
		).toBeNull();
	});

	it("returns null for a tool that is neither Edit nor MultiEdit", () => {
		const session = makeSession();
		recordFileView(session, readEvent({ offset: 1, limit: 2 }));
		expect(
			blindEditSpan(session, makeEvent({}), "Write", {
				file_path: target,
				old_string: "line four",
				new_string: "x",
			}),
		).toBeNull();
	});

	it("returns null when the tool input has no file_path", () => {
		const session = makeSession();
		expect(
			blindEditSpan(session, makeEvent({}), "Edit", { old_string: "line one", new_string: "x" }),
		).toBeNull();
	});

	it("returns null when the file is no longer readable (deleted after view was recorded)", () => {
		const session = makeSession();
		recordFileView(session, readEvent({ offset: 1, limit: 2 }));
		unlinkSync(target);
		expect(
			blindEditSpan(session, makeEvent({}), "Edit", {
				file_path: target,
				old_string: "line one",
				new_string: "x",
			}),
		).toBeNull();
	});

	it("locates the first out-of-range anchor across a MultiEdit edits array", () => {
		const session = makeSession();
		recordFileView(session, readEvent({ offset: 1, limit: 2 })); // saw lines 1–2
		const span = blindEditSpan(session, makeEvent({}), "MultiEdit", {
			file_path: target,
			edits: [
				{ old_string: "line one", new_string: "x" }, // inside displayed range
				{ old_string: "line four", new_string: "y" }, // outside
			],
		});
		expect(span).toEqual({ file: target, startLine: 4, endLine: 4 });
	});

	it("ignores non-object and stringless entries in a MultiEdit edits array", () => {
		const session = makeSession();
		recordFileView(session, readEvent({ offset: 1, limit: 2 }));
		expect(
			blindEditSpan(session, makeEvent({}), "MultiEdit", {
				file_path: target,
				edits: [null, "not-an-object", { new_string: "no old_string" }, 42],
			}),
		).toBeNull();
	});

	it("returns null (no anchors) when old_string and edits are both absent", () => {
		const session = makeSession();
		recordFileView(session, readEvent({ offset: 1, limit: 2 }));
		expect(
			blindEditSpan(session, makeEvent({}), "MultiEdit", { file_path: target }),
		).toBeNull();
	});
});

describe("rescue attribution", () => {
	it("counts a successful write to the doomed file within the step window", () => {
		const session = makeSession();
		const mechanics = ensureEditMechanics(session);
		mechanics.doomed = 1;
		mechanics.last_doom = { file: target, step: session.tool_call_count };
		recordFileView(
			session,
			makeEvent({ tool_name: "Edit", tool_input: { file_path: target }, tool_outcome: "success" }),
		);
		expect(mechanics.rescued).toBe(1);
		expect(mechanics.last_doom).toBeUndefined();
	});

	it("does not count writes to a different file", () => {
		const session = makeSession();
		const mechanics = ensureEditMechanics(session);
		mechanics.last_doom = { file: join(dir, "other.txt"), step: session.tool_call_count };
		recordFileView(
			session,
			makeEvent({ tool_name: "Edit", tool_input: { file_path: target }, tool_outcome: "success" }),
		);
		expect(mechanics.rescued).toBe(0);
	});

	it("does not count a rescue outside the step window", () => {
		const session = makeSession();
		const mechanics = ensureEditMechanics(session);
		mechanics.last_doom = { file: target, step: session.tool_call_count };
		session.tool_call_count += 10; // far past RESCUE_STEP_WINDOW
		recordFileView(
			session,
			makeEvent({ tool_name: "Edit", tool_input: { file_path: target }, tool_outcome: "success" }),
		);
		expect(mechanics.rescued).toBe(0);
		expect(mechanics.last_doom).toBeDefined();
	});
});

describe("recordFileView — additional branches", () => {
	it("does not capture a failed Read (isRead && outcome === error)", () => {
		const session = makeSession();
		recordFileView(
			session,
			makeEvent({ tool_name: "Read", tool_input: { file_path: target }, tool_outcome: "error" }),
		);
		expect(session.file_views?.get(target)).toBeUndefined();
	});

	it("captures an offset-only read as [offset, lineCount]", () => {
		const session = makeSession();
		recordFileView(session, readEvent({ offset: 3 }));
		const view = session.file_views?.get(target);
		expect(view?.ranges).toEqual([[3, 6]]);
	});

	it("captures a limit-only read as [1, limit]", () => {
		const session = makeSession();
		recordFileView(session, readEvent({ limit: 2 }));
		const view = session.file_views?.get(target);
		expect(view?.ranges).toEqual([[1, 2]]);
	});

	it("does not capture when the target path is a directory (readViewable throws)", () => {
		const session = makeSession();
		const dirPath = join(dir, "a-dir");
		mkdirSync(dirPath);
		recordFileView(
			session,
			makeEvent({ tool_name: "Read", tool_input: { file_path: dirPath }, tool_outcome: "success" }),
		);
		expect(session.file_views?.get(dirPath)).toBeUndefined();
	});

	it("resolves a relative file_path against the event's cwd", () => {
		const session = makeSession();
		writeFileSync(join(dir, "rel.txt"), "relative content\n");
		recordFileView(
			session,
			makeEvent({
				tool_name: "Read",
				cwd: dir,
				tool_input: { file_path: "rel.txt" },
				tool_outcome: "success",
			}),
		);
		expect(session.file_views?.get("rel.txt")).toBeDefined();
	});

	it("falls back to process.cwd() when the event carries no cwd", () => {
		const session = makeSession();
		const event = makeEvent({
			tool_name: "Read",
			tool_input: { file_path: "definitely-not-a-real-file-xyz123.txt" },
			tool_outcome: "success",
		});
		delete event.cwd;
		recordFileView(session, event);
		// The file doesn't exist relative to the real process cwd, so nothing is
		// captured — this test exercises the `event.cwd ?? process.cwd()` fallback.
		expect(session.file_views?.get("definitely-not-a-real-file-xyz123.txt")).toBeUndefined();
	});

	it("does not capture a file larger than the view size cap", () => {
		const session = makeSession();
		const bigPath = join(dir, "big.txt");
		writeFileSync(bigPath, "x".repeat(2 * 1024 * 1024 + 1));
		recordFileView(
			session,
			makeEvent({ tool_name: "Read", tool_input: { file_path: bigPath }, tool_outcome: "success" }),
		);
		expect(session.file_views?.get(bigPath)).toBeUndefined();
	});
});
