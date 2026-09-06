// Unit tests for the pure parsing primitives in file-dump-guard-parse.ts.
// Targets the specific lines/branches lcov flagged as uncovered: the `||`
// literal handling in splitPipeline, the leading-whitespace skip in
// tokenize, the bare `VAR=val` strip in stripLeadingWrappers, the `--`
// flag/long-flag combined-value branches, the `--` end-of-flags marker in
// extractFilePaths, and both branches of stripPathPrefix/formatBytes.

import { describe, expect, it } from "vitest";
import {
	extractFilePaths,
	formatBytes,
	hasFollowFlag,
	hasOutputRedirect,
	parseCountFlag,
	splitPipeline,
	stripLeadingWrappers,
	stripPathPrefix,
	tokenize,
} from "../file-dump-guard-parse.js";

describe("splitPipeline — positive (must fire)", () => {
	it("P1: splits on a single top-level pipe", () => {
		expect(splitPipeline("echo a | echo b")).toEqual(["echo a ", " echo b"]);
	});

	it("P2: treats `||` as a literal, not a split boundary (lines 65-67)", () => {
		expect(splitPipeline("echo a || echo b")).toEqual(["echo a || echo b"]);
	});
});

describe("splitPipeline — negative (must not fire)", () => {
	it("N1: does not split inside quotes", () => {
		expect(splitPipeline('echo "a | b"')).toEqual(['echo "a | b"']);
	});
});

describe("tokenize — positive (must fire)", () => {
	it("P1: splits on whitespace, dropping empty runs (line 99 both sides)", () => {
		expect(tokenize("  a   b  ")).toEqual(["a", "b"]);
	});

	it("P2: strips quotes from a quoted token", () => {
		expect(tokenize(`echo "hello world"`)).toEqual(["echo", "hello world"]);
	});
});

describe("stripLeadingWrappers — positive (must fire)", () => {
	it("P1: drops a bare VAR=val prefix token (lines 125-126)", () => {
		const tokens = ["FOO=bar", "cmd", "arg"];
		stripLeadingWrappers(tokens);
		expect(tokens).toEqual(["cmd", "arg"]);
	});

	it("P2: drops sudo/env wrapper prefixes", () => {
		const tokens = ["env", "A=1", "B=2", "cmd"];
		stripLeadingWrappers(tokens);
		expect(tokens).toEqual(["cmd"]);
	});

	it("P3: drops a bare sudo/exec/nohup/command wrapper token (lines 116-117)", () => {
		const tokens = ["sudo", "cat", "file.txt"];
		stripLeadingWrappers(tokens);
		expect(tokens).toEqual(["cat", "file.txt"]);
	});
});

describe("stripLeadingWrappers — negative (must not fire)", () => {
	it("N1: leaves tokens untouched when no wrapper/assignment prefix is present", () => {
		const tokens = ["cat", "file.txt"];
		stripLeadingWrappers(tokens);
		expect(tokens).toEqual(["cat", "file.txt"]);
	});
});

describe("hasFollowFlag — positive (must fire)", () => {
	it("P1: detects a standalone -f flag", () => {
		expect(hasFollowFlag(["tail", "-f", "file.log"])).toBe(true);
	});

	it("P2: detects -f combined with other short flags", () => {
		expect(hasFollowFlag(["tail", "-nf", "file.log"])).toBe(true);
	});
});

describe("hasFollowFlag — negative (must not fire)", () => {
	it("N1: a --long flag is skipped, not mistaken for follow (line 138 true side)", () => {
		expect(hasFollowFlag(["tail", "--lines=5", "file.log"])).toBe(false);
	});

	it("N2: stops scanning at the first non-flag token (line 139 break)", () => {
		expect(hasFollowFlag(["tail", "file.log", "-f"])).toBe(false);
	});
});

describe("hasOutputRedirect — positive (must fire)", () => {
	it("P1: detects a plain redirect", () => {
		expect(hasOutputRedirect("cat a.txt > b.txt")).toBe(true);
	});
});

