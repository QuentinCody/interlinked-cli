import { describe, expect, it } from "vitest";
import { processRipgrepLines, ripgrepStdoutLines } from "./search-ripgrep-json.js";

const DIR = "/repo";

function matchLine(path: string, lineNumber: number, text: string, start?: number): string {
	return JSON.stringify({
		type: "match",
		data: {
			path: { text: path },
			line_number: lineNumber,
			lines: { text },
			...(start === undefined ? {} : { submatches: [{ start }] }),
		},
	});
}

function contextLine(path: string, lineNumber: number, text: string): string {
	return JSON.stringify({
		type: "context",
		data: { path: { text: path }, line_number: lineNumber, lines: { text } },
	});
}

describe("ripgrepStdoutLines", () => {
	it("splits stdout into non-empty lines", () => {
		const buf = Buffer.from("a\nb\n\nc\n", "utf-8");
		expect(ripgrepStdoutLines({ stdout: buf })).toEqual(["a", "b", "c"]);
	});

	it("returns an empty array when the child never spawned (stdout null)", () => {
		expect(ripgrepStdoutLines({ stdout: null })).toEqual([]);
	});
});

describe("processRipgrepLines", () => {
	it("parses a match into a repo-relative SearchMatch", () => {
		const { matches, searchedFiles } = processRipgrepLines(
			[matchLine("/repo/src/a.ts", 12, "hello\n", 3)],
			DIR,
			{ context: 2 },
		);
		expect(searchedFiles).toBe(0);
		expect(matches).toEqual([
			{
				file: "src/a.ts",
				line: 12,
				column: 3,
				text: "hello",
				context_before: undefined,
				context_after: [],
			},
		]);
	});

	it("leaves the column undefined when there are no submatches", () => {
		const { matches } = processRipgrepLines([matchLine("/repo/a.ts", 1, "x")], DIR, { context: 2 });
		expect(matches[0]?.column).toBeUndefined();
	});

	it("attaches trailing context inside the context window", () => {
		const lines = [
			matchLine("/repo/a.ts", 10, "hit\n"),
			contextLine("/repo/a.ts", 11, "after1\n"),
			contextLine("/repo/a.ts", 12, "after2\n"),
		];
		const { matches } = processRipgrepLines(lines, DIR, { context: 2 });
		expect(matches).toHaveLength(1);
		expect(matches[0]?.context_after).toEqual(["after1", "after2"]);
	});

	it("queues context beyond the window as leading context for the next match", () => {
		const lines = [
			matchLine("/repo/a.ts", 10, "hit\n"),
			contextLine("/repo/a.ts", 40, "before\n"),
			matchLine("/repo/a.ts", 41, "hit2\n"),
		];
		const { matches } = processRipgrepLines(lines, DIR, { context: 2 });
		expect(matches[0]?.context_after).toEqual([]);
		expect(matches[1]?.context_before).toEqual(["before"]);
	});

	it("queues context from a different file as leading context", () => {
		const lines = [
			matchLine("/repo/a.ts", 10, "hit\n"),
			contextLine("/repo/b.ts", 11, "other\n"),
			matchLine("/repo/b.ts", 12, "hit2\n"),
		];
		const { matches } = processRipgrepLines(lines, DIR, { context: 2 });
		expect(matches[0]?.context_after).toEqual([]);
		expect(matches[1]?.context_before).toEqual(["other"]);
	});

	it("treats context before any match as leading context", () => {
		const lines = [contextLine("/repo/a.ts", 1, "lead\n"), matchLine("/repo/a.ts", 2, "hit\n")];
		const { matches } = processRipgrepLines(lines, DIR, { context: 2 });
		expect(matches[0]?.context_before).toEqual(["lead"]);
	});

	it("reads the searched-file count from the summary message", () => {
		const summary = JSON.stringify({ type: "summary", data: { stats: { searches: 42 } } });
		const { searchedFiles } = processRipgrepLines([summary], DIR, { context: 2 });
		expect(searchedFiles).toBe(42);
	});

	it("defaults the searched-file count to 0 for a malformed summary", () => {
		const summary = JSON.stringify({ type: "summary", data: { stats: { searches: "lots" } } });
		const { searchedFiles } = processRipgrepLines([summary], DIR, { context: 2 });
		expect(searchedFiles).toBe(0);
	});

	it("skips unparseable and unrecognized lines", () => {
		const lines = [
			"{not json",
			"[]",
			JSON.stringify({ type: "begin", data: { path: { text: "/repo/a.ts" } } }),
			JSON.stringify({ type: "match", data: { path: { text: "/repo/a.ts" } } }),
			JSON.stringify({ type: "context", data: { line_number: 1 } }),
		];
		expect(processRipgrepLines(lines, DIR, { context: 2 })).toEqual({
			matches: [],
			searchedFiles: 0,
		});
	});
});
