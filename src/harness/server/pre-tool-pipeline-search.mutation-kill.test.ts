import { nonNull } from "../../lib/non-null.js";
import { makeServerRuntime, makeServerRules, makeTrigramIndex } from "./__tests__/fixtures.js";
// Mutation-kill companion for src/harness/server/pre-tool-pipeline-search.ts.
//
// HAND-WRITTEN (no generator applies): golden-gen/generate.mts refuses any
// file with function bodies (this one is all functions, no exported
// object-literal tables), and this isn't a Commander CLI file either.
//
// Targets the 47 shadow-verified-killable survivors from the fresh W8
// measurement (55 total; the remaining 8 are equivalence candidates — two
// `"" -> "Stryker was here!"` command/path fallbacks whose value only
// matters where it can never be observed, and two `catch (e) { void e; }`
// bodies whose `void e;` has zero side effects either way — proven via
// scratch/fleet-r3/w8/pps/shadow-verify-equivalence.mts, 300+ fresh-seeded
// fuzz inputs each, zero divergence, plus a negative control proving the
// harness actually detects divergence when it should).
//
// Every assertion below was independently shadow-verified against a real
// single-mutation build of the pristine source first
// (scratch/fleet-r3/w8/pps/shadow-verify-kills.mts: 47/47 killed, 0
// survived, 0 errored) before being transcribed here — this file is the
// transcription, not the proof.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import type { ServerRuntime } from "./runtime-context.js";

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));
vi.mock("../grep-accelerator.js", () => ({
	checkGrepAcceleration: vi.fn(),
	findRipgrep: vi.fn(),
}));
vi.mock("../regex-trigrams.js", () => ({
	parseGrepCommand: vi.fn(),
}));
vi.mock("../server-tsgo-bash.js", () => ({
	isBashTsc: vi.fn(),
	tryTsgoRewrite: vi.fn(),
}));

import { execSync } from "node:child_process";
import { checkGrepAcceleration, findRipgrep } from "../grep-accelerator.js";
import { parseGrepCommand } from "../regex-trigrams.js";
import { isBashTsc, tryTsgoRewrite } from "../server-tsgo-bash.js";
import {
	classifySearchTool,
	emitIndexStatusWarning,
	runGrepAcceleration,
	runTsgoAcceleration,
	type SearchToolFlags,
} from "./pre-tool-pipeline-search.js";


const EMPTY_RULES = makeServerRules();

const mExecSync = vi.mocked(execSync);
const mCheckGrepAcceleration = vi.mocked(checkGrepAcceleration);
const mFindRipgrep = vi.mocked(findRipgrep);
const mParseGrepCommand = vi.mocked(parseGrepCommand);
const mIsBashTsc = vi.mocked(isBashTsc);
const mTryTsgoRewrite = vi.mocked(tryTsgoRewrite);

// ---- Fixtures ----

function ev(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		timestamp: "2026-08-14T00:00:00.000Z",
		...partial,
	};
}

/** ServerRuntime stub — only the fields these functions read are real. */
function makeCtx(over: NonNullable<Parameters<typeof makeServerRuntime>[0]> = {}): ServerRuntime {
	return makeServerRuntime({
		cwd: "/repo",
		trigramIndex: null,
		indexWarningSent: new Set<string>(),
		fileContentCache: {},
		log: () => {},
		...over,
	});
}

const ALL_TRUE_FLAGS: SearchToolFlags = {
	isSearchTool: true,
	ugrepAwareSearch: true,
	grepSubstitutionEnabled: true,
};

beforeEach(() => {
	vi.clearAllMocks();
});

// =====================================================================
// classifySearchTool
// =====================================================================

