import { describe, expect, it } from "vitest";
import { isGitPushCommand, parseGitCommit } from "./commit-parse.js";

// Survivor-kill campaign (fix fleet W7, 2026-08-14) targeting the 62 mutants
// that survived against commit-parse.test.ts alone. Each fixture below was
// shadow-verified (scratch/fleet-r3/commit-parse-shadow-verify.mts,
// scratch/fleet-r3/commit-parse-fuzz.mts) against a real function-scoped
// textual mutant before being promoted here — full-object `toEqual` so a
// divergence in ANY field of the return value fails the test, not just the
// one field a given mutant happens to touch. Receipts:
// scratch/fleet-r3/receipts/src_harness_evaluator_commit-parse.ts.jsonl

describe("commitPathspecs — `--` terminator consumes ALL remaining tokens literally", () => {
	it("everything after `--` becomes a pathspec, including flag-shaped tokens", () => {
		// Kills: 81c34ff6641adf27 (BlockStatement), a2b19f9d44b35a0a
		// (ConditionalExpression t==="--"), b33930efede1bc49 (StringLiteral "--").
		// Without the for+break block, "--" itself and every following token get
		// re-parsed as ordinary flags/positionals instead of being captured whole.
		expect(parseGitCommit("git commit -- --weird-pathspec-looking-thing -m x")).toEqual({
			isCommit: true,
			noVerify: false,
			constructsContent: true,
			constructedPaths: ["--weird-pathspec-looking-thing", "-m", "x"],
			trackedOnlyPaths: ["--weird-pathspec-looking-thing", "-m", "x"],
		});
	});
});

describe("addSegmentPaths — a broad first `add` segment stays sticky across a second, narrow one", () => {
	it("a bare `--` add contributes no path but leaves addBroad correctly false", () => {
		// Kills: 73a0ded703a06be8 (BooleanLiteral, `allish` initial value false->true).
		// Forcing allish to start true makes a path-free `add --` segment look
		// broad even though nothing in it actually requested that.
		expect(parseGitCommit("git add -- && git add other.ts && git commit -m x")).toEqual({
			isCommit: true,
			noVerify: false,
			constructsContent: true,
			constructedPaths: ["other.ts"],
			includesIndex: true,
		});
	});

	it("a bare `-A` add IS broad and stays sticky through a later narrow commit pathspec", () => {
		// Kills: 57fc21e495fef446 (BooleanLiteral, -A block's `allish = true`).
		expect(parseGitCommit("git add -A && git commit src/a.ts -m x")).toEqual({
			isCommit: true,
			noVerify: false,
			constructsContent: true,
			constructedPaths: ["src/a.ts"],
		});
	});

	it("a bare `--all` add IS broad (long-flag spelling, same as -A)", () => {
		// Kills: a896abf91d7d25b2 (ConditionalExpression t==="--all"->false),
		// 9c5275d3e1b89309 (StringLiteral "--all"->"").
		expect(parseGitCommit("git add --all && git add other.ts && git commit -m x")).toEqual({
			isCommit: true,
			noVerify: false,
			constructsContent: true,
			includesIndex: true,
		});
	});

	it("a bare `--update` add IS broad (long-flag spelling, same as -u)", () => {
		// Kills: b8ce8244e1a33299 (ConditionalExpression t==="--update"->false),
		// 8ec53fc5769e1261 (StringLiteral "--update"->"").
		expect(parseGitCommit("git add --update && git add other.ts && git commit -m x")).toEqual({
			isCommit: true,
			noVerify: false,
			constructsContent: true,
			includesIndex: true,
		});
	});

	it("the SEPARATE-value `--pathspec-from-file=` prefix check still recognizes an attached filename beside a real path", () => {
		// Kills: b1d0c4c991a67727 (MethodExpression startsWith->endsWith).
		expect(
			parseGitCommit("git add file1.ts --pathspec-from-file=files.txt && git commit -m x")?.constructedPaths,
		).toBeUndefined();
	});

	it("a `--` separator followed by a flag-shaped literal add path is taken literally, not re-parsed", () => {
		// Kills: 8538cb11372f525e (ConditionalExpression, the whole `||`),
		// 948cea10d1a3574c (LogicalOperator || -> &&), b663aa74df385195
		// (MethodExpression startsWith->endsWith on the generic dash check).
		expect(parseGitCommit("git add -- --weird-file && git commit -m x")).toEqual({
			isCommit: true,
			noVerify: false,
			constructsContent: true,
			includesIndex: true,
		});
	});
});

