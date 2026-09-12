import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import {
	detectBreakGlass,
	logBreakGlass,
	logPath,
	readBreakGlassLog,
	summarizeBreakGlass,
} from "./break-glass.js";

// Fixed instant used for relative-time math in the `summarizeBreakGlass`
// tests below. The `non_deterministic_test` check flags raw `Date.now()` in
// test bodies, so we use a constant. `vi.useFakeTimers` (see the describe
// block below) then makes the SUT's internal `Date.now()` return this same
// instant — so the "window" the SUT computes is consistent with the
// timestamps the tests construct.
const FROZEN_NOW = 1767225600000; // 2026-01-01T00:00:00Z

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-bg-"));
	mkdirSync(join(tmp, ".interlinked"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("detectBreakGlass — matching", () => {
	it.each(["break glass:", "break glass,  ", "break glass:\r\n"])("does not invent a reason from a bare separator: %s", (message) => {
		expect(detectBreakGlass(message)).toEqual({ triggered: true, reason: null });
	});
	it("fires on the literal token", () => {
		const sig = detectBreakGlass("fix: critical bug\n\nbreak glass — prod outage");
		expect(sig.triggered).toBe(true);
		expect(sig.reason).toBe("— prod outage");
	});

	it("is case-insensitive", () => {
		expect(detectBreakGlass("BREAK GLASS: ship now").triggered).toBe(true);
		expect(detectBreakGlass("Break Glass").triggered).toBe(true);
	});

	it("requires a whole-word match", () => {
		expect(detectBreakGlass("the breakglass.com service").triggered).toBe(false);
		expect(detectBreakGlass("unrelated text").triggered).toBe(false);
	});

	it("captures reason after a colon", () => {
		const sig = detectBreakGlass("fix: x\nbreak glass: CI pipeline is down");
		expect(sig.reason).toBe("CI pipeline is down");
	});

	it("captures reason after a comma", () => {
		const sig = detectBreakGlass("fix: x\nbreak glass, CI pipeline is down");
		expect(sig.reason).toBe("CI pipeline is down");
	});

	it("returns null reason when no trailing text", () => {
		const sig = detectBreakGlass("fix all the things\nbreak glass\n\nCo-authored-by: x");
		expect(sig.triggered).toBe(true);
		// The reason extractor returns everything after `break glass` on the
		// same line; an empty tail => null.
		expect(sig.reason).toBeNull();
	});
});

describe("logBreakGlass / readBreakGlassLog", () => {
	it("writes a JSONL entry and reads it back", () => {
		logBreakGlass(tmp, {
			ts: "2026-04-23T00:00:00.000Z",
			user: "alice@x",
			session_id: "s-1",
			tool: "Bash",
			reason: "prod fire",
			commit_sha: null,
		});
		const path = logPath(tmp);
		const text = readFileSync(path, "utf-8");
		expect(text.split("\n").filter(Boolean).length).toBe(1);
		const entries = readBreakGlassLog(tmp);
		expect(entries.length).toBe(1);
		expect(nonNull(entries[0]).user).toBe("alice@x");
	});

	it("appends multiple entries", () => {
		logBreakGlass(tmp, {
			ts: "2026-04-23T00:00:00.000Z",
			user: "a",
			session_id: "s",
			tool: "Bash",
			reason: null,
			commit_sha: null,
		});
		logBreakGlass(tmp, {
			ts: "2026-04-23T00:00:01.000Z",
			user: "a",
			session_id: "s",
			tool: "Edit",
			reason: null,
			commit_sha: null,
		});
		expect(readBreakGlassLog(tmp).length).toBe(2);
	});

	it("returns empty when log is absent", () => {
		expect(readBreakGlassLog(tmp)).toEqual([]);
	});

	it("returns empty when the log path cannot be read (e.g. a directory)", () => {
		// `existsSync` is true (the path exists) but `readFileSync` throws
		// (EISDIR), exercising the read-failure catch branch distinctly from
		// the "log is absent" case above.
		mkdirSync(logPath(tmp));
		expect(readBreakGlassLog(tmp)).toEqual([]);
	});

	it("skips malformed lines", () => {
		writeFileSync(
			logPath(tmp),
			`${[
				'{"ts":"2026-04-23T00:00:00.000Z","user":"a","session_id":"s","tool":"Bash"}',
				"not json",
				'{"ts":"2026-04-23T00:00:01.000Z","user":"a","session_id":"s","tool":"Edit"}',
			].join("\n")}\n`,
		);
		expect(readBreakGlassLog(tmp).length).toBe(2);
	});
});

describe("summarizeBreakGlass", () => {
	// Freeze the SUT's internal clock so its "recent window" aligns with
	// the FROZEN_NOW-based timestamps constructed in the tests below.
	beforeEach(() => {
		vi.useFakeTimers({ now: new Date(FROZEN_NOW) });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("counts only entries inside the window", () => {
		const old = new Date(FROZEN_NOW - 30 * 24 * 60 * 60 * 1000).toISOString();
		const recent = new Date(FROZEN_NOW - 60 * 1000).toISOString();
		logBreakGlass(tmp, {
			ts: old,
			user: "a",
			session_id: "s",
			tool: "x",
			reason: null,
			commit_sha: null,
		});
		logBreakGlass(tmp, {
			ts: recent,
			user: "a",
			session_id: "s",
			tool: "x",
			reason: null,
			commit_sha: null,
		});
		const stats = summarizeBreakGlass(tmp);
		expect(stats.recent_count).toBe(1);
	});

	it("returns zero counts when log is absent", () => {
		const stats = summarizeBreakGlass(tmp);
		expect(stats.recent_count).toBe(0);
		expect(stats.since).toBeNull();
	});

	it("counts distinct days", () => {
		const d1 = new Date(FROZEN_NOW - 60 * 60 * 1000).toISOString();
		const d2 = new Date(FROZEN_NOW - 25 * 60 * 60 * 1000).toISOString();
		logBreakGlass(tmp, {
			ts: d1,
			user: "a",
			session_id: "s",
			tool: "x",
			reason: null,
			commit_sha: null,
		});
		logBreakGlass(tmp, {
			ts: d2,
			user: "a",
			session_id: "s",
			tool: "x",
			reason: null,
			commit_sha: null,
		});
		const stats = summarizeBreakGlass(tmp);
		expect(stats.distinct_days).toBe(2);
	});
});