describe("classifySearchTool", () => {
	// test-contract: public-api — isSearchTool/ugrepAwareSearch gate both the
	// index-status warning and the (default-off) grep-substitution path; a
	// non-search tool whose UNRELATED command string happens to contain an
	// rg-looking keyword must not be misclassified as a search invocation.
	it("a Write tool with an rg-looking command string is not a search tool", () => {
		const out = classifySearchTool(ev({ tool_name: "Write", tool_input: { command: "rg foo bar" } }), EMPTY_RULES);
		expect(out.isSearchTool).toBe(false);
		expect(out.ugrepAwareSearch).toBe(false);
	});

	// test-contract: public-api — same contract on the ugrep-aware branch:
	// the tool must actually be Bash, not merely carry a ugrep-looking
	// command string in an unrelated tool's input.
	it("a Write tool with a ugrep-looking command string is not ugrep-aware-search", () => {
		const out = classifySearchTool(ev({ tool_name: "Write", tool_input: { command: "ugrep foo" } }), EMPTY_RULES);
		expect(out.isSearchTool).toBe(false);
		expect(out.ugrepAwareSearch).toBe(false);
	});

	// test-contract: boundary — the ugrep/ug/fgrep regex requires a
	// WHITESPACE character right after the keyword (the real invocation
	// shape, e.g. `fgrep pattern`); this pins that boundary against a
	// mutant that widens it to any non-whitespace continuation.
	it("a Bash fgrep command followed by a space is ugrep-aware-search", () => {
		const out = classifySearchTool(ev({ tool_name: "Bash", tool_input: { command: "fgrep pattern" } }), EMPTY_RULES);
		expect(out.isSearchTool).toBe(false);
		expect(out.ugrepAwareSearch).toBe(true);
	});
});

// =====================================================================
// emitIndexStatusWarning (also exercises the private isIndexApplicableSearch
// / isIndexedPath helpers — their only observable is this function's guard)
// =====================================================================

