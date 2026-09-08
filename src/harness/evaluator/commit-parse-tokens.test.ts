import { describe, expect, it } from "vitest";
import {
	COMMIT_VALUE_FLAGS,
	clusterBooleanLetters,
	combineCwd,
	isAllFlag,
	isIncludeFlag,
	literalDir,
	parseCdTarget,
	shellSplit,
	shortClusterTakesValue,
	splitSegments,
	stripLeadingPrefix,
} from "./commit-parse-tokens.js";

// ===========================================
// shellSplit — backslash escape (branch: c === "\\" && i+1<len && !inSingle)
// ===========================================

describe("shellSplit", () => {
	it("keeps a backslash-escaped space glued to the preceding token", () => {
		expect(shellSplit("a\\ b c")).toEqual(["a b", "c"]);
	});

	it("does not treat a backslash as an escape inside single quotes", () => {
		// Inside single quotes, backslash is literal — the escape branch is
		// gated on `!inSingle`.
		expect(shellSplit("'a\\ b' c")).toEqual(["a\\ b", "c"]);
	});

	it("splits unescaped whitespace normally (no backslash at all)", () => {
		expect(shellSplit("a b  c")).toEqual(["a", "b", "c"]);
	});

	it("keeps the escaped character, rather than the character before the backslash", () => {
		expect(shellSplit("ab\\ c")).toEqual(["ab c"]);
	});

	it("keeps a trailing backslash as a literal character", () => {
		expect(shellSplit("trailing\\")).toEqual(["trailing\\"]);
	});
});

// ===========================================
// splitSegments / consumeQuoteOrEscape — backslash escape branch
// ===========================================

describe("splitSegments", () => {
	it("keeps a backslash-escaped semicolon inside one segment (escape branch)", () => {
		// `\;` must not be read as a top-level separator.
		const segs = splitSegments("echo a\\;b");
		expect(segs).toEqual(["echo a\\;b"]);
	});

	it("splits on unescaped separators (no escape involved)", () => {
		expect(splitSegments("git status; git commit -m x")).toEqual([
			"git status",
			" git commit -m x",
		]);
	});

	it("splits on && and || compound separators", () => {
		expect(splitSegments("cd x && git commit -m y")).toEqual(["cd x ", " git commit -m y"]);
		expect(splitSegments("git add . || git commit -m y")).toEqual([
			"git add . ",
			" git commit -m y",
		]);
	});

	it("treats a quoted separator as literal, not a boundary", () => {
		expect(splitSegments('git commit -m "a; b"')).toEqual(['git commit -m "a; b"']);
	});

	it("skips an empty segment produced by a double separator", () => {
		// pushSegment's `cur.length > 0` guard drops the empty segment between
		// the two consecutive `;`s instead of emitting "".
		expect(splitSegments("git status;;git commit -m x")).toEqual([
			"git status",
			"git commit -m x",
		]);
	});

	it("splits single ampersand and pipe separators without dropping the next token", () => {
		expect(splitSegments("left&right|final")).toEqual(["left", "right", "final"]);
	});

	it("keeps a trailing backslash literal when scanning a segment", () => {
		expect(splitSegments("echo trailing\\")).toEqual(["echo trailing\\"]);
	});
});

// ===========================================
// stripLeadingPrefix — sudo/env/VAR= handling (already-tested elsewhere via
// commit-parse.test.ts; direct unit coverage here for the leaf module).
// ===========================================

describe("stripLeadingPrefix", () => {
	it("drops a sudo prefix", () => {
		expect(stripLeadingPrefix(["sudo", "git", "commit"])).toEqual(["git", "commit"]);
	});

	it("drops env and its VAR= assignments", () => {
		expect(stripLeadingPrefix(["env", "FOO=1", "BAR=2", "git", "commit"])).toEqual([
			"git",
			"commit",
		]);
	});

	it("drops a bare leading VAR= assignment", () => {
		expect(stripLeadingPrefix(["FOO=1", "git", "commit"])).toEqual(["git", "commit"]);
	});

	it("stops at the first non-prefix token", () => {
		expect(stripLeadingPrefix(["git", "commit"])).toEqual(["git", "commit"]);
	});

	it.each(["command", "nohup", "time"])("drops a %s prefix", (prefix) => {
		const tokens = [prefix, "git", "commit"];
		expect(stripLeadingPrefix(tokens)).toEqual(["git", "commit"]);
		expect(tokens).toEqual([prefix, "git", "commit"]);
	});

	it("does not consume a malformed assignment as an env prefix", () => {
		expect(stripLeadingPrefix(["env", "GOOD=1", "1BAD=2", "git", "commit"])).toEqual([
			"1BAD=2",
			"git",
			"commit",
		]);
	});

	it("does not mutate the input token array while removing prefixes", () => {
		const tokens = ["FOO=1", "git", "commit"];
		expect(stripLeadingPrefix(tokens)).toEqual(["git", "commit"]);
		expect(tokens).toEqual(["FOO=1", "git", "commit"]);
	});
});

