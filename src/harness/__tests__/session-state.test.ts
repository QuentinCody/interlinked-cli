import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractNonTrivialLiterals, isFileTrackedAsWritten, SessionTracker } from "../session-state.js";
import { recordSkillEnter } from "../session-skills.js";
import type { HarnessEvent } from "../types.js";

/** sha256 helper used to assert content_hash and literal_hash equality. */
function sha256(s: string): string {
	return createHash("sha256").update(s).digest("hex");
}

/** Minimal PreToolUse event — enough for recordEvent to mint a trajectory.
 *  The timestamp is a fixed literal: this suite asserts on signal merges,
 *  not on time, so a deterministic value keeps the tests flake-free. */
function evt(sessionId: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: sessionId,
		agent_source: "claude",
		timestamp: "2026-05-17T00:00:00.000Z",
	};
}

describe("SessionTracker.recordEvent — agent_name late resolution", () => {
	it("adopts a later-arriving agent_name while the placeholder is still active", () => {
		const t = new SessionTracker();
		// First event has no agent_name — createFreshSession synthesizes the
		// "session-<id>" placeholder.
		const first = t.recordEvent(evt("sess-late"));
		expect(first.agent_name.startsWith("session-")).toBe(true);

		// A later event (e.g. after register_agent resolves the real name)
		// carries agent_name — recordEvent must adopt it.
		const withName: HarnessEvent = { ...evt("sess-late"), agent_name: "alice" };
		const second = t.recordEvent(withName);
		expect(second.agent_name).toBe("alice");
	});

	it("does NOT clobber an already-resolved agent_name with a later different one", () => {
		const t = new SessionTracker();
		t.recordEvent({ ...evt("sess-resolved"), agent_name: "alice" });
		// A later event claiming a different name must not override — only the
		// "session-" placeholder is eligible for replacement.
		const session = t.recordEvent({ ...evt("sess-resolved"), agent_name: "bob" });
		expect(session.agent_name).toBe("alice");
	});
});

describe("SessionTracker.recordEvent — missing session_id fallback", () => {
	it("synthesizes a session for an event with an empty session_id instead of throwing", () => {
		const t = new SessionTracker();
		const malformed: HarnessEvent = { ...evt(""), session_id: "" };
		const session = t.recordEvent(malformed);
		expect(session.session_id.startsWith("unknown-")).toBe(true);
		expect(t.getAll()).toHaveLength(1);
	});
});

describe("SessionTracker.getAll / detectStale", () => {
	it("getAll returns every tracked session", () => {
		const t = new SessionTracker();
		t.recordEvent(evt("a"));
		t.recordEvent(evt("b"));
		const all = t.getAll();
		expect(all).toHaveLength(2);
		expect(all.map((s) => s.session_id).sort()).toEqual(["a", "b"]);
	});

	it("getAll returns an empty array when nothing is tracked", () => {
		const t = new SessionTracker();
		expect(t.getAll()).toEqual([]);
	});

	it("flags a session as stale: has tool calls AND started long before the cutoff", () => {
		const t = new SessionTracker();
		const oldTs = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
		t.recordEvent(editEvt({ sessionId: "old", filePath: "src/a.ts" })); // has tool_name -> tool_call_count > 0
		const session = t.get("old");
		if (session) session.started_at = oldTs;

		const stale = t.detectStale(60 * 60 * 1000); // 1h timeout
		expect(stale.map((s) => s.session_id)).toEqual(["old"]);
	});

	it("does NOT flag a session with zero tool calls, even if started long ago (short-circuit)", () => {
		const t = new SessionTracker();
		const oldTs = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		t.recordEvent(evt("idle")); // evt() carries no tool_name -> tool_call_count stays 0
		const session = t.get("idle");
		if (session) session.started_at = oldTs;

		const stale = t.detectStale(60 * 60 * 1000);
		expect(stale).toEqual([]);
	});

	it("does NOT flag a session that has tool calls but started recently", () => {
		const t = new SessionTracker();
		t.recordEvent(editEvt({ sessionId: "fresh", filePath: "src/a.ts" }));
		const session = t.get("fresh");
		// Force started_at to the actual current wall-clock time (editEvt's
		// fixed literal timestamp is itself long past relative to "now").
		if (session) session.started_at = new Date().toISOString();
		const stale = t.detectStale(60 * 60 * 1000); // 1h — generous window
		expect(stale.map((s) => s.session_id)).not.toContain("fresh");
	});

	// Exact-boundary case: a session started EXACTLY at the cutoff instant is
	// NOT stale (strict `<`). Fake timers make `Date.now()` (the cutoff basis)
	// deterministic so the boundary can be hit precisely instead of by luck.
	describe("exact cutoff boundary", () => {
		const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z").getTime();

		afterEach(() => {
			vi.useRealTimers();
		});

		it("excludes a session whose started_at equals the cutoff instant exactly", () => {
			vi.useFakeTimers();
			vi.setSystemTime(FIXED_NOW);
			const t = new SessionTracker();
			const timeoutMs = 60 * 60 * 1000;
			const cutoff = FIXED_NOW - timeoutMs;
			t.recordEvent(editEvt({ sessionId: "boundary", filePath: "src/a.ts" }));
			const session = t.get("boundary");
			if (session) session.started_at = new Date(cutoff).toISOString();

			const stale = t.detectStale(timeoutMs);
			expect(stale.map((s) => s.session_id)).not.toContain("boundary");
		});

		it("includes a session started 1ms before the cutoff instant", () => {
			vi.useFakeTimers();
			vi.setSystemTime(FIXED_NOW);
			const t = new SessionTracker();
			const timeoutMs = 60 * 60 * 1000;
			const cutoff = FIXED_NOW - timeoutMs;
			t.recordEvent(editEvt({ sessionId: "just-stale", filePath: "src/a.ts" }));
			const session = t.get("just-stale");
			if (session) session.started_at = new Date(cutoff - 1).toISOString();

			const stale = t.detectStale(timeoutMs);
			expect(stale.map((s) => s.session_id)).toContain("just-stale");
		});
	});
});