describe("emitIndexStatusWarning", () => {
	// test-contract: invariant — a blocked preDecision must never be treated
	// as an opportunity to emit the index-health warning; the function is a
	// no-op (no session marked, no warnings touched) whenever decision !==
	// "allow", regardless of every other condition being satisfied.
	it("does nothing when preDecision.decision is not 'allow'", () => {
		const ctx = makeCtx({ trigramIndex: makeTrigramIndex("z", false) });
		const preDecision: HarnessDecision = { decision: "block" };
		emitIndexStatusWarning(
			ctx,
			ev({ tool_name: "Grep", session_id: "sA", tool_input: { pattern: "x" } }),
			preDecision,
			ALL_TRUE_FLAGS,
		);
		expect(ctx.indexWarningSent.has("sA")).toBe(false);
		expect(preDecision.warnings).toBeUndefined();
		expect(mFindRipgrep).not.toHaveBeenCalled();
	});

	// test-contract: public-api — a missing ripgrep binary is a supported,
	// actionable state: the agent gets told to install it, and the session
	// is marked so this does not repeat every search call.
	it("warns when the index is loaded but ripgrep is not installed", () => {
		mFindRipgrep.mockReturnValue(null);
		const ctx = makeCtx({ trigramIndex: makeTrigramIndex("z", false) });
		const preDecision: HarnessDecision = { decision: "allow" };
		emitIndexStatusWarning(
			ctx,
			ev({ tool_name: "Grep", session_id: "sB", tool_input: { pattern: "x" } }),
			preDecision,
			ALL_TRUE_FLAGS,
		);
		expect(ctx.indexWarningSent.has("sB")).toBe(true);
		expect(preDecision.warnings).toEqual([
			"[interlinked:index] Index loaded but ripgrep not installed — grep acceleration disabled. Install: brew install ripgrep",
		]);
	});

	// test-contract: public-api — when HEAD matches the index's recorded
	// base commit, the index is current: no "behind HEAD" warning, and the
	// exact git invocation (command text + cwd/encoding/timeout options)
	// must be the one actually run, not a mutated stand-in.
	it("emits no warning when HEAD equals the index's recorded base commit", () => {
		mFindRipgrep.mockReturnValue("/usr/bin/rg");
		mExecSync.mockReturnValueOnce("basecommit000\n");
		const ctx = makeCtx({ trigramIndex: makeTrigramIndex("basecommit000", false) });
		const preDecision: HarnessDecision = { decision: "allow" };
		emitIndexStatusWarning(
			ctx,
			ev({ tool_name: "Grep", session_id: "sC", tool_input: { pattern: "x" } }),
			preDecision,
			ALL_TRUE_FLAGS,
		);
		expect(ctx.indexWarningSent.has("sC")).toBe(true);
		expect(preDecision.warnings).toBeUndefined();
		expect(mExecSync).toHaveBeenCalledTimes(1);
		expect(mExecSync).toHaveBeenNthCalledWith(1, "git rev-parse HEAD", {
			cwd: "/repo",
			encoding: "utf-8",
			timeout: 2000,
		});
	});

	// test-contract: public-api — when HEAD has moved past the index's base
	// commit, the warning names how many commits behind it is (via `git
	// rev-list --count <short-sha>..HEAD`, short-sha = first 8 chars) and
	// the second git invocation's exact command/options must match.
	it("warns with the exact behind-count when HEAD has moved past the base commit", () => {
		mFindRipgrep.mockReturnValue("/usr/bin/rg");
		mExecSync.mockReturnValueOnce("999999999999\n").mockReturnValueOnce("3\n");
		const ctx = makeCtx({ trigramIndex: makeTrigramIndex("abc123def456", false) });
		const preDecision: HarnessDecision = { decision: "allow" };
		emitIndexStatusWarning(
			ctx,
			ev({ tool_name: "Grep", session_id: "sD", tool_input: { pattern: "x" } }),
			preDecision,
			ALL_TRUE_FLAGS,
		);
		expect(ctx.indexWarningSent.has("sD")).toBe(true);
		expect(preDecision.warnings).toEqual([
			"[interlinked:index] Search index is 3 commit(s) behind HEAD. Run `interlinked index build` to refresh.",
		]);
		expect(mExecSync).toHaveBeenNthCalledWith(2, "git rev-list --count abc123de..HEAD", {
			cwd: "/repo",
			encoding: "utf-8",
			timeout: 2000,
		});
	});

	// test-contract: boundary — a Grep call with no `pattern` can never be
	// index-applicable (every AND-chain term must hold); this is the
	// single fixture that forces EVERY term false-at-the-first-conjunct,
	// which is exactly what distinguishes the correct AND chain from any
	// single &&→|| slip or any sub-chain collapsed to `true`.
	it("stays silent for a Grep call with no search pattern", () => {
		mFindRipgrep.mockReturnValue(null);
		const ctx = makeCtx({ trigramIndex: makeTrigramIndex("z", false) });
		const preDecision: HarnessDecision = { decision: "allow" };
		emitIndexStatusWarning(
			ctx,
			ev({ tool_name: "Grep", session_id: "sF", tool_input: {} }),
			preDecision,
			ALL_TRUE_FLAGS,
		);
		expect(ctx.indexWarningSent.has("sF")).toBe(false);
	});

	// test-contract: public-api — a Bash-shaped grep command is applicable
	// only when tool_name is ACTUALLY "Bash"; the flags object alone
	// (isSearchTool/ugrepAwareSearch) is not enough to reach the Bash
	// branch of isIndexApplicableSearch.
	it("stays silent for a non-Bash, non-Grep tool even with a parseable command", () => {
		mFindRipgrep.mockReturnValue(null);
		mParseGrepCommand.mockReturnValue({ pattern: "foo", isRegex: true, caseInsensitive: false });
		const ctx = makeCtx({ trigramIndex: makeTrigramIndex("z", false) });
		const preDecision: HarnessDecision = { decision: "allow" };
		emitIndexStatusWarning(
			ctx,
			ev({ tool_name: "Read", session_id: "sG", tool_input: { command: "rg foo" } }),
			preDecision,
			ALL_TRUE_FLAGS,
		);
		expect(ctx.indexWarningSent.has("sG")).toBe(false);
	});

	// test-contract: boundary — `~` is a literal tilde for isIndexedPath (no
	// shell home-dir expansion happens here), and it is explicitly excluded
	// from the index's project scope; this must stay excluded through both
	// disjuncts of `searchPath === "~" || searchPath.startsWith("~/")`.
	it("stays silent for a search path of exactly '~'", () => {
		mFindRipgrep.mockReturnValue(null);
		const ctx = makeCtx({ trigramIndex: makeTrigramIndex("z", false) });
		const preDecision: HarnessDecision = { decision: "allow" };
		emitIndexStatusWarning(
			ctx,
			ev({ tool_name: "Grep", session_id: "sT", tool_input: { pattern: "x", path: "~" } }),
			preDecision,
			ALL_TRUE_FLAGS,
		);
		expect(ctx.indexWarningSent.has("sT")).toBe(false);
	});

	// test-contract: boundary — `~/foo` must be excluded via startsWith, not
	// endsWith; a path that merely ENDS with "~/" is a different (and
	// nonsensical) shape that this fixture does not exercise.
	it("stays silent for a search path starting with '~/'", () => {
		mFindRipgrep.mockReturnValue(null);
		const ctx = makeCtx({ trigramIndex: makeTrigramIndex("z", false) });
		const preDecision: HarnessDecision = { decision: "allow" };
		emitIndexStatusWarning(
			ctx,
			ev({ tool_name: "Grep", session_id: "sU", tool_input: { pattern: "x", path: "~/foo" } }),
			preDecision,
			ALL_TRUE_FLAGS,
		);
		expect(ctx.indexWarningSent.has("sU")).toBe(false);
	});

	// test-contract: security — a search path of ".." resolves outside the
	// project root the index was built for; it must be rejected as
	// index-applicable rather than silently searched against a stale/wrong
	// tree (the class this whole guard exists to prevent).
	it("stays silent for a search path of '..' (outside the indexed project)", () => {
		mFindRipgrep.mockReturnValue(null);
		const ctx = makeCtx({ trigramIndex: makeTrigramIndex("z", false) });
		const preDecision: HarnessDecision = { decision: "allow" };
		emitIndexStatusWarning(
			ctx,
			ev({ tool_name: "Grep", session_id: "sV", tool_input: { pattern: "x", path: ".." } }),
			preDecision,
			ALL_TRUE_FLAGS,
		);
		expect(ctx.indexWarningSent.has("sV")).toBe(false);
	});
});

