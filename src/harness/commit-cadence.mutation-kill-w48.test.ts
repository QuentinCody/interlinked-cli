import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatMidSessionBackstop,
	formatStopNudge,
	formatWipCommitsNudge,
	isDocFile,
	isWipCommitSubject,
	readSessionTokens,
} from "./commit-cadence.js";

const tmpDir = mkdtempSync(join(tmpdir(), "commit-cadence-w48-"));

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function writeTranscript(name: string, lines: string[]): string {
	const p = join(tmpDir, name);
	writeFileSync(p, lines.join("\n"), "utf-8");
	return p;
}

describe("isDocFile / matchesGlob — positive (must fire)", () => {
	it("matches via the direct compileGlob(glob).test(target) branch of matchesGlob", () => {
		// "docs/**" matches "docs/plan.md" directly against the full normalized
		// path — no recursive-prefix fallback is needed for this to succeed.
		expect(isDocFile("docs/plan.md", ["docs/**"])).toBe(true);
	});

	it("does not match when the path does not satisfy the glob at all", () => {
		expect(isDocFile("src/other/plan.md", ["docs/**"])).toBe(false);
	});
});

describe("isDocFile — caches compiled glob regexes (positive, must fire)", () => {
	it("reuses a cached RegExp instance across repeated calls rather than recompiling", () => {
		const uniqueGlob = "zz-unique-cache-probe-8842.md";
		const OriginalRegExp = globalThis.RegExp;
		const construct = vi.spyOn(globalThis, "RegExp").mockImplementation(function (pattern: string | RegExp, flags?: string) {
			return new OriginalRegExp(pattern, flags);
		});
		try {
			expect(isDocFile(uniqueGlob, [uniqueGlob])).toBe(true);
			expect(isDocFile(uniqueGlob, [uniqueGlob])).toBe(true);
			expect(isDocFile(uniqueGlob, [uniqueGlob])).toBe(true);
			expect(construct).toHaveBeenCalledTimes(1);
		} finally {
			construct.mockRestore();
		}
	});
});

describe("readSessionTokens — negative (must not fire / early returns)", () => {
	it("returns null for an undefined transcript path", () => {
		expect(readSessionTokens(undefined)).toBeNull();
	});

	it("returns null for a transcript path that does not exist", () => {
		const missing = join(tmpDir, "does-not-exist.jsonl");
		expect(readSessionTokens(missing)).toBeNull();
	});

	it("does not throw and returns null when a line's usage field is entirely absent", () => {
		const p = writeTranscript(
			"no-usage.jsonl",
			[JSON.stringify({ type: "assistant", message: {} })],
		);
		expect(() => readSessionTokens(p)).not.toThrow();
		expect(readSessionTokens(p)).toBeNull();
	});
});

describe("readSessionTokens — positive (must fire)", () => {
	it("coerces a non-numeric output_tokens to 0 rather than passing it through", () => {
		const p = writeTranscript(
			"bad-output.jsonl",
			[
				JSON.stringify({
					type: "assistant",
					message: { usage: { input_tokens: 10, output_tokens: "bad" } },
				}),
			],
		);
		expect(readSessionTokens(p)).toEqual({ input: 10, output: 0, total: 10 });
	});

	it("sums well-formed usage rows across multiple lines", () => {
		const p = writeTranscript(
			"good.jsonl",
			[
				JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 3, output_tokens: 4 } } }),
				JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 1, output_tokens: 2 } } }),
			],
		);
		expect(readSessionTokens(p)).toEqual({ input: 4, output: 6, total: 10 });
	});
});

describe("formatStopNudge — negative (must not fire)", () => {
	it("returns null when the count is at or below the threshold", () => {
		expect(
			formatStopNudge({
				uncommittedNonDocCount: 2,
				docFilesExcluded: 0,
				threshold: 2,
				tokenBandLow: 1000,
				tokenBandHigh: 5000,
			}),
		).toBeNull();
	});
});