describe("SessionTracker.rollUpFileTracking", () => {
	it("returns false when fromSessionId === toSessionId", () => {
		const t = new SessionTracker();
		t.recordEvent(evt("solo"));
		expect(t.rollUpFileTracking("solo", "solo")).toBe(false);
	});

	it("returns false when either session is missing", () => {
		const t = new SessionTracker();
		t.recordEvent(evt("only"));
		expect(t.rollUpFileTracking("only", "ghost")).toBe(false);
		expect(t.rollUpFileTracking("ghost", "only")).toBe(false);
	});

	it("unions files_read from child into parent", () => {
		const t = new SessionTracker();
		const child = t.recordEvent(evt("child"));
		const parent = t.recordEvent(evt("parent"));
		child.files_read.add("src/a.ts");
		child.files_read.add("src/b.ts");
		parent.files_read.add("src/b.ts"); // overlap should stay a single entry

		expect(t.rollUpFileTracking("child", "parent")).toBe(true);
		expect([...parent.files_read].sort()).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("gap-fills file_write_times without clobbering the parent's own timestamp", () => {
		const t = new SessionTracker();
		const child = t.recordEvent(evt("child"));
		const parent = t.recordEvent(evt("parent"));
		child.file_write_times.set("only-child.ts", "2026-05-27T00:00:01.000Z");
		// stale — parent already has its own (newer) timestamp for this file
		child.file_write_times.set("shared.ts", "2026-05-27T00:00:09.000Z");
		parent.file_write_times.set("shared.ts", "2026-05-27T00:00:05.000Z");

		t.rollUpFileTracking("child", "parent");
		expect(parent.file_write_times.get("only-child.ts")).toBe("2026-05-27T00:00:01.000Z");
		expect(parent.file_write_times.get("shared.ts")).toBe("2026-05-27T00:00:05.000Z"); // unchanged
	});

	it("sums file_edit_counts across parent and child", () => {
		const t = new SessionTracker();
		const child = t.recordEvent(evt("child"));
		const parent = t.recordEvent(evt("parent"));
		child.file_edit_counts.set("a.ts", 2);
		child.file_edit_counts.set("b.ts", 1);
		parent.file_edit_counts.set("a.ts", 3);

		t.rollUpFileTracking("child", "parent");
		expect(parent.file_edit_counts.get("a.ts")).toBe(5); // 3 + 2
		expect(parent.file_edit_counts.get("b.ts")).toBe(1); // 0 + 1
	});
});

describe("SessionTracker.rollUpVerificationSignals", () => {
	it("merges the child's verification_observed into the parent (set union)", () => {
		const t = new SessionTracker();
		const child = t.recordEvent(evt("child"));
		const parent = t.recordEvent(evt("parent"));
		child.verification_observed = new Set(["test", "lint"]);
		parent.verification_observed = new Set(["typecheck"]);

		expect(t.rollUpVerificationSignals("child", "parent")).toBe(true);
		expect([...(t.get("parent")?.verification_observed ?? [])].sort()).toEqual([
			"lint",
			"test",
			"typecheck",
		]);
	});

	it("gap-fills test_runs without clobbering the parent's own entry", () => {
		const t = new SessionTracker();
		const child = t.recordEvent(evt("child"));
		const parent = t.recordEvent(evt("parent"));
		child.test_runs.set("a.test.ts", { status: "pass", at_step: 1 });
		child.test_runs.set("shared.test.ts", { status: "fail", at_step: 2 });
		// The parent already has its own (newer, authoritative) result for the
		// shared file — the roll-up must not overwrite it.
		parent.test_runs.set("shared.test.ts", { status: "pass", at_step: 9 });

		t.rollUpVerificationSignals("child", "parent");
		const runs = t.get("parent")?.test_runs;
		expect(runs?.get("a.test.ts")?.status).toBe("pass");
		expect(runs?.get("shared.test.ts")?.status).toBe("pass");
	});

	it("gap-fills tdd_cycles without clobbering the parent's own entry", () => {
		const t = new SessionTracker();
		const child = t.recordEvent(evt("child"));
		const parent = t.recordEvent(evt("parent"));
		child.tdd_cycles.set("only-child.ts", {
			source_file: "only-child.ts",
			test_file: "only-child.test.ts",
			state: "green",
			impl_edits_before_test: 0,
		});
		child.tdd_cycles.set("shared.ts", {
			source_file: "shared.ts",
			test_file: "shared.test.ts",
			state: "red",
			impl_edits_before_test: 1,
		});
		parent.tdd_cycles.set("shared.ts", {
			source_file: "shared.ts",
			test_file: "shared.test.ts",
			state: "green",
			impl_edits_before_test: 2,
		});

		t.rollUpVerificationSignals("child", "parent");
		expect(parent.tdd_cycles.get("only-child.ts")?.state).toBe("green");
		// The parent's own (newer) cycle for the shared file must survive.
		expect(parent.tdd_cycles.get("shared.ts")?.state).toBe("green");
		expect(parent.tdd_cycles.get("shared.ts")?.impl_edits_before_test).toBe(2);
	});

	it("lazily allocates parent.observed_checks and merges the child's entries", () => {
		const t = new SessionTracker();
		const child = t.recordEvent(evt("child"));
		const parent = t.recordEvent(evt("parent"));
		expect(parent.observed_checks?.size ?? 0).toBe(0);
		child.observed_checks = new Map([["typecheck", { kind: "typecheck", status: "red" }]]);

		expect(t.rollUpVerificationSignals("child", "parent")).toBe(true);
		expect(parent.observed_checks).toBeInstanceOf(Map);
		expect(parent.observed_checks?.get("typecheck")).toEqual({ kind: "typecheck", status: "red" });
	});

	it("gap-fills observed_checks into an EXISTING parent map without clobbering its entry", () => {
		const t = new SessionTracker();
		const child = t.recordEvent(evt("child"));
		const parent = t.recordEvent(evt("parent"));
		parent.observed_checks = new Map([["lint", { kind: "lint", status: "green" }]]);
		child.observed_checks = new Map([
			["lint", { kind: "lint", status: "red" }], // stale — must not overwrite
			["build", { kind: "build", status: "red" }], // new — must be added
		]);

		t.rollUpVerificationSignals("child", "parent");
		expect(parent.observed_checks.get("lint")).toEqual({ kind: "lint", status: "green" });
		expect(parent.observed_checks.get("build")).toEqual({ kind: "build", status: "red" });
	});

	it("leaves parent.observed_checks untouched when the child recorded none", () => {
		const t = new SessionTracker();
		t.recordEvent(evt("child"));
		const parent = t.recordEvent(evt("parent"));
		parent.observed_checks = new Map([["lint", { kind: "lint", status: "green" }]]);
		// child.observed_checks is left at its fresh-session default: a defined
		// but EMPTY Map (size 0) — distinct from undefined.

		t.rollUpVerificationSignals("child", "parent");
		expect(parent.observed_checks.size).toBe(1);
		expect(parent.observed_checks.get("lint")).toEqual({ kind: "lint", status: "green" });
	});

	it("merges stubs_introduced from the child", () => {
		const t = new SessionTracker();
		const child = t.recordEvent(evt("child"));
		t.recordEvent(evt("parent"));
		child.stubs_introduced = [{ file: "x.ts", kind: "TODO", snippet: "// TODO" }];

		t.rollUpVerificationSignals("child", "parent");
		expect(t.get("parent")?.stubs_introduced).toHaveLength(1);
	});

	it("returns false when from and to are the same session", () => {
		const t = new SessionTracker();
		t.recordEvent(evt("solo"));
		expect(t.rollUpVerificationSignals("solo", "solo")).toBe(false);
	});

	it("returns false when either session is missing", () => {
		const t = new SessionTracker();
		t.recordEvent(evt("only"));
		expect(t.rollUpVerificationSignals("only", "ghost")).toBe(false);
		expect(t.rollUpVerificationSignals("ghost", "only")).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────
// Sequence-detector input population.
//
// `recent_line_edits` and `literal_occurrences` were added as fields on
// SessionTrajectory for the §3.21 add-then-revert and §3.18 magic-literal
// cross-file detectors. These tests pin the recordEvent population so the
// detectors don't silently no-op in production.
// ─────────────────────────────────────────────────────────────────────────

/** Build a PostToolUse Edit event with the given content. Defaults to a
 *  successful outcome (`tool_outcome === undefined` is treated as success
 *  by the writeSucceeded predicate). */
function editEvt(opts: {
	sessionId?: string;
	tool?: string;
	filePath?: string;
	newString?: string;
	content?: string;
	edits?: ReadonlyArray<{ new_string: string }>;
	tool_outcome?: "success" | "error" | "interrupted";
}): HarnessEvent {
	const ev: HarnessEvent = {
		hook_event: "PostToolUse",
		session_id: opts.sessionId ?? "s",
		agent_source: "claude",
		timestamp: "2026-05-27T00:00:00.000Z",
		tool_name: opts.tool ?? "Edit",
		tool_input: {
			file_path: opts.filePath ?? "src/foo.ts",
		},
	};
	if (opts.newString !== undefined && ev.tool_input) ev.tool_input.new_string = opts.newString;
	if (opts.content !== undefined && ev.tool_input) ev.tool_input.content = opts.content;
	if (opts.edits !== undefined && ev.tool_input) ev.tool_input.edits = [...opts.edits];
	if (opts.tool_outcome !== undefined) ev.tool_outcome = opts.tool_outcome;
	return ev;
}

describe("SessionTracker.recordEvent — recent_line_edits population", () => {
	it("creates one ring-buffer entry after one successful Edit", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: "const x = 1;" }),
		);
		const entries = session.recent_line_edits?.get("src/a.ts");
		expect(entries?.length).toBe(1);
		expect(entries?.[0]?.content_hash).toBe(sha256("const x = 1;"));
	});

	it("appends a second entry on a second Edit to the same file", () => {
		const t = new SessionTracker();
		t.recordEvent(editEvt({ filePath: "src/a.ts", newString: "first" }));
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: "second" }),
		);
		const entries = session.recent_line_edits?.get("src/a.ts");
		expect(entries?.length).toBe(2);
		expect(entries?.[1]?.content_hash).toBe(sha256("second"));
	});

	it("emits identical content_hash on identical re-edits (so detectors can match)", () => {
		const t = new SessionTracker();
		t.recordEvent(editEvt({ filePath: "src/a.ts", newString: "same" }));
		t.recordEvent(editEvt({ filePath: "src/a.ts", newString: "other" }));
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: "same" }),
		);
		const entries = session.recent_line_edits?.get("src/a.ts");
		expect(entries?.[0]?.content_hash).toBe(entries?.[2]?.content_hash);
	});

	it("caps the ring buffer at 20 entries per file (drops oldest)", () => {
		const t = new SessionTracker();
		let session = t.recordEvent(editEvt({ filePath: "src/a.ts", newString: "x0" }));
		for (let i = 1; i < 25; i++) {
			session = t.recordEvent(editEvt({ filePath: "src/a.ts", newString: `x${i}` }));
		}
		const entries = session.recent_line_edits?.get("src/a.ts");
		expect(entries?.length).toBe(20);
		// First entry should now be x5 (we wrote x0..x24, kept last 20 → x5..x24).
		expect(entries?.[0]?.content_hash).toBe(sha256("x5"));
		expect(entries?.[19]?.content_hash).toBe(sha256("x24"));
	});

	it("does not record an entry when tool_outcome === 'error'", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({
				filePath: "src/a.ts",
				newString: "won't land",
				tool_outcome: "error",
			}),
		);
		expect(session.recent_line_edits?.get("src/a.ts")).toBeUndefined();
	});

	it("does not record an entry when tool_outcome === 'interrupted'", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({
				filePath: "src/a.ts",
				newString: "halted",
				tool_outcome: "interrupted",
			}),
		);
		expect(session.recent_line_edits?.get("src/a.ts")).toBeUndefined();
	});

	it("records each MultiEdit edit as a separate ring-buffer entry", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({
				tool: "MultiEdit",
				filePath: "src/a.ts",
				edits: [{ new_string: "a" }, { new_string: "b" }, { new_string: "c" }],
			}),
		);
		const entries = session.recent_line_edits?.get("src/a.ts");
		expect(entries?.length).toBe(3);
	});

	it("records Write events via their `content` field", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({ tool: "Write", filePath: "src/new.ts", content: "fresh module" }),
		);
		const entries = session.recent_line_edits?.get("src/new.ts");
		expect(entries?.[0]?.content_hash).toBe(sha256("fresh module"));
	});

	it("`range.end` reflects the chunk's line count (spec simplification)", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: "line1\nline2\nline3" }),
		);
		const entry = session.recent_line_edits?.get("src/a.ts")?.[0];
		expect(entry?.range).toEqual({ start: 0, end: 3 });
	});

	// --- FALSE-POSITIVE regression: blocked / intended PreToolUse edits ---
	// The §3.21 add-then-revert detector reasons about content states the file
	// ACTUALLY reached. A PreToolUse Edit event is an intended edit that may be
	// blocked (tsc overlay / reservation / guard) and never land. Recording it
	// counted a phantom prior state and fired "cycled back N times" on clean
	// forward progress. Population is now PostToolUse-only.

	/** Build a PreToolUse Edit event (the proposed edit, before it runs). In
	 *  production `tool_outcome` is undefined here — the tool has not executed. */
	function preEditEvt(opts: {
		sessionId?: string;
		filePath?: string;
		newString?: string;
	}): HarnessEvent {
		return {
			hook_event: "PreToolUse",
			session_id: opts.sessionId ?? "s",
			agent_source: "claude",
			timestamp: "2026-05-27T00:00:00.000Z",
			tool_name: "Edit",
			tool_input: {
				file_path: opts.filePath ?? "src/foo.ts",
				new_string: opts.newString ?? "x",
			},
		};
	}

	it("does NOT record a PreToolUse Edit (intended edit, may be blocked, hasn't landed)", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			preEditEvt({ filePath: "src/a.ts", newString: "const x = 1;" }),
		);
		expect(session.recent_line_edits?.get("src/a.ts")).toBeUndefined();
	});

	it("records a successful edit exactly once (no Pre+Post double-count)", () => {
		const t = new SessionTracker();
		// Real shape of one successful edit: a PreToolUse then a PostToolUse,
		// both carrying the same new_string. Only the Post should be recorded.
		t.recordEvent(preEditEvt({ filePath: "src/a.ts", newString: "const x = 1;" }));
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: "const x = 1;" }),
		);
		expect(session.recent_line_edits?.get("src/a.ts")?.length).toBe(1);
	});

	it("blocked-then-retry produces NO revert history (the observed FP)", () => {
		const t = new SessionTracker();
		// Agent proposes content C (PreToolUse) — blocked by the overlay, so NO
		// PostToolUse success fires. Retries C (PreToolUse) — blocked again.
		// Finally C lands (PostToolUse success). The file only ever held one
		// state, so the history must be a single entry — zero oscillation.
		t.recordEvent(preEditEvt({ filePath: "src/a.ts", newString: "const fixed = compute();" }));
		t.recordEvent(preEditEvt({ filePath: "src/a.ts", newString: "const fixed = compute();" }));
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: "const fixed = compute();" }),
		);
		const entries = session.recent_line_edits?.get("src/a.ts");
		expect(entries?.length).toBe(1);
	});

	it("drops a no-op re-apply of identical content (same hash as last entry)", () => {
		const t = new SessionTracker();
		t.recordEvent(editEvt({ filePath: "src/a.ts", newString: "same body" }));
		// A second successful PostToolUse with the EXACT same content is a no-op
		// re-apply — not a state transition. The ring buffer stays at one entry.
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: "same body" }),
		);
		expect(session.recent_line_edits?.get("src/a.ts")?.length).toBe(1);
	});

	it("STILL records a genuine A→B→A oscillation across successful edits (true positive)", () => {
		const t = new SessionTracker();
		t.recordEvent(editEvt({ filePath: "src/a.ts", newString: "A" }));
		t.recordEvent(editEvt({ filePath: "src/a.ts", newString: "B" }));
		const session = t.recordEvent(editEvt({ filePath: "src/a.ts", newString: "A" }));
		const entries = session.recent_line_edits?.get("src/a.ts");
		expect(entries?.length).toBe(3);
		expect(entries?.[0]?.content_hash).toBe(entries?.[2]?.content_hash);
	});
});