// ===========================================
// combineCwd / literalDir / parseCdTarget
// ===========================================

describe("combineCwd", () => {
	it("returns base unchanged when next is null", () => {
		expect(combineCwd("/a/b", null)).toBe("/a/b");
	});

	it("an absolute next replaces base", () => {
		expect(combineCwd("/a/b", "/c/d")).toBe("/c/d");
	});

	it("a Windows-drive absolute next replaces base", () => {
		expect(combineCwd("/a/b", "C:\\foo")).toBe("C:\\foo");
	});

	it("joins a relative next onto base", () => {
		expect(combineCwd("/a/b", "../c")).toBe("/a/c");
	});

	it("uses next as-is when base is null", () => {
		expect(combineCwd(null, "sub")).toBe("sub");
	});
});

describe("literalDir", () => {
	it("rejects a dir containing a shell metachar", () => {
		expect(literalDir("$HOME")).toBeNull();
		expect(literalDir("*.ts")).toBeNull();
		expect(literalDir("a?b")).toBeNull();
	});

	it("keeps a plain literal dir", () => {
		expect(literalDir("src/sub")).toBe("src/sub");
	});
});

describe("parseCdTarget", () => {
	it("returns null for cd with no argument", () => {
		expect(parseCdTarget("cd")).toBeNull();
	});

	it("returns null for cd -", () => {
		expect(parseCdTarget("cd -")).toBeNull();
	});

	it("returns null for cd ~", () => {
		expect(parseCdTarget("cd ~/proj")).toBeNull();
	});

	it("returns null for a cd option followed by a non-literal home path", () => {
		expect(parseCdTarget("cd -P ~/proj")).toBeNull();
	});

	it("returns the literal target for a plain cd", () => {
		expect(parseCdTarget("cd sub/dir")).toBe("sub/dir");
	});

	it("returns null for a non-cd segment", () => {
		expect(parseCdTarget("git status")).toBeNull();
	});
});

// ===========================================
// clusterBooleanLetters / isAllFlag / isIncludeFlag / shortClusterTakesValue
// ===========================================

describe("clusterBooleanLetters", () => {
	it("returns '' for a long flag", () => {
		expect(clusterBooleanLetters("--all")).toBe("");
	});

	it("returns '' for a non-flag token", () => {
		expect(clusterBooleanLetters("file.ts")).toBe("");
	});

	it("stops scanning at a value-taking short letter", () => {
		// -mfix: "m" is value-taking, so no boolean letters are read past it —
		// and "m" itself is excluded (it's not boolean).
		expect(clusterBooleanLetters("-mfix")).toBe("");
	});

	it("stops scanning at an optional-attached letter (-Skey)", () => {
		expect(clusterBooleanLetters("-Skey")).toBe("");
	});

	it("reads boolean letters up to a value-taking one", () => {
		expect(clusterBooleanLetters("-amfix")).toBe("a");
	});

	it("reads all boolean letters when none take a value", () => {
		expect(clusterBooleanLetters("-aq")).toBe("aq");
	});

	it("stops scanning at a non-letter character", () => {
		expect(clusterBooleanLetters("-a1")).toBe("a");
	});

	it("returns no boolean letters for an empty or bare-dash token", () => {
		expect(clusterBooleanLetters("")).toBe("");
		expect(clusterBooleanLetters("-")).toBe("");
	});
});

describe("isAllFlag / isIncludeFlag", () => {
	it("isAllFlag true for --all and a cluster containing a", () => {
		expect(isAllFlag("--all")).toBe(true);
		expect(isAllFlag("-am")).toBe(true);
	});

	it("isAllFlag false otherwise", () => {
		expect(isAllFlag("-m")).toBe(false);
		expect(isAllFlag("--message")).toBe(false);
	});

	it("isIncludeFlag true for --include and a cluster containing i", () => {
		expect(isIncludeFlag("--include")).toBe(true);
		expect(isIncludeFlag("-im")).toBe(true);
	});

	it("isIncludeFlag false for --interactive (long flag, not exact match)", () => {
		expect(isIncludeFlag("--interactive")).toBe(false);
	});

	it("isIncludeFlag false for -mfix (i is an attached value char, not a flag)", () => {
		expect(isIncludeFlag("-mfix")).toBe(false);
	});
});