describe("formatStopNudge — positive (must fire)", () => {
	it("includes the correct doc-file plural suffix for exactly 1 excluded file", () => {
		const msg = formatStopNudge({
			uncommittedNonDocCount: 5,
			docFilesExcluded: 1,
			threshold: 1,
			tokenBandLow: 1000,
			tokenBandHigh: 5000,
		});
		expect(msg).not.toBeNull();
		expect(msg).toContain("(1 doc/plan file excluded)");
		expect(msg).not.toContain("files excluded");
	});

	it("picks the medium band (not high) exactly at the high-band boundary", () => {
		const msg = formatStopNudge({
			uncommittedNonDocCount: 3,
			docFilesExcluded: 0,
			threshold: 1,
			cumulativeTokens: 5000,
			tokenBandLow: 1000,
			tokenBandHigh: 5000,
		});
		expect(msg).not.toBeNull();
		expect(msg).toContain("long session");
		expect(msg).not.toContain("very long session");
		expect(msg).toContain("5k");
		expect(msg).toContain(
			"[interlinked:commit-cadence] Stopping with 3 uncommitted code-file edit(s), long session (~5k tokens).",
		);
	});

	it("picks the high band once cumulativeTokens strictly exceeds tokenBandHigh", () => {
		const msg = formatStopNudge({
			uncommittedNonDocCount: 7,
			docFilesExcluded: 0,
			threshold: 2,
			cumulativeTokens: 6000,
			tokenBandLow: 1000,
			tokenBandHigh: 5000,
		});
		expect(msg).not.toBeNull();
		expect(msg).toMatch(/^\[interlinked:commit-cadence\] Stopping with 7 uncommitted code-file edit\(s\), /);
		expect(msg).toContain("very long session (~6k tokens)");
	});
});

describe("formatMidSessionBackstop — negative (must not fire)", () => {
	it("returns null exactly at the threshold boundary (inclusive)", () => {
		expect(formatMidSessionBackstop({ uncommittedNonDocCount: 5, threshold: 5 })).toBeNull();
	});
});

describe("formatMidSessionBackstop — positive (must fire)", () => {
	it("includes the exact prefix and body text once over threshold", () => {
		const msg = formatMidSessionBackstop({ uncommittedNonDocCount: 9, threshold: 5 });
		expect(msg).not.toBeNull();
		expect(msg).toContain(
			"[interlinked:commit-cadence] 9 distinct code file(s) edited since last commit — ",
		);
		expect(msg).toContain(
			"Commit incrementally now: group by concern, one commit per concern. Don't push.",
		);
	});
});

describe("isWipCommitSubject — positive (must fire)", () => {
	it("flags a subject that begins with a wip-style keyword", () => {
		expect(isWipCommitSubject("wip: still working on this")).toBe(true);
	});
});

describe("isWipCommitSubject — negative (must not fire)", () => {
	it("does not flag a subject that merely mentions wip mid-sentence (anchored)", () => {
		expect(isWipCommitSubject("fix wip detection")).toBe(false);
	});
});

describe("formatWipCommitsNudge — negative (must not fire)", () => {
	it("returns null for an empty wip-subjects list", () => {
		expect(formatWipCommitsNudge({ wipSubjects: [] })).toBeNull();
	});
});

describe("formatWipCommitsNudge — positive (must fire)", () => {
	it("truncates the shown list to maxShown and appends the ellipsis marker", () => {
		const msg = formatWipCommitsNudge({
			wipSubjects: ["a", "b", "c", "d", "e"],
			maxShown: 3,
		});
		expect(msg).not.toBeNull();
		expect(msg).toContain('("a", "b", "c", ...)');
		expect(msg).not.toContain('"d"');
		expect(msg).not.toContain('"e"');
	});

	it("defaults maxShown to 3 when not provided, still truncating a longer list", () => {
		const msg = formatWipCommitsNudge({
			wipSubjects: ["a", "b", "c", "d", "e"],
		});
		expect(msg).not.toBeNull();
		expect(msg).toContain('("a", "b", "c", ...)');
		expect(msg).not.toContain('"d"');
	});

	it("includes the exact prefix and trailing don't-push text", () => {
		const msg = formatWipCommitsNudge({ wipSubjects: ["wip: x"], maxShown: 3 });
		expect(msg).not.toBeNull();
		expect(msg).toContain("[interlinked:commit-cadence] This session created 1 WIP-style ");
		expect(msg).toContain("Don't push — leave that to the user.");
	});
});