describe("SessionTracker.recordEvent — literal_occurrences population", () => {
	it("introducing the same string literal in two files yields a Set of size 2", () => {
		const t = new SessionTracker();
		t.recordEvent(
			editEvt({
				filePath: "src/a.ts",
				newString: 'const SECRET_KEY_PATH = "/etc/secret-keys/app";',
			}),
		);
		const session = t.recordEvent(
			editEvt({
				filePath: "src/b.ts",
				newString: 'const KEY = "/etc/secret-keys/app";',
			}),
		);
		const hash = sha256("/etc/secret-keys/app");
		expect(session.literal_occurrences?.get(hash)?.size).toBe(2);
		expect(session.literal_occurrences?.get(hash)?.has("src/a.ts")).toBe(true);
		expect(session.literal_occurrences?.get(hash)?.has("src/b.ts")).toBe(true);
	});

	it("includes a non-trivial integer literal (≥3 digits, outside HTTP-status / -1..256)", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: "const PORT_HIGH = 65535;" }),
		);
		const hash = sha256("65535");
		expect(session.literal_occurrences?.get(hash)?.has("src/a.ts")).toBe(true);
	});

	it("ignores numbers in the -1..256 boring range (255, 100 still possible via HTTP)", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: "const MAX = 256;" }),
		);
		const hash = sha256("256");
		expect(session.literal_occurrences?.get(hash)).toBeUndefined();
	});

	it("ignores HTTP status codes (200, 404, 500)", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({
				filePath: "src/a.ts",
				newString: "if (res.status === 200) return; if (res.status === 404) throw;",
			}),
		);
		expect(session.literal_occurrences?.get(sha256("200"))).toBeUndefined();
		expect(session.literal_occurrences?.get(sha256("404"))).toBeUndefined();
	});

	it("does not pollute the map when the chunk contains no qualifying literals", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: "const x = a + b" }),
		);
		// No string literal ≥8 chars, no number ≥3 digits outside boring range.
		expect(session.literal_occurrences?.size ?? 0).toBe(0);
	});

	it("does not record literals when tool_outcome === 'error'", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({
				filePath: "src/a.ts",
				newString: 'const LONG_LITERAL = "this_is_a_long_string";',
				tool_outcome: "error",
			}),
		);
		expect(session.literal_occurrences?.size ?? 0).toBe(0);
	});

	it("caps literal extraction per edit at 50 entries", () => {
		const t = new SessionTracker();
		// Build a chunk with 80 unique non-trivial number literals (each
		// 4-digit, outside HTTP-status and boring ranges).
		const parts: string[] = [];
		for (let i = 0; i < 80; i++) parts.push(`const N${i} = ${1000 + i};`);
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: parts.join("\n") }),
		);
		expect(session.literal_occurrences?.size).toBe(50);
	});
});