describe("isGitAddSegment — the length/head guards are load-bearing, not decorative", () => {
	it("a bare 1-token `git` segment is never mistaken for a git-add segment", () => {
		// Kills: 3bbabc50eb58fd3b, e6f2f64ff6f4f25b (both BooleanLiteral
		// false->true return-value forces). A wrong `true` here sets sawGitAdd
		// on a segment that added nothing, spuriously flipping includesIndex.
		expect(parseGitCommit("git; git commit -m x")).toEqual({ isCommit: true, noVerify: false });
	});

	it("a non-git-headed segment (`npm install`) is never mistaken for a git-add segment", () => {
		expect(parseGitCommit("npm install; git commit -m x")).toEqual({ isCommit: true, noVerify: false });
	});

	it("an absolute git-path head (`/opt/bin/git`) IS recognized as a real add segment", () => {
		// Kills: 468cc7dcc9c82352 (BooleanLiteral !endsWith negation),
		// dba2aabfaa8ac53a (MethodExpression endsWith->startsWith).
		expect(parseGitCommit("/opt/bin/git add file.ts && git commit -m x")).toEqual({
			isCommit: true,
			noVerify: false,
			constructsContent: true,
			constructedPaths: ["file.ts"],
			includesIndex: true,
		});
	});

	it("a head merely ENDING in `git` as a substring of a longer binary name is NOT a git add", () => {
		// Kills: 224a719557f9828b (StringLiteral "/git"->""), 05f0a4cf0b22097b
		// (ConditionalExpression, the whole head-mismatch condition forced false).
		expect(parseGitCommit("/opt/bin/gitextra add file.ts && git commit -m x")).toEqual({
			isCommit: true,
			noVerify: false,
		});
	});

	it("`git add` with exactly 2 tokens (no paths at all) IS still a valid add segment", () => {
		// Kills: e81bc2c41c5ea0ee (EqualityOperator tokens.length<2 -> <=2):
		// the off-by-one would wrongly reject this 2-token segment.
		expect(parseGitCommit("git add && git commit -m x")).toEqual({
			isCommit: true,
			noVerify: false,
			constructsContent: true,
			includesIndex: true,
		});
	});
});

describe("scanGitGlobalFlags — trailing/malformed global-flag runs degrade cleanly, never throw", () => {
	it("a `-C` with no following directory token resolves to no cwd override (not a crash)", () => {
		// Kills: 24c2c3085d9cee58 (ConditionalExpression raw!==undefined->true):
		// forcing literalDir(undefined) down the "resolved" path feeds `undefined`
		// into combineCwd -> posix.isAbsolute(undefined), which throws.
		expect(parseGitCommit("git -C && git commit -m x")).toEqual({ isCommit: true, noVerify: false });
	});

	it("an all-global-flags segment with no subcommand at all returns null, not a mid-array read", () => {
		// Kills: 35524373fd7cb7b9 (EqualityOperator i<tokens.length -> i<=tokens.length):
		// the off-by-one drives the scan one slot past the array, reading
		// tokens[tokens.length] (undefined) instead of stopping.
		expect(parseGitCommit("git -c a=b")).toBeNull();
	});
});

