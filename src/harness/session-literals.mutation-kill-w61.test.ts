import { describe, it, expect } from "vitest";
import type { SessionTrajectory } from "./types.js";
import { makeEvent, makeSession as makeCompleteSession } from "./__tests__/fixtures/evaluator.js";
import {
	isSequenceWriteOperation,
	extractWriteChunks,
	recordRecentLineEdit,
	extractNonTrivialLiterals,
} from "./session-literals.js";

function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		...makeCompleteSession(),
		tool_call_count: 1,
		...overrides,
	};
}

describe("isSequenceWriteOperation — positive (must fire)", () => {
	// test-contract: public-api — the exact literal allowlist must return true.
	it("recognizes every literal tool name in the allowlist", () => {
		expect(isSequenceWriteOperation("WriteFile")).toBe(true);
		expect(isSequenceWriteOperation("EditFile")).toBe(true);
		expect(isSequenceWriteOperation("write_file")).toBe(true);
		expect(isSequenceWriteOperation("edit_file")).toBe(true);
		expect(isSequenceWriteOperation("NotebookEdit")).toBe(true);
	});
});

describe("isSequenceWriteOperation — negative (must not fire)", () => {
	// test-contract: boundary — a tool name outside the allowlist must be rejected.
	it("rejects a tool name not on the allowlist", () => {
		expect(isSequenceWriteOperation("SomeOtherTool")).toBe(false);
	});
});

describe("extractWriteChunks — negative (must not fire)", () => {
	// test-contract: boundary — a falsy `edits` entry must be skipped, not dereferenced.
	it("skips a null entry in edits without crashing", () => {
		const event = makeEvent({ tool_input: { edits: [null] } });
		expect(extractWriteChunks(event)).toEqual([]);
	});

	// test-contract: boundary — a non-string new_string must be rejected, not pushed.
	it("skips a non-string new_string on an object edit entry", () => {
		const event = makeEvent({ tool_input: { edits: [{ new_string: 42 }] } });
		expect(extractWriteChunks(event)).toEqual([]);
	});
});

describe("extractWriteChunks — positive (must fire)", () => {
	// test-contract: public-api — a valid MultiEdit new_string must be collected.
	it("collects new_string from a valid object edit entry", () => {
		// SAFETY: minimal MultiEdit-shaped payload for the public-api case.
		const event = makeEvent({ tool_input: { edits: [{ new_string: "hello" }] } });
		expect(extractWriteChunks(event)).toEqual(["hello"]);
	});
});

describe("recordRecentLineEdit — positive (must fire)", () => {
	// test-contract: public-api — a fresh entry must carry the real range object.
	it("stores the full-range object shape for a new file entry", () => {
		const session = makeSession();
		recordRecentLineEdit(session, "a.ts", "one\ntwo\nthree");
		const entries = session.recent_line_edits?.get("a.ts");
		expect(entries).toHaveLength(1);
		expect(entries?.[0]?.range).toEqual({ start: 0, end: 3 });
	});

	// test-contract: public-api — an appended entry must also carry the real range object.
	it("stores the full-range object shape when appending to an existing file", () => {
		const session = makeSession();
		recordRecentLineEdit(session, "a.ts", "one\ntwo");
		recordRecentLineEdit(session, "a.ts", "different content here");
		const entries = session.recent_line_edits?.get("a.ts");
		expect(entries).toHaveLength(2);
		expect(entries?.[1]?.range).toEqual({ start: 0, end: 1 });
	});
});

describe("recordRecentLineEdit — negative (must not fire)", () => {
	// test-contract: invariant — the no-op guard must compare against the LAST entry only.
	it("suppresses a re-apply of the most recently recorded chunk only", () => {
		// The no-op suppression must compare the new chunk against
		// `existing[existing.length - 1]` (the LAST entry), not an
		// arbitrary offset. Re-applying an OLDER entry (not the last)
		// must NOT be suppressed; re-applying the actual last entry MUST
		// be suppressed. If the index used `+1` instead of `-1`, `last`
		// would read undefined (out of bounds) and the guard would never
		// fire, so even a genuine repeat-of-last would wrongly be pushed.
		const session = makeSession();
		recordRecentLineEdit(session, "a.ts", "AAAA");
		recordRecentLineEdit(session, "a.ts", "BBBB");
		recordRecentLineEdit(session, "a.ts", "AAAA");
		expect(session.recent_line_edits?.get("a.ts")).toHaveLength(3);

		recordRecentLineEdit(session, "a.ts", "AAAA");
		expect(session.recent_line_edits?.get("a.ts")).toHaveLength(3);
	});
});

describe("extractNonTrivialLiterals — negative (must not fire)", () => {
	// test-contract: boundary — a value inside the trivial range must be excluded.
	it("excludes a small number inside the trivial range via leading zeros", () => {
		// "050" parses to 50, within -1..256 (trivial) and below 100 (not
		// an HTTP status), so it must be excluded on the trivial-range
		// check alone.
		expect(extractNonTrivialLiterals("code 050 end")).toEqual([]);
	});

	// test-contract: boundary — HTTP_STATUS_HI itself (599) must be excluded.
	it("excludes a number at the very edge of the HTTP status window (599)", () => {
		expect(extractNonTrivialLiterals("status 599 returned")).toEqual([]);
	});
});

describe("extractNonTrivialLiterals — positive (must fire)", () => {
	// test-contract: boundary — one past HTTP_STATUS_HI (600) must be reported.
	it("includes a number just outside the HTTP status window", () => {
		expect(extractNonTrivialLiterals("count 600 items")).toEqual(["600"]);
	});

	// test-contract: public-api — an 8+ char quoted string literal is the happy path.
	it("includes a long-enough string literal", () => {
		expect(extractNonTrivialLiterals('const x = "abcdefgh";')).toEqual(["abcdefgh"]);
	});
});