// The full `extractNonTrivialLiterals` rule-set unit suite moved to
// session-literals.test.ts alongside its new home module. One smoke assertion
// stays here to pin that the session-state.js barrel still re-exports it for
// back-compat (many consumers import it from this module).
describe("extractNonTrivialLiterals — re-export from session-state barrel", () => {
	it("is re-exported and applies the documented rule set", () => {
		expect(extractNonTrivialLiterals('const x = "abcdefghij";')).toContain("abcdefghij");
		expect(extractNonTrivialLiterals("status === 200")).not.toContain("200");
	});
});

// ─────────────────────────────────────────────────────────────────────────
// The per-edit mutation gate scopes a file's test run to its EXACT-STEM
// companion (`session-state.test.ts` / `__tests__/session-state.test.ts`
// only) — session-state.ts also has dedicated roundtrip / provenance /
// outcome / event-ordinal suites that the gate's scoping never sees. These
// blocks duplicate the load-bearing assertions from those suites so this
// file alone gives the mutation gate honest signal for the whole module.
// ─────────────────────────────────────────────────────────────────────────

describe("SessionTracker.nextSeq / remove", () => {
	it("mints a monotonically increasing per-session ordinal starting at 1", () => {
		const t = new SessionTracker();
		expect(t.nextSeq("s")).toBe(1);
		expect(t.nextSeq("s")).toBe(2);
		expect(t.nextSeq("s")).toBe(3);
	});

	it("tracks independent ordinals per session_id", () => {
		const t = new SessionTracker();
		expect(t.nextSeq("a")).toBe(1);
		expect(t.nextSeq("b")).toBe(1);
		expect(t.nextSeq("a")).toBe(2);
	});

	it("remove() deletes both the session and its seq counter, restarting from 1", () => {
		const t = new SessionTracker();
		t.recordEvent(evt("gone"));
		t.nextSeq("gone");
		t.nextSeq("gone");
		t.remove("gone");
		expect(t.get("gone")).toBeUndefined();
		expect(t.nextSeq("gone")).toBe(1);
	});
});