describe("applyConstructedContent — fine-grained onlyNamedPaths / cover-matching behavior", () => {
	it("a -u-staged (tracked-only) add path is excluded from the plain-add-under-pathspec merge", () => {
		// Kills: 81f9926c582d56c6 (MethodExpression, drops the updateOnlyPaths filter):
		// without the filter, a -u-staged path wrongly re-enters `specific` via the
		// covers-merge even though it never counts as a "plain" add.
		expect(parseGitCommit("git add -u src/new.ts && git commit src -m x")).toEqual({
			isCommit: true,
			noVerify: false,
			constructsContent: true,
			constructedPaths: ["src"],
			trackedOnlyPaths: ["src"],
		});
	});

	it("a no-pathspec commit after a plain add unions the add's path in (onlyNamedPaths false path)", () => {
		// Kills: eacb9c3fade410c3 (ConditionalExpression, onlyNamedPaths forced
		// true): forcing the only-mode ternary branch drops the add's own path
		// from `specific` even though this commit has no pathspec of its own.
		expect(parseGitCommit("git add . && git commit")).toEqual({
			isCommit: true,
			noVerify: false,
			constructsContent: true,
			constructedPaths: ["."],
			includesIndex: true,
		});
	});

	it("`.some()` (ANY pathspec covers) is not `.every()` (ALL pathspecs must cover)", () => {
		// Kills: 29af818d434539ef (MethodExpression some->every): with two commit
		// pathspecs where only ONE covers the add path, `.every()` would wrongly
		// exclude it from the merge.
		expect(parseGitCommit("git add src/new.ts && git commit other src -m x")).toEqual({
			isCommit: true,
			noVerify: false,
			constructsContent: true,
			constructedPaths: ["other", "src", "src/new.ts"],
			trackedOnlyPaths: ["other", "src"],
		});
	});

	it("a plain add plus a commit `--pathspec-from-file` OR's broad correctly (not AND's it away)", () => {
		// Kills: 9b1c82cc14afbd15 (LogicalOperator || -> &&), bbc69b74da5cfcf2
		// (ConditionalExpression, the whole || forced false).
		expect(parseGitCommit("git add src/a.ts && git commit --pathspec-from-file=f.txt")).toEqual({
			isCommit: true,
			noVerify: false,
			constructsContent: true,
		});
	});

	it("constructedPaths is set only when `specific` is genuinely non-empty", () => {
		// Kills: 4c320ebb2822e075 (ConditionalExpression specific.length>0 ->
		// true), 5c806f8bb9f7fb33 (EqualityOperator > -> >=): both would set
		// constructedPaths off an EMPTY `specific` array for a path-free add.
		expect(parseGitCommit("git add && git commit -m x")).toEqual({
			isCommit: true,
			noVerify: false,
			constructsContent: true,
			includesIndex: true,
		});
	});
});

describe("pathCovers — `.` matches everything; path normalization is exact", () => {
	it("`.` as a commit pathspec covers any add path underneath it", () => {
		// Kills: 4eb5e0036ff828bf (ConditionalExpression na==="."->false),
		// 3a43a1be500d5471 (StringLiteral "."->"").
		expect(parseGitCommit("git add . && git commit src -m x")?.constructedPaths).toEqual(["src"]);
	});

	it("a leading `./` is stripped ONLY when anchored at the start, not anywhere in the string", () => {
		// Kills: 994de1ba3c055280 (Regex /^\.\// -> /\.\// unanchored): the
		// unanchored form would also strip a "./" that appears mid-path,
		// spuriously making an unrelated path equal the normalized pathspec.
		expect(parseGitCommit("git add b/./c && git commit b/c -m x")).toEqual({
			isCommit: true,
			noVerify: false,
			constructsContent: true,
			constructedPaths: ["b/c"],
			trackedOnlyPaths: ["b/c"],
		});
	});

	it("a leading `./` is REMOVED (empty replacement), not replaced with a literal marker", () => {
		// Kills: 9bcb838e3d43bd6b / bd67628547d2ff96 (StringLiteral "" ->
		// "Stryker was here!", both occurrences of norm()'s replacement string):
		// either mutation leaves a residual marker in the normalized form, which
		// breaks the na===nb / startsWith comparisons pathCovers relies on.
		expect(parseGitCommit("git add src/new.ts && git commit ./src -m x")).toEqual({
			isCommit: true,
			noVerify: false,
			constructsContent: true,
			constructedPaths: ["./src", "src/new.ts"],
			trackedOnlyPaths: ["./src"],
		});
	});

	it("a run of trailing slashes is collapsed entirely (`/+$`), not just the last one (`/$`)", () => {
		// Kills: 8eae67e0a22c3652 (Regex /\/+$/ -> /\/$/): a two-slash trailing
		// pathspec would keep one slash, so it no longer normalizes to the same
		// directory as its covered path.
		expect(parseGitCommit("git add src/new.ts && git commit src// -m x")).toEqual({
			isCommit: true,
			noVerify: false,
			constructsContent: true,
			constructedPaths: ["src//", "src/new.ts"],
			trackedOnlyPaths: ["src//"],
		});
	});

	it("a single trailing slash on the pathspec still normalizes and covers its child", () => {
		expect(parseGitCommit("git add src/new.ts && git commit src/ -m x")).toEqual({
			isCommit: true,
			noVerify: false,
			constructsContent: true,
			constructedPaths: ["src/", "src/new.ts"],
			trackedOnlyPaths: ["src/"],
		});
	});
});