// =====================================================================
// runGrepAcceleration (also exercises the private isGrepIndexFresh helper
// via the `indexFresh` value it hands to checkGrepAcceleration)
// =====================================================================

describe("runGrepAcceleration", () => {
	// test-contract: invariant — a blocked preDecision must never be
	// upgraded into a grep-substitution attempt; the guard's `allow` check
	// must gate isGrepIndexFresh/checkGrepAcceleration entirely.
	it("does nothing when preDecision.decision is not 'allow'", () => {
		const ctx = makeCtx({ trigramIndex: makeTrigramIndex("z", false) });
		const preDecision: HarnessDecision = { decision: "block" };
		const out = runGrepAcceleration(
			ctx,
			ev({ tool_name: "Grep", tool_input: { pattern: "x" } }),
			preDecision,
			ALL_TRUE_FLAGS,
		);
		expect(out).toBeNull();
		expect(mCheckGrepAcceleration).not.toHaveBeenCalled();
		expect(mExecSync).not.toHaveBeenCalled();
	});

	// test-contract: public-api — isGrepIndexFresh's "never worse than
	// native" contract: freshness requires HEAD to equal the index's base
	// commit (via the ACTUAL trimmed git output, not a mutated stand-in for
	// either git call) AND a clean working tree (empty `git status
	// --porcelain`, after trim). Both git invocations' exact args are
	// pinned too, since checkGrepAcceleration is only ever as trustworthy
	// as the query it was told to run.
	it("reports the index fresh when HEAD matches and the tree is clean", () => {
		mExecSync.mockReturnValueOnce("freshhead\n").mockReturnValueOnce(" \n");
		mCheckGrepAcceleration.mockReturnValue(null);
		const ctx = makeCtx({ trigramIndex: makeTrigramIndex("freshhead", false) });
		const preDecision: HarnessDecision = { decision: "allow" };
		runGrepAcceleration(ctx, ev({ tool_name: "Grep", tool_input: { pattern: "x" } }), preDecision, ALL_TRUE_FLAGS);

		expect(mCheckGrepAcceleration).toHaveBeenCalledOnce();
		const cfgArg = nonNull(nonNull(mCheckGrepAcceleration.mock.calls[0])[2]);
		expect(cfgArg.indexFresh).toBe(true);
		expect(mExecSync).toHaveBeenNthCalledWith(1, "git rev-parse HEAD", {
			cwd: "/repo",
			encoding: "utf-8",
			timeout: 2000,
		});
		expect(mExecSync).toHaveBeenNthCalledWith(2, "git status --porcelain", {
			cwd: "/repo",
			encoding: "utf-8",
			timeout: 5000,
		});
	});

	// test-contract: public-api — when the guard blocks, `return null`
	// short-circuits before ANY of the substitution machinery runs; this
	// pins that the early guard is a real gate, not a decoration.
	it("never calls checkGrepAcceleration when the guard blocks", () => {
		const ctx = makeCtx({ trigramIndex: makeTrigramIndex("z", false) });
		const preDecision: HarnessDecision = { decision: "block" };
		runGrepAcceleration(ctx, ev({ tool_name: "Grep", tool_input: { pattern: "x" } }), preDecision, ALL_TRUE_FLAGS);
		expect(mCheckGrepAcceleration).not.toHaveBeenCalled();
	});

	// test-contract: public-api — a substitution decision is logged with
	// the ACTUAL tool name and the ACTUAL decision the accelerator made
	// (never a blanked-out template), so operators can trust the log line
	// when debugging why a search was intercepted.
	it("logs the tool name and decision when the accelerator substitutes", () => {
		mExecSync.mockImplementation(() => {
			throw new Error("git unavailable");
		});
		mCheckGrepAcceleration.mockReturnValue({ decision: "block", reason: "blocked by index" });
		const logs: string[] = [];
		const ctx = makeCtx({
			trigramIndex: makeTrigramIndex("z", false),
			log: (m: string) => logs.push(m),
		});
		const preDecision: HarnessDecision = { decision: "allow" };
		runGrepAcceleration(ctx, ev({ tool_name: "Grep", tool_input: { pattern: "x" } }), preDecision, ALL_TRUE_FLAGS);
		expect(logs).toContain("Grep accelerated: Grep → block");
	});

	// test-contract: public-api — the merge-guard `preDecision.warnings
	// ?.length` must stay a real conditional: when the incoming
	// preDecision carries no warnings, the returned grepDecision's own
	// warnings field must be left exactly as checkGrepAcceleration
	// produced it (here: absent), not silently replaced with `[]`.
	it("leaves grepDecision.warnings untouched when preDecision has no warnings to merge", () => {
		mExecSync.mockImplementation(() => {
			throw new Error("git unavailable");
		});
		mCheckGrepAcceleration.mockReturnValue({ decision: "block", reason: "x" });
		const ctx = makeCtx({ trigramIndex: makeTrigramIndex("z", false) });
		const preDecision: HarnessDecision = { decision: "allow" };
		const out = runGrepAcceleration(
			ctx,
			ev({ tool_name: "Grep", tool_input: { pattern: "x" } }),
			preDecision,
			ALL_TRUE_FLAGS,
		);
		expect(out?.warnings).toBeUndefined();
	});
});

// =====================================================================
// runTsgoAcceleration
// =====================================================================

describe("runTsgoAcceleration", () => {
	// test-contract: public-api — when tsgo is unavailable, the agent is
	// told exactly that (install hint included) and the ORIGINAL warnings
	// array is preserved and appended to, never silently replaced by a
	// fallback placeholder array.
	it("appends the tsgo-unavailable warning without discarding a pre-existing warnings array", () => {
		mIsBashTsc.mockReturnValue(true);
		mTryTsgoRewrite.mockReturnValue(null);
		const ctx = makeCtx();
		const preDecision: HarnessDecision = { decision: "allow" };
		const out = runTsgoAcceleration(ctx, ev({ tool_name: "Bash", tool_input: { command: "tsc --noEmit" } }), preDecision);
		expect(out).toBeNull();
		expect(preDecision.warnings).toEqual([
			"[interlinked:tsc] Using tsc (tsgo not available — install @typescript/native-preview for ~10x faster type checking)",
		]);
	});
});