describe("isFileTrackedAsWritten — process.cwd() fallback (no third argument)", () => {
	it("resolves against the real process.cwd() when cwd is omitted", () => {
		const t = new SessionTracker();
		t.recordEvent(
			editEvt({
				sessionId: "cwd-fallback",
				filePath: "sub/dir/foo.ts",
			}),
		);
		const session = t.get("cwd-fallback");
		// editEvt() sets no `cwd`, so trackFileOperations resolved against the
		// REAL process.cwd() too — both sides of the fallback must agree.
		const abs = resolvePath(process.cwd(), "sub/dir/foo.ts");
		expect(session?.files_written.has(abs)).toBe(true);
		expect(isFileTrackedAsWritten(session!, "sub/dir/../dir/foo.ts")).toBe(true);
		expect(isFileTrackedAsWritten(session!, "completely/unrelated.ts")).toBe(false);
	});

	it("matches on the RAW form even when queried with an unrelated cwd (short-circuit)", () => {
		// The write was recorded under one cwd (nested workspace); a caller
		// later checks with a COMPLETELY DIFFERENT cwd. Since the raw form is
		// stored cwd-agnostic, the raw-form check on line 1 must find it
		// WITHOUT ever falling through to the cwd-based resolution — if that
		// short-circuit were disabled, resolving "foo.ts" against the wrong
		// cwd would produce a path that was never recorded, and this would
		// incorrectly return false.
		const t = new SessionTracker();
		t.recordEvent(
			editEvt({ sessionId: "raw-shortcircuit", filePath: "foo.ts", tool_outcome: "success" }),
		);
		const session = t.get("raw-shortcircuit");
		expect(isFileTrackedAsWritten(session!, "foo.ts", "/some/totally/different/cwd")).toBe(true);
	});
});