describe("trackedOnlySubset — --only vs --include selects the right candidate set", () => {
	it("a --only pathspec commit ignores a -u-staged add path from a DIFFERENT tree (not unioned in)", () => {
		// Kills: 3ff26f23ef3f2e63 (ConditionalExpression, the whole ternary
		// condition forced false): forcing the else-branch wrongly unions in
		// updateOnlyPaths from an unrelated -u add even in --only mode.
		expect(parseGitCommit("git add -u other.ts && git commit src/a.ts -m x")).toEqual({
			isCommit: true,
			noVerify: false,
			constructsContent: true,
			constructedPaths: ["src/a.ts"],
			trackedOnlyPaths: ["src/a.ts"],
		});
	});

	it("--include flips the ternary the OTHER way: the -u-staged path IS unioned in", () => {
		// Kills: dc452b0610ced5bb (BooleanLiteral !seg.include negation removed):
		// without the negation, an --include commit stops unioning in the
		// tracked-only add path it's supposed to include.
		expect(parseGitCommit("git add -u other.ts && git commit --include src/a.ts -m x")).toEqual({
			isCommit: true,
			noVerify: false,
			constructsContent: true,
			constructedPaths: ["src/a.ts", "other.ts"],
			trackedOnlyPaths: ["src/a.ts", "other.ts"],
			includesIndex: true,
		});
	});
});

describe("parseGitCommit / isGitPushCommand — the non-string runtime guard is OR, both clauses load-bearing", () => {
	// A truthy, non-string, array-like value that indexes/iterates identically
	// to its equivalent string in every splitSegments/shellSplit loop (each
	// element IS the single character a real string index would yield) — the
	// parser must reject them before interpreting characters as shell syntax.
	const commitCharArray = Array.from("git commit -m x");
	const pushCharArray = Array.from("git push");

	it("a truthy non-string is rejected even though `!command` alone would not catch it", () => {
		// Kills: 5c51b5fe9e0ef796 (ConditionalExpression typeof-check disabled),
		// d59f0f918470ab93 (ConditionalExpression, whole || forced false),
		// 4d7240f0d938133a (LogicalOperator || -> &&): each lets a truthy
		// array fall through to splitSegments, which then parses it as if it
		// were the equivalent real string and returns a fabricated commit.
		expect(parseGitCommit(commitCharArray)).toBeNull();
	});

	it("isGitPushCommand rejects the same class of truthy non-string input", () => {
		// Kills: 72277fb240b638f8 (LogicalOperator || -> &&), d2a8f1b143762ede
		// (ConditionalExpression typeof-check disabled).
		expect(isGitPushCommand(pushCharArray)).toBe(false);
	});

	it("parseGitCommit(null) returns null cleanly rather than throwing past a disabled guard", () => {
		expect(parseGitCommit(null)).toBeNull();
	});
});

describe("isGitPushCommand — remaining branch-level survivors", () => {
	it("a whitespace-only command has fewer than 2 tokens and is rejected up front", () => {
		// Kills: 6df2914175ed48d6 (ConditionalExpression tokens.length<2 forced
		// false): would let a token-starved segment fall through to the subIdx
		// check instead of being skipped.
		expect(isGitPushCommand("   ")).toBe(false);
	});

	it("an absolute git-path head that only ENDS in `/git` is recognized (not one that only starts with it)", () => {
		// Kills: 27dbb8f53abd6e20 (MethodExpression endsWith->startsWith): a
		// path like /opt/bin/git ends with "/git" but does not start with it.
		expect(isGitPushCommand("/opt/bin/git push")).toBe(true);
	});
});

describe("parseSegment — the non-git-head disqualifier is load-bearing on its own segment scope", () => {
	it("a non-git head (`npm commit -m x`) is never mistaken for a real commit segment", () => {
		// Kills: 1e72c04a1a7f5c7d (StringLiteral "/git"->"", makes `.endsWith("")`
		// always true so the disqualifier never fires), 0803631dd2d6b9e2
		// (ConditionalExpression, the whole disqualifying condition forced
		// false). Both let "npm" masquerade as a valid commit head.
		expect(parseGitCommit("npm commit -m x")).toBeNull();
	});
});