describe("hasOutputRedirect — negative (must not fire)", () => {
	it("N1: does not treat `>=` as a redirect (line 170 true side)", () => {
		expect(hasOutputRedirect("[ $x >= 5 ]")).toBe(false);
	});

	it("N2: does not treat `=>` as a redirect", () => {
		expect(hasOutputRedirect("x=>y")).toBe(false);
	});

	it("N3: no redirect present at all", () => {
		expect(hasOutputRedirect("cat a.txt")).toBe(false);
	});

	it("N4: a `>` inside a quoted string is not a redirect, but one outside it still is (lines 159-164)", () => {
		expect(hasOutputRedirect('echo "a > b" > out.txt')).toBe(true);
		expect(hasOutputRedirect('echo "only a > b inside quotes"')).toBe(false);
	});
});

describe("parseCountFlag — positive (must fire)", () => {
	it("P1: separate-token form `-n 50` (line 194 false side)", () => {
		expect(parseCountFlag(["tail", "-n", "50"], "-n")).toBe(50);
	});

	it("P2: combined short form `-n50` (lines 197-198, tokenMatchesFlag combined true)", () => {
		expect(parseCountFlag(["tail", "-n50", "file.log"], "-n")).toBe(50);
	});

	it("P3: `=`-form `-n=50` (line 196 true side)", () => {
		expect(parseCountFlag(["tail", "-n=50"], "-n")).toBe(50);
	});

	it("P4: long `--lines=50` form", () => {
		expect(parseCountFlag(["tail", "--lines=50"], "-n")).toBe(50);
	});
});

describe("parseCountFlag — negative (must not fire)", () => {
	it("N1: flag present with no following value (line 194 true side, next undefined)", () => {
		expect(parseCountFlag(["tail", "-n"], "-n")).toBeNull();
	});

	it("N2: no matching flag present at all (line 206 false side)", () => {
		expect(parseCountFlag(["tail", "file.log"], "-n")).toBeNull();
	});

	it("N3: `=`-form with a non-numeric value (line 180 false side)", () => {
		expect(parseCountFlag(["tail", "-n=abc"], "-n")).toBeNull();
	});

	it("N4: a bare trailing `+` with no digit never satisfies the combined-flag shape, so the flag is not recognized at all", () => {
		// `-n+` looks combined-shaped, but the single character at the combined
		// offset ("+") can't itself satisfy `/^\+?\d/` (a lone `+` has no digit
		// to its right within that one-character probe) — so tokenMatchesFlag
		// rejects it before flagCountAt is ever called for this token.
		expect(parseCountFlag(["tail", "-n+"], "-n")).toBeNull();
	});
});

describe("extractFilePaths — positive (must fire)", () => {
	it("P1: plain positional file argument", () => {
		expect(extractFilePaths(["cat", "file.txt"], "cat")).toEqual(["file.txt"]);
	});

	it("P2: `--` end-of-flags marker takes every remaining token verbatim (lines 240-242)", () => {
		expect(extractFilePaths(["cat", "--", "-weird", "real.txt"], "cat")).toEqual([
			"-weird",
			"real.txt",
		]);
	});

	it("P3: a value-taking flag (`-n 50`) skips its value token, keeping the trailing file (lines 246-247)", () => {
		expect(extractFilePaths(["tail", "-n", "50", "file.txt"], "tail")).toEqual(["file.txt"]);
	});
});

describe("extractFilePaths — negative (must not fire)", () => {
	it("N1: bails (empty array) on a glob argument", () => {
		expect(extractFilePaths(["cat", "*.txt"], "cat")).toEqual([]);
	});

	it("N2: bails on command substitution", () => {
		expect(extractFilePaths(["cat", "$(whoami).txt"], "cat")).toEqual([]);
	});
});

describe("stripPathPrefix — positive (must fire)", () => {
	it("P1: strips a leading path (line 266 true side)", () => {
		expect(stripPathPrefix("/usr/bin/jq")).toBe("jq");
	});
});

describe("stripPathPrefix — negative (must not fire)", () => {
	it("N1: returns the token unchanged when there is no `/` (line 266 false side)", () => {
		expect(stripPathPrefix("jq")).toBe("jq");
	});
});

describe("formatBytes — positive (must fire)", () => {
	it("P1: sub-1KB renders as bytes (line 270 true side)", () => {
		expect(formatBytes(512)).toBe("512B");
	});

	it("P2: sub-1MB renders as rounded KB (line 271 true side)", () => {
		expect(formatBytes(2048)).toBe("2KB");
	});

	it("P3: 1MB+ renders as MB with one decimal (line 272, both prior branches false)", () => {
		expect(formatBytes(1024 * 1024 * 2.5)).toBe("2.5MB");
	});
});