describe("SessionTracker.serialize/hydrate — edge branches", () => {
	it("returns null when serializing an unknown session id", () => {
		const t = new SessionTracker();
		expect(t.serialize("does-not-exist")).toBeNull();
	});

	it("hydrates a malformed (non-null, non-number) step_limit to Infinity", () => {
		const t = new SessionTracker();
		const restored = t.hydrate({ session_id: "weird-step-limit", step_limit: "unlimited" });
		expect(restored?.step_limit).toBe(Number.POSITIVE_INFINITY);
	});

	it("serializes real active_skills entries, then falls back to {} once hydrate leaves it unset", () => {
		const writer = new SessionTracker();
		const session = writer.recordEvent(evt("skills-session"));
		recordSkillEnter(session, { name: "interlinked-verify", ttl_seconds: 600 });

		const snap = writer.serialize("skills-session");
		const activeSkills = snap?.active_skills as Record<string, { name: string }>;
		expect(activeSkills["interlinked-verify"]?.name).toBe("interlinked-verify");

		const reader = new SessionTracker();
		const bare = reader.hydrate({ session_id: "no-skills" });
		expect(bare?.active_skills).toBeUndefined();
		expect(reader.serialize("no-skills")?.active_skills).toEqual({});
	});

	it("serializes git_session_baseline as null once hydrate leaves it unset", () => {
		const reader = new SessionTracker();
		const restored = reader.hydrate({ session_id: "no-git-baseline" });
		expect(restored?.git_session_baseline).toBeUndefined();
		expect(reader.serialize("no-git-baseline")?.git_session_baseline).toBeNull();
	});

	it("serializes real content for failed_files, warnings_issued, tdd_cycles, test_runs, stubs_introduced", () => {
		const writer = new SessionTracker();
		const session = writer.recordEvent(evt("content-session"));
		session.failed_files.set("src/broken.ts", {
			failure_count: 2,
			checks: ["typescript"],
			recorded_at: "2026-05-05T10:00:00Z",
			tool_call_count: 1,
		});
		session.warnings_issued.set("src/broken.ts::typescript", {
			check_name: "typescript",
			issue_count: 2,
			first_issued_at: 1,
			last_issued_at: 2,
			resolved: false,
		});
		session.tdd_cycles.set("src/foo.ts", {
			source_file: "src/foo.ts",
			test_file: "src/foo.test.ts",
			state: "red",
			impl_edits_before_test: 0,
		});
		session.test_runs.set("src/foo.test.ts", { status: "fail", at_step: 3 });
		session.stubs_introduced = [{ file: "src/foo.ts", kind: "TODO", snippet: "// TODO: fix" }];

		const snap = writer.serialize("content-session");

		const failedFiles = snap?.failed_files as Record<string, { failure_count: number }>;
		expect(failedFiles["src/broken.ts"]?.failure_count).toBe(2);

		const warningsIssued = snap?.warnings_issued as Record<string, { issue_count: number }>;
		expect(warningsIssued["src/broken.ts::typescript"]?.issue_count).toBe(2);

		const tddCycles = snap?.tdd_cycles as Record<string, { state: string }>;
		expect(tddCycles["src/foo.ts"]?.state).toBe("red");

		const testRuns = snap?.test_runs as Record<string, { status: string }>;
		expect(testRuns["src/foo.test.ts"]?.status).toBe("fail");

		const stubsIntroduced = snap?.stubs_introduced as Array<{ kind: string }>;
		expect(stubsIntroduced).toHaveLength(1);
		expect(stubsIntroduced[0]?.kind).toBe("TODO");

		const reader = new SessionTracker();
		const restored = reader.hydrate(snap as Record<string, unknown>);
		expect(restored?.failed_files.get("src/broken.ts")?.failure_count).toBe(2);
		expect(restored?.tdd_cycles.get("src/foo.ts")?.state).toBe("red");
		expect(restored?.test_runs.get("src/foo.test.ts")?.status).toBe("fail");
		expect(restored?.stubs_introduced).toHaveLength(1);
	});
});