describe("shortClusterTakesValue", () => {
	it("false for a long flag", () => {
		expect(shortClusterTakesValue("--message")).toBe(false);
	});

	it("false for a non-flag token", () => {
		expect(shortClusterTakesValue("file.ts")).toBe(false);
	});

	it("true when the value-taking letter is the cluster's last character", () => {
		expect(shortClusterTakesValue("-am")).toBe(true);
	});

	it("false when the value-taking letter has an attached suffix", () => {
		expect(shortClusterTakesValue("-amfix")).toBe(false);
	});

	it("false for an optional-attached letter (-S never consumes next token)", () => {
		expect(shortClusterTakesValue("-S")).toBe(false);
		expect(shortClusterTakesValue("-Skey")).toBe(false);
	});

	it("false for a cluster with no value-taking letter", () => {
		expect(shortClusterTakesValue("-aq")).toBe(false);
	});

	it("false when a non-letter character appears before any value-taking letter", () => {
		expect(shortClusterTakesValue("-a1")).toBe(false);
	});

	it("returns false for an empty token and for a long option", () => {
		expect(shortClusterTakesValue("")).toBe(false);
		expect(shortClusterTakesValue("--m")).toBe(false);
	});

	it("recognizes a value-taking letter at the end of a one-flag cluster", () => {
		expect(shortClusterTakesValue("-m")).toBe(true);
	});

	it("does not skip over a non-letter while scanning the cluster", () => {
		expect(shortClusterTakesValue("-a1m")).toBe(false);
	});
});

// ===========================================
// w41 mutation-kill additions
// ===========================================

describe("stripLeadingPrefix — regex boundary cases (w41)", () => {
	// test-contract: invariant — a non-identifier-shaped token (leading digit)
	// must never be consumed as a VAR= assignment, whether checked right after
	// `env` or at the top-level fallback check.
	it("does not strip a digit-led token that only superficially resembles VAR=", () => {
		expect(stripLeadingPrefix(["env", "1BAD=2", "git", "commit"])).toEqual([
			"1BAD=2",
			"git",
			"commit",
		]);
	});

	// test-contract: invariant — the assignment name must be made of WORD
	// characters (letters/digits/underscore), not non-word characters, between
	// the leading letter and `=`.
	it("does not strip a token whose assignment name contains a non-word character", () => {
		expect(stripLeadingPrefix(["env", "F.=1", "git", "commit"])).toEqual([
			"F.=1",
			"git",
			"commit",
		]);
	});
});

describe("combineCwd — Windows-drive match must anchor at the start (w41)", () => {
	// test-contract: invariant — a `C:/`-shaped substring embedded MID-STRING
	// (not at position 0) must not be read as an absolute Windows path; the
	// whole `next` value is a relative segment to be joined onto base.
	it("joins a relative segment even when it contains a mid-string drive-letter pattern", () => {
		expect(combineCwd("/a/b", "fooC:/bar")).toBe("/a/b/fooC:/bar");
	});
});

describe("clusterBooleanLetters — dash-token guard (w41)", () => {
	// test-contract: invariant — a token that starts with `-` and has one
	// boolean letter must report that letter, not "".
	it("reads the boolean letter of a two-character dash cluster", () => {
		expect(clusterBooleanLetters("-a")).toBe("a");
	});
});

describe("shortClusterTakesValue — leading-dash guard (w41)", () => {
	// test-contract: invariant — a token with NO leading dash must never be
	// read as a value-taking cluster, even when its letters coincidentally
	// match a value-taking short flag letter (e.g. "m").
	it("is false for a dash-less token whose letters look like a value-taking cluster", () => {
		expect(shortClusterTakesValue("am")).toBe(false);
		expect(shortClusterTakesValue("mm")).toBe(false);
	});

	// test-contract: invariant — a genuine dash-prefixed cluster ending in a
	// value-taking letter still reports true (regression guard alongside the
	// dash-less case above).
	it("is true for a multi-letter dash-prefixed cluster ending in a value-taking letter", () => {
		expect(shortClusterTakesValue("-qm")).toBe(true);
	});
});

describe("COMMIT_VALUE_FLAGS", () => {
	it("contains every following-token value flag", () => {
		expect([...COMMIT_VALUE_FLAGS]).toEqual([
			"-m",
			"--message",
			"-F",
			"--file",
			"-C",
			"--reuse-message",
			"-c",
			"--reedit-message",
			"--author",
			"--date",
			"-t",
			"--template",
			"--fixup",
			"--squash",
			"--cleanup",
			"--trailer",
		]);
	});
});