describe("SessionTracker.hydrate — schema/session_id guards", () => {
	it("refuses a snapshot from a newer schema version", () => {
		const t = new SessionTracker();
		const restored = t.hydrate({ schema_version: 999, session_id: "future", tool_call_count: 5 });
		expect(restored).toBeNull();
		expect(t.get("future")).toBeUndefined();
	});

	it("returns null when session_id is missing", () => {
		const t = new SessionTracker();
		expect(t.hydrate({ tool_call_count: 5 })).toBeNull();
	});
});

describe("SessionTracker.hydrate — step_limit precise cases", () => {
	it("preserves a valid finite step_limit unchanged (25, not Infinity)", () => {
		const t = new SessionTracker();
		const restored = t.hydrate({ session_id: "finite-step", step_limit: 25 });
		expect(restored?.step_limit).toBe(25);
	});

	it("falls back to Infinity for NaN (a 'number' typeof, but not finite)", () => {
		const t = new SessionTracker();
		const restored = t.hydrate({ session_id: "nan-step", step_limit: Number.NaN });
		expect(restored?.step_limit).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("SessionTracker.hydrate — agent_name / started_at fallback", () => {
	it("adopts the snapshot's agent_name and started_at verbatim when present", () => {
		const t = new SessionTracker();
		const restored = t.hydrate({
			session_id: "explicit",
			agent_name: "bob",
			started_at: "2020-01-01T00:00:00.000Z",
		});
		expect(restored?.agent_name).toBe("bob");
		expect(restored?.started_at).toBe("2020-01-01T00:00:00.000Z");
	});

	it("falls back to a truncated session- placeholder and a real timestamp when absent", () => {
		const t = new SessionTracker();
		const restored = t.hydrate({ session_id: "abcdefghijklmnop" });
		// Truncated to the first 8 chars of the session id, not the whole id.
		expect(restored?.agent_name).toBe("session-abcdefgh");
		expect(restored?.started_at.length).toBeGreaterThan(0);
		expect(() => new Date(restored!.started_at).toISOString()).not.toThrow();
	});
});

describe("SessionTracker.serialize — last_seq and duration_s", () => {
	it("serializes last_seq as 0 when nextSeq was never called for this session", () => {
		const writer = new SessionTracker();
		writer.recordEvent(evt("no-seq"));
		expect(writer.serialize("no-seq")?.last_seq).toBe(0);
	});

	it("serializes last_seq reflecting the actual counter after nextSeq calls", () => {
		const writer = new SessionTracker();
		writer.recordEvent(evt("with-seq"));
		writer.nextSeq("with-seq");
		writer.nextSeq("with-seq");
		expect(writer.serialize("with-seq")?.last_seq).toBe(2);
	});

	it("computes duration_s as the real elapsed seconds between started_at and now", () => {
		vi.useFakeTimers();
		try {
			const fixedNow = new Date("2026-06-01T12:00:00.000Z").getTime();
			const startedAt = new Date(fixedNow - 100_000).toISOString(); // 100s before "now"
			vi.setSystemTime(fixedNow);
			const writer = new SessionTracker();
			// `evt()`'s timestamp is a fixed literal unrelated to the fake clock —
			// build the event explicitly so started_at lines up with fixedNow.
			writer.recordEvent({
				hook_event: "PreToolUse",
				session_id: "duration-session",
				agent_source: "claude",
				timestamp: startedAt,
			});
			expect(writer.serialize("duration-session")?.duration_s).toBe(100);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("SessionTracker.serialize — full field-content mapping", () => {
	it("carries real content for every array/object-mapped field, not the empty default", () => {
		const writer = new SessionTracker();
		const session = writer.recordEvent(evt("full-content"));
		session.files_read.add("src/read.ts");
		session.files_written.add("src/written.ts");
		session.suggested_permissions.add("Bash(git *)");
		session.acknowledged_checks.add("src/x.ts::typescript");
		session.fired_reminders.add("bloat-warning");
		session.soft_blocks.add("slow-down");
		session.silent_failure_warned.add("src/y.ts");
		session.bloat_warned.add("src/z.ts");
		session.non_doc_files_edited_since_commit = new Set(["src/a.ts"]);
		session.doc_files_edited_since_commit = 3; // truthy, non-default
		session.mid_session_nudge_emitted = true; // truthy, non-default
		session.stop_nudge_emitted = true; // truthy, non-default
		session.assertion_counts.set("src/foo.test.ts", { blocks: 2, assertions: 4 });
		session.verification_observed = new Set(["test", "lint"]);
		session.observed_checks = new Map([["typecheck", { kind: "typecheck", status: "green" }]]);
		session.pending_completions.set("api.ts", {
			source_file: "api.ts",
			affected_files: ["client.ts"],
			resolved_files: new Set(["client.ts"]),
			recorded_at_tool_call: 1,
			description: "API surface change",
		});

		const snap = writer.serialize("full-content");

		expect(snap?.files_read).toEqual(["src/read.ts"]);
		expect(snap?.files_written).toEqual(["src/written.ts"]);
		expect(snap?.suggested_permissions).toEqual(["Bash(git *)"]);
		expect(snap?.acknowledged_checks).toEqual(["src/x.ts::typescript"]);
		expect(snap?.fired_reminders).toEqual(["bloat-warning"]);
		expect(snap?.soft_blocks).toEqual(["slow-down"]);
		expect(snap?.silent_failure_warned).toEqual(["src/y.ts"]);
		expect(snap?.bloat_warned).toEqual(["src/z.ts"]);
		expect(snap?.non_doc_files_edited_since_commit).toEqual(["src/a.ts"]);
		expect(snap?.doc_files_edited_since_commit).toBe(3);
		expect(snap?.mid_session_nudge_emitted).toBe(true);
		expect(snap?.stop_nudge_emitted).toBe(true);

		const assertionCounts = snap?.assertion_counts as Record<
			string,
			{ blocks: number; assertions: number }
		>;
		expect(assertionCounts["src/foo.test.ts"]).toEqual({ blocks: 2, assertions: 4 });

		expect(snap?.verification_observed).toEqual(["test", "lint"]);

		const observedChecks = snap?.observed_checks as Record<string, { status: string }>;
		expect(observedChecks.typecheck?.status).toBe("green");

		const pendingCompletions = snap?.pending_completions as Record<
			string,
			{ resolved_files: string[]; affected_files: string[] }
		>;
		expect(pendingCompletions["api.ts"]?.affected_files).toEqual(["client.ts"]);
		expect(pendingCompletions["api.ts"]?.resolved_files).toEqual(["client.ts"]);
	});

	it("serializes a full git_session_baseline object, not an empty stand-in", () => {
		const writer = new SessionTracker();
		const session = writer.recordEvent(evt("git-baseline-content"));
		session.git_session_baseline = {
			head_sha: "deadbeef",
			modified: new Set(["src/modified.ts"]),
			staged: new Set(["src/staged.ts"]),
			untracked: new Set(["src/untracked.ts"]),
		};

		const snap = writer.serialize("git-baseline-content");
		const baseline = snap?.git_session_baseline as {
			head_sha: string;
			modified: string[];
			staged: string[];
			untracked: string[];
		};
		expect(baseline.head_sha).toBe("deadbeef");
		expect(baseline.modified).toEqual(["src/modified.ts"]);
		expect(baseline.staged).toEqual(["src/staged.ts"]);
		expect(baseline.untracked).toEqual(["src/untracked.ts"]);
	});
});
